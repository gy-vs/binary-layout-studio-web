"""解析/编码引擎：两者共享 compiler 产出的同一份 Plan。

解析失败时抛出携带"最深成功路径"的 ParseAbort，顶层据此返回部分树；
编码从值树重新计算全部偏移、依赖长度（回写计数字段）与校验，绝不复用旧偏移。
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from .checksums import checksum
from .compiler import (MAX_ARRAY, PAlign, PArray, PBits, PBytes, PChecksum,
                       PChoice, PInt, PLet, PSkip, PStruct, Plan)
from .expr import ExprError, evaluate, is_bare_ref


# ---------------------------------------------------------------- 异常

class ParseAbort(Exception):
    def __init__(self, message: str, bit_offset: int,
                 node=None, values=None):
        super().__init__(message)
        self.message = message
        self.bit_offset = bit_offset
        self.path: list[str] = []
        self.node = node      # 当前已展开的最深部分树（随回退逐层替换为上层节点）
        self.values = values


class EncodeError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
        self.path: list[str] = []


# ---------------------------------------------------------------- 位流

class BitReader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0  # 位偏移

    @property
    def total_bits(self) -> int:
        return len(self.data) * 8

    @property
    def remaining(self) -> int:
        return self.total_bits - self.pos

    def read(self, n: int) -> int:
        """按 MSB 优先读 n 位。"""
        if n > self.remaining:
            raise ParseAbort(
                f"输入截断: 需要 {n} 位，仅剩 {self.remaining} 位", self.pos)
        v = 0
        for _ in range(n):
            byte = self.data[self.pos >> 3]
            bit = (byte >> (7 - (self.pos & 7))) & 1
            v = (v << 1) | bit
            self.pos += 1
        return v

    def read_value(self, bits: int, endian: str) -> int:
        """be：整体 MSB 优先；le：按 8 位分块、低块在前（跨字节位域同样适用）。"""
        if endian == "be":
            return self.read(bits)
        v = 0
        shift = 0
        left = bits
        while left > 0:
            chunk = min(8, left)
            v |= self.read(chunk) << shift
            shift += chunk
            left -= chunk
        return v

    def skip(self, n: int) -> None:
        if n > self.remaining:
            raise ParseAbort(
                f"输入截断: 需要跳过 {n} 位，仅剩 {self.remaining} 位", self.pos)
        self.pos += n


class BitWriter:
    def __init__(self):
        self.buf = bytearray()
        self.pos = 0

    def tell(self) -> int:
        return self.pos

    def seek(self, pos: int) -> None:
        self.pos = pos

    def write(self, value: int, n: int) -> None:
        for i in range(n - 1, -1, -1):
            bit = (value >> i) & 1
            byte_idx = self.pos >> 3
            bit_idx = 7 - (self.pos & 7)
            if byte_idx == len(self.buf):
                self.buf.append(0)
            if bit:
                self.buf[byte_idx] |= (1 << bit_idx)
            else:
                self.buf[byte_idx] &= ~(1 << bit_idx) & 0xFF
            self.pos += 1

    def write_value(self, value: int, bits: int, endian: str) -> None:
        if endian == "be":
            self.write(value, bits)
            return
        left = bits
        shift = 0
        while left > 0:
            chunk = min(8, left)
            self.write((value >> shift) & ((1 << chunk) - 1), chunk)
            shift += chunk
            left -= chunk

    def patch_value(self, pos: int, value: int, bits: int, endian: str) -> None:
        """回写已编码区域（用于依赖长度的重算）。"""
        saved = self.pos
        self.seek(pos)
        self.write_value(value, bits, endian)
        self.seek(saved)


# ---------------------------------------------------------------- 作用域

class Scope(Mapping):
    """字段名作用域，choice 分支体通过 parent 链看到外层先前字段。"""

    def __init__(self, parent: Optional["Scope"] = None):
        self.vars: dict[str, Any] = {}
        self.parent = parent

    def __getitem__(self, k: str) -> Any:
        if k in self.vars:
            return self.vars[k]
        if self.parent is not None:
            return self.parent[k]
        raise KeyError(k)

    def __contains__(self, k: object) -> bool:
        return k in self.vars or (self.parent is not None and k in self.parent)

    def __iter__(self):
        seen = set(self.vars)
        yield from self.vars
        if self.parent is not None:
            for k in self.parent:
                if k not in seen:
                    yield k

    def __len__(self) -> int:
        return sum(1 for _ in self)

    def set(self, k: str, v: Any) -> None:
        self.vars[k] = v


# ---------------------------------------------------------------- 解析

def parse(plan: Plan, data: bytes) -> dict:
    r = BitReader(data)
    issues: list[dict] = []
    try:
        node, values = _parse_struct(plan, plan.root, r, Scope(), issues, [])
        error = None
        ok = True
    except ParseAbort as e:
        node, values = e.node, e.values
        error = {"message": e.message, "bit_offset": e.bit_offset, "path": e.path}
        ok = False
    _finalize(node, len(data))
    return {"ok": ok, "error": error, "issues": issues,
            "tree": node, "values": values, "length": len(data)}


def _parse_struct(plan: Plan, sname: str, r: BitReader, env: Scope,
                  issues: list, path: list):
    sp = plan.structs[sname]
    start = r.pos
    node = {"name": sname, "kind": "struct", "bit_start": start, "children": []}
    values: dict[str, Any] = {}
    offsets: dict[str, int] = {}
    try:
        _parse_fields(plan, sp.fields, r, env, values, node, offsets,
                      issues, path, start)
    except ParseAbort as e:
        node["bit_end"] = r.pos
        e.node = node
        e.values = values
        raise
    node["bit_end"] = r.pos
    return node, values


def _parse_fields(plan, fields, r, env, values, node, offsets,
                  issues, path, struct_start):
    for f in fields:
        name = getattr(f, "name", None)
        if name is not None:
            offsets[name] = r.pos
        try:
            _parse_field(plan, f, r, env, values, node, offsets,
                         issues, path, struct_start)
        except ParseAbort as e:
            if name is not None:
                e.path.insert(0, name)
            raise
        except ExprError as e:
            pa = ParseAbort(f"表达式错误: {e}", r.pos)
            if name is not None:
                pa.path.insert(0, name)
            raise pa from None


def _eval(e, env, r):
    return evaluate(e, env)


def _read_or_abort(fnode: dict, r: BitReader, bits: int, endian: str) -> int:
    """读取失败时把错误标记到当前节点上（前端据此高亮最深失败点）。"""
    try:
        return r.read_value(bits, endian)
    except ParseAbort as e:
        fnode["bit_end"] = r.pos
        fnode["error"] = e.message
        raise


def _skip_or_abort(fnode: dict, r: BitReader, bits: int) -> None:
    try:
        r.skip(bits)
    except ParseAbort as e:
        fnode["bit_end"] = r.pos
        fnode["error"] = e.message
        raise


def _parse_field(plan, f, r, env, values, node, offsets,
                 issues, path, struct_start):
    children = node["children"]

    if isinstance(f, PLet):
        v = _eval(f.expr, env, r)
        env.set(f.name, v)
        children.append({"name": f.name, "kind": "let",
                         "bit_start": r.pos, "bit_end": r.pos, "value": v})
        return

    if isinstance(f, PAlign):
        k = _eval(f.multiple, env, r)
        if k < 1:
            raise ParseAbort(f"align 参数必须 >= 1，得到 {k}", r.pos)
        target = -(-r.pos // (k * 8)) * (k * 8)
        pad = target - r.pos
        pnode = {"name": f"align({k})", "kind": "pad",
                 "bit_start": r.pos, "bit_end": target,
                 "info": f"{pad} 位填充"}
        children.append(pnode)
        _skip_or_abort(pnode, r, pad)
        return

    if isinstance(f, PSkip):
        n = _eval(f.count, env, r)
        if n < 0:
            raise ParseAbort(f"skip 参数必须 >= 0，得到 {n}", r.pos)
        pnode = {"name": f"skip({n})", "kind": "pad",
                 "bit_start": r.pos, "bit_end": r.pos + n * 8,
                 "info": f"跳过 {n} 字节"}
        children.append(pnode)
        _skip_or_abort(pnode, r, n * 8)
        return

    # 以下均为命名字段，先检查条件
    if f.cond is not None and not _eval(f.cond, env, r):
        return

    if isinstance(f, PInt):
        fnode = {"name": f.name, "kind": "int", "bit_start": r.pos}
        children.append(fnode)
        raw = _read_or_abort(fnode, r, f.bits, f.endian)
        v = raw - (1 << f.bits) if (f.signed and raw >> (f.bits - 1)) else raw
        fnode["bit_end"] = r.pos
        fnode["value"] = v
        env.set(f.name, v)
        values[f.name] = v
        return

    if isinstance(f, PBits):
        fnode = {"name": f.name, "kind": "bits", "bit_start": r.pos,
                 "children": []}
        children.append(fnode)
        active = [it for it in f.items
                  if it.cond is None or _eval(it.cond, env, r)]
        total = sum(it.bits for it in active)
        raw = _read_or_abort(fnode, r, total, f.endian)
        grp: dict[str, int] = {}
        if f.endian == "be":
            rest = total
            for it in active:
                rest -= it.bits
                v = (raw >> rest) & ((1 << it.bits) - 1)
                grp[it.name] = v
                fnode["children"].append(
                    {"name": it.name, "kind": "bit",
                     "bit_start": r.pos - total + (total - rest - it.bits),
                     "bit_end": r.pos - total + (total - rest), "value": v})
        else:
            shift = 0
            for it in active:
                v = (raw >> shift) & ((1 << it.bits) - 1)
                grp[it.name] = v
                fnode["children"].append(
                    {"name": it.name, "kind": "bit",
                     "bit_start": r.pos - total + shift,
                     "bit_end": r.pos - total + shift + it.bits, "value": v})
                shift += it.bits
        fnode["bit_end"] = r.pos
        env.set(f.name, grp)
        values[f.name] = grp
        return

    if isinstance(f, PArray):
        n = _checked_count(_eval(f.count, env, r), f.name, r)
        fnode = {"name": f.name, "kind": "array", "bit_start": r.pos,
                 "children": [], "count": n,
                 "template": _elem_template(plan, f)}
        children.append(fnode)
        lst: list[Any] = []
        try:
            for i in range(n):
                if f.elem_struct:
                    try:
                        enode, ev = _parse_struct(plan, f.elem_struct, r,
                                                  Scope(), issues,
                                                  path + [f.name, f"[{i}]"])
                    except ParseAbort as e:
                        if e.node is not None:
                            e.node["name"] = f"[{i}]"
                            fnode["children"].append(e.node)
                        raise
                    enode["name"] = f"[{i}]"
                    fnode["children"].append(enode)
                    lst.append(ev)
                else:
                    enode = {"name": f"[{i}]", "kind": "int",
                             "bit_start": r.pos}
                    fnode["children"].append(enode)
                    raw = _read_or_abort(enode, r, f.elem_bits, f.elem_endian)
                    v = (raw - (1 << f.elem_bits)
                         if (f.elem_signed and raw >> (f.elem_bits - 1))
                         else raw)
                    enode["bit_end"] = r.pos
                    enode["value"] = v
                    lst.append(v)
        except ParseAbort as e:
            e.path.insert(0, f"[{i}]")
            fnode["bit_end"] = r.pos
            values[f.name] = lst   # 保留已完成元素的值
            raise
        fnode["bit_end"] = r.pos
        env.set(f.name, lst)
        values[f.name] = lst
        return

    if isinstance(f, PBytes):
        n = _checked_count(_eval(f.count, env, r), f.name, r)
        fnode = {"name": f.name, "kind": "bytes", "bit_start": r.pos}
        children.append(fnode)
        if n * 8 > r.remaining:
            fnode["bit_end"] = r.pos
            fnode["error"] = (f"输入截断: bytes[{n}] 需要 {n * 8} 位，"
                              f"仅剩 {r.remaining} 位")
            raise ParseAbort(fnode["error"], r.pos)
        b = bytes(r.read(8) for _ in range(n)) if n else b""
        fnode["bit_end"] = r.pos
        fnode["value"] = b.hex()
        env.set(f.name, b)
        values[f.name] = b.hex()
        return

    if isinstance(f, PStruct):
        try:
            cnode, cv = _parse_struct(plan, f.struct, r, Scope(), issues,
                                      path + [f.name])
        except ParseAbort as e:
            if e.node is not None:
                e.node["name"] = f.name
                children.append(e.node)
            if e.values is not None:
                values[f.name] = e.values   # 保留已解析的部分值
            raise
        cnode["name"] = f.name
        children.append(cnode)
        env.set(f.name, cv)
        values[f.name] = cv
        return

    if isinstance(f, PChoice):
        tag = _eval(f.tag, env, r)
        body = None
        branch: Any = None
        for key, b in f.cases:
            if key == tag:
                body, branch = b, key
                break
        if body is None:
            for key, b in f.cases:
                if key is None:
                    body, branch = b, "default"
                    break
        fnode = {"name": f.name, "kind": "choice", "bit_start": r.pos,
                 "children": [], "tag": tag,
                 "case": branch,
                 "options": [k if k is not None else "default"
                             for k, _ in f.cases],
                 "templates": {str(k if k is not None else "default"):
                               _body_template(plan, b)
                               for k, b in f.cases}}
        children.append(fnode)
        if body is None:
            fnode["bit_end"] = r.pos
            fnode["error"] = f"tag={tag} 无匹配分支且无 default"
            raise ParseAbort(fnode["error"], r.pos)
        inner = Scope(parent=env)
        bvalues: dict[str, Any] = {}
        boffsets: dict[str, int] = dict(offsets)  # 分支体内可引用外层字段
        try:
            _parse_fields(plan, body, r, inner, bvalues, fnode, boffsets,
                          issues, path + [f.name], struct_start)
        except ParseAbort as e:
            fnode["bit_end"] = r.pos
            values[f.name] = {"_case": tag, "_branch": branch, **bvalues}
            raise
        fnode["bit_end"] = r.pos
        cv = {"_case": tag, "_branch": branch, **bvalues}
        env.set(f.name, cv)
        values[f.name] = cv
        return

    if isinstance(f, PChecksum):
        src_off = struct_start if f.src is None else offsets[f.src]
        if src_off % 8 or r.pos % 8:
            raise ParseAbort("校验区间未按字节对齐", r.pos)
        region = r.data[src_off // 8: r.pos // 8]
        computed = checksum(f.algo, region)
        fnode = {"name": f.name, "kind": "checksum", "bit_start": r.pos}
        children.append(fnode)
        stored = _read_or_abort(fnode, r, f.bits, f.endian)
        fnode["bit_end"] = r.pos
        ok = stored == computed
        fnode["value"] = stored
        fnode["checksum"] = {"algo": f.algo, "computed": computed,
                             "stored": stored, "ok": ok}
        if not ok:
            issues.append({"path": path + [f.name],
                           "message": f"校验失败({f.algo}): 存储值 {stored}，"
                                      f"计算值 {computed}"})
        env.set(f.name, stored)
        values[f.name] = stored
        return

    raise ParseAbort(f"内部错误: 未知计划节点 {type(f).__name__}", r.pos)


def _checked_count(n: int, name: str, r: BitReader) -> int:
    if n < 0:
        raise ParseAbort(f"字段 '{name}' 的长度为负: {n}", r.pos)
    if n > MAX_ARRAY:
        raise ParseAbort(f"字段 '{name}' 的长度 {n} 超过上限 {MAX_ARRAY}", r.pos)
    return n


def _finalize(node: Optional[dict], data_len: int) -> None:
    """补齐字节范围并钳制到输入长度内。"""
    if node is None:
        return
    total = data_len * 8
    bs = max(0, min(node.get("bit_start", 0), total))
    be = max(bs, min(node.get("bit_end", bs), total))
    node["bit_start"], node["bit_end"] = bs, be
    node["byte_start"] = bs // 8
    node["byte_end"] = (be + 7) // 8
    for c in node.get("children", []):
        _finalize(c, data_len)


# ---------------------------------------------------------------- 编码

def encode(plan: Plan, values: dict,
           fix_checksums: bool = True, fix_lengths: bool = True) -> dict:
    if not isinstance(values, dict):
        return {"ok": False,
                "error": {"message": "values 必须是对象", "path": []}}
    w = BitWriter()
    try:
        _encode_struct(plan, plan.root, values, w, Scope(),
                       fix_checksums, fix_lengths, [])
    except EncodeError as e:
        return {"ok": False,
                "error": {"message": e.message, "path": e.path}}
    except ExprError as e:
        return {"ok": False,
                "error": {"message": f"表达式错误: {e}", "path": []}}
    data = bytes(w.buf)
    back = parse(plan, data)  # 编码结果回读，得到全新偏移与归一化值
    if not back["ok"]:
        return {"ok": False,
                "error": {"message": "内部错误: 编码结果无法回读: "
                                     + back["error"]["message"],
                          "path": back["error"]["path"]}}
    return {"ok": True, "hex": data.hex(), "tree": back["tree"],
            "values": back["values"], "issues": back["issues"],
            "length": len(data)}


def _encode_struct(plan: Plan, sname: str, vals: dict, w: BitWriter,
                   env: Scope, fix_checksums: bool, fix_lengths: bool,
                   path: list) -> None:
    if not isinstance(vals, dict):
        raise EncodeError(f"结构 {sname} 的值必须是对象")
    sp = plan.structs[sname]
    written: dict[str, tuple] = {}   # name -> (bitpos, bits, endian) 可回写
    offsets: dict[str, int] = {}
    struct_start = w.tell()
    _encode_fields(plan, sp.fields, vals, w, env, written, offsets,
                   fix_checksums, fix_lengths, path, struct_start)


def _encode_fields(plan, fields, vals, w, env, written, offsets,
                   fix_checksums, fix_lengths, path, struct_start):
    for f in fields:
        name = getattr(f, "name", None)
        if name is not None:
            offsets[name] = w.tell()
        try:
            _encode_field(plan, f, vals, w, env, written, offsets,
                          fix_checksums, fix_lengths, path, struct_start)
        except EncodeError as e:
            if name is not None:
                e.path.insert(0, name)
            raise


def _get_int(vals: dict, name: str) -> int:
    if name not in vals:
        raise EncodeError(f"缺少字段 '{name}' 的值")
    v = vals[name]
    if not isinstance(v, int) or isinstance(v, bool):
        raise EncodeError(f"字段 '{name}' 的值 {v!r} 不是整数")
    return v


def _check_range(v: int, bits: int, signed: bool, name: str) -> int:
    if signed:
        lo, hi = -(1 << (bits - 1)), (1 << (bits - 1)) - 1
    else:
        lo, hi = 0, (1 << bits) - 1
    if not (lo <= v <= hi):
        raise EncodeError(
            f"整数溢出: 字段 '{name}' 的值 {v} 超出 "
            f"{'i' if signed else 'u'}{bits} 范围 [{lo}, {hi}]")
    return v & ((1 << bits) - 1)


def _encode_field(plan, f, vals, w, env, written, offsets,
                  fix_checksums, fix_lengths, path, struct_start):
    if isinstance(f, PLet):
        env.set(f.name, evaluate(f.expr, env))
        return

    if isinstance(f, PAlign):
        k = evaluate(f.multiple, env)
        if k < 1:
            raise EncodeError(f"align 参数必须 >= 1，得到 {k}")
        target = -(-w.tell() // (k * 8)) * (k * 8)
        w.write(0, target - w.tell())
        return

    if isinstance(f, PSkip):
        n = evaluate(f.count, env)
        if n < 0:
            raise EncodeError(f"skip 参数必须 >= 0，得到 {n}")
        w.write(0, n * 8)
        return

    if f.cond is not None and not evaluate(f.cond, env):
        return  # 条件不满足：跳过，即使提供了值

    if isinstance(f, PInt):
        v = _get_int(vals, f.name)
        raw = _check_range(v, f.bits, f.signed, f.name)
        pos = w.tell()
        w.write_value(raw, f.bits, f.endian)
        env.set(f.name, v)
        written[f.name] = (pos, f.bits, f.endian)
        return

    if isinstance(f, PBits):
        d = vals.get(f.name)
        if not isinstance(d, dict):
            raise EncodeError(f"位域组 '{f.name}' 的值必须是对象")
        active = [it for it in f.items
                  if it.cond is None or evaluate(it.cond, env)]
        raw = 0
        grp = {}
        if f.endian == "be":
            for it in active:
                iv = _get_int(d, it.name)
                _check_range(iv, it.bits, False, f"{f.name}.{it.name}")
                raw = (raw << it.bits) | iv
                grp[it.name] = iv
        else:
            shift = 0
            for it in active:
                iv = _get_int(d, it.name)
                _check_range(iv, it.bits, False, f"{f.name}.{it.name}")
                raw |= iv << shift
                shift += it.bits
                grp[it.name] = iv
        w.write_value(raw, sum(it.bits for it in active), f.endian)
        env.set(f.name, grp)
        return

    if isinstance(f, PArray):
        lst = vals.get(f.name)
        if not isinstance(lst, list):
            raise EncodeError(f"数组 '{f.name}' 的值必须是列表")
        n = _resolve_count(f.count, f.name, len(lst), env, written, w,
                           fix_lengths)
        if n > MAX_ARRAY:
            raise EncodeError(f"数组 '{f.name}' 长度 {n} 超过上限 {MAX_ARRAY}")
        out = []
        for i in range(n):
            try:
                if f.elem_struct:
                    ev = lst[i]
                    if not isinstance(ev, dict):
                        raise EncodeError(f"元素 [{i}] 必须是对象")
                    _encode_struct(plan, f.elem_struct, ev, w, Scope(),
                                   fix_checksums, fix_lengths,
                                   path + [f.name, f"[{i}]"])
                    out.append(ev)
                else:
                    ev = lst[i]
                    if not isinstance(ev, int) or isinstance(ev, bool):
                        raise EncodeError(f"元素 [{i}] 的值 {ev!r} 不是整数")
                    raw = _check_range(ev, f.elem_bits, f.elem_signed,
                                       f"{f.name}[{i}]")
                    w.write_value(raw, f.elem_bits, f.elem_endian)
                    out.append(ev)
            except EncodeError as e:
                e.path.insert(0, f"[{i}]")
                raise
            except IndexError:
                raise EncodeError(f"数组 '{f.name}' 缺少元素 [{i}]") from None
        env.set(f.name, out)
        return

    if isinstance(f, PBytes):
        s = vals.get(f.name)
        if not isinstance(s, str):
            raise EncodeError(f"字节字段 '{f.name}' 的值必须是十六进制字符串")
        try:
            b = bytes.fromhex(s)
        except ValueError:
            raise EncodeError(f"字节字段 '{f.name}' 的十六进制串非法") from None
        _resolve_count(f.count, f.name, len(b), env, written, w, fix_lengths)
        for byte in b:
            w.write_value(byte, 8, "be")
        env.set(f.name, b)
        return

    if isinstance(f, PStruct):
        sub = vals.get(f.name)
        if not isinstance(sub, dict):
            raise EncodeError(f"嵌套结构 '{f.name}' 的值必须是对象")
        _encode_struct(plan, f.struct, sub, w, Scope(),
                       fix_checksums, fix_lengths, path + [f.name])
        env.set(f.name, sub)
        return

    if isinstance(f, PChoice):
        cv = vals.get(f.name)
        if not isinstance(cv, dict):
            raise EncodeError(f"choice '{f.name}' 的值必须是对象")
        tag = cv.get("_case")
        if not isinstance(tag, int) or isinstance(tag, bool):
            raise EncodeError(f"choice '{f.name}' 需要整数 '_case'")
        # 分支标签若由先前字段决定，按需回写
        ref = is_bare_ref(f.tag)
        if ref is not None and ref in env and env[ref] != tag:
            if not fix_lengths:
                raise EncodeError(
                    f"分支标签不符: 字段 '{ref}' 为 {env[ref]}，"
                    f"但选择了分支 {tag}")
            pos, bits, endian = written[ref]
            _check_range(tag, bits, False, ref)
            w.patch_value(pos, tag, bits, endian)
            env.set(ref, tag)
        body = None
        for key, b in f.cases:
            if key == tag:
                body = b
                break
        if body is None:
            for key, b in f.cases:
                if key is None:
                    body = b
                    break
        if body is None:
            raise EncodeError(f"tag={tag} 无匹配分支且无 default")
        inner = Scope(parent=env)
        bwritten: dict[str, tuple] = dict(written)   # 允许回写外层计数字段
        boffsets: dict[str, int] = dict(offsets)
        _encode_fields(plan, body, cv, w, inner, bwritten, boffsets,
                       fix_checksums, fix_lengths, path + [f.name],
                       struct_start)
        env.set(f.name, {"_case": tag, **{k: inner.vars[k]
                                          for k in inner.vars}})
        return

    if isinstance(f, PChecksum):
        src_off = struct_start if f.src is None else offsets[f.src]
        if src_off % 8 or w.tell() % 8:
            raise EncodeError("校验区间未按字节对齐")
        region = bytes(w.buf[src_off // 8: w.tell() // 8])
        computed = checksum(f.algo, region)
        if fix_checksums:
            v = computed
        else:
            v = _get_int(vals, f.name)
        raw = _check_range(v, f.bits, False, f.name)
        w.write_value(raw, f.bits, f.endian)
        env.set(f.name, v)
        return

    raise EncodeError(f"内部错误: 未知计划节点 {type(f).__name__}")


def _resolve_count(count_expr, name: str, actual: int, env,
                   written, w: BitWriter, fix_lengths: bool) -> int:
    """确定数组/字节字段的编码长度；必要时回写先前计数字段。"""
    ref = is_bare_ref(count_expr)
    if ref is not None and ref in written:
        cur = env[ref]
        if cur != actual:
            if not fix_lengths:
                raise EncodeError(
                    f"长度不符: 字段 '{ref}' 为 {cur}，"
                    f"但 '{name}' 有 {actual} 个元素")
            pos, bits, endian = written[ref]
            _check_range(actual, bits, False, ref)
            w.patch_value(pos, actual, bits, endian)
            env.set(ref, actual)
        return actual
    expected = evaluate(count_expr, env)
    if expected != actual:
        raise EncodeError(
            f"长度不符: 字段 '{name}' 的长度表达式求值为 {expected}，"
            f"实际提供 {actual} 个元素")
    return actual


# ---------------------------------------------------------------- 模板（前端编辑用）

def _elem_template(plan: Plan, f: PArray):
    if f.elem_struct:
        return _struct_template(plan, f.elem_struct)
    return 0


def _body_template(plan: Plan, fields) -> dict:
    out: dict[str, Any] = {}
    for f in fields:
        if isinstance(f, (PInt, PChecksum)):
            out[f.name] = 0
        elif isinstance(f, PBits):
            out[f.name] = {it.name: 0 for it in f.items}
        elif isinstance(f, PArray):
            out[f.name] = []
        elif isinstance(f, PBytes):
            out[f.name] = ""
        elif isinstance(f, PStruct):
            out[f.name] = _struct_template(plan, f.struct)
        elif isinstance(f, PChoice):
            key, body = f.cases[0]
            out[f.name] = {"_case": key if key is not None else 0,
                           **_body_template(plan, body)}
    return out


def _struct_template(plan: Plan, sname: str) -> dict:
    return _body_template(plan, plan.structs[sname].fields)
