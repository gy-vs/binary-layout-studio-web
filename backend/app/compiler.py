"""编译器：把 DSL AST 校验并冻结为解析/编码共享的编译计划（Plan）。

编译期检查：
  * 前向/未知引用：表达式只能引用同一结构体内、且声明在前的名字；
  * 递归无界：结构体引用图中任何环都意味着尺寸无界，直接拒绝；
  * 重复名字、未知类型/算法、非法位宽、重复 case 等。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from . import dsl
from .checksums import ALGO_BITS
from .expr import root_refs


class CompileError(Exception):
    pass


# ---------------------------------------------------------------- 计划节点

@dataclass
class PInt:
    name: str
    bits: int
    signed: bool
    endian: str
    cond: Any = None


@dataclass
class PBitItem:
    name: str
    bits: int
    cond: Any = None


@dataclass
class PBits:
    name: str
    endian: str
    items: list
    cond: Any = None


@dataclass
class PArray:
    name: str
    count: Any
    cond: Any = None
    # 元素为整数时：
    elem_bits: int = 0
    elem_signed: bool = False
    elem_endian: str = "be"
    # 元素为结构时：
    elem_struct: Optional[str] = None


@dataclass
class PBytes:
    name: str
    count: Any
    cond: Any = None


@dataclass
class PStruct:
    name: str
    struct: str
    cond: Any = None


@dataclass
class PChoice:
    name: str
    tag: Any
    cases: list  # list[(int|None, list[PField])]
    cond: Any = None


@dataclass
class PAlign:
    multiple: Any


@dataclass
class PSkip:
    count: Any


@dataclass
class PChecksum:
    name: str
    bits: int
    endian: str
    algo: str
    src: Optional[str]
    cond: Any = None


@dataclass
class PLet:
    name: str
    expr: Any


@dataclass
class StructPlan:
    name: str
    fields: list = field(default_factory=list)


@dataclass
class Plan:
    structs: dict
    root: str
    default_endian: str


MAX_INT_BITS = 64
MAX_BITGROUP_BITS = 512
MAX_ARRAY = 1_000_000  # 运行期数组长度上限，防止恶意布局耗尽资源


# ---------------------------------------------------------------- 编译

def compile_layout(src: str) -> Plan:
    try:
        layout = dsl.parse_layout(src)
    except dsl.DSLSyntaxError as e:
        raise CompileError(f"语法错误: {e}") from e
    return compile_ast(layout)


def compile_ast(layout: dsl.LayoutA) -> Plan:
    if not layout.structs:
        raise CompileError("布局中至少需要一个 struct")
    structs: dict[str, StructPlan] = {}
    order: list[str] = []
    for sd in layout.structs:
        if sd.name in structs:
            raise CompileError(f"重复的结构名 '{sd.name}'")
        structs[sd.name] = _compile_struct(sd, layout)
        order.append(sd.name)
    _check_recursion(structs)
    return Plan(structs=structs, root=order[0], default_endian=layout.default_endian)


def _compile_struct(sd: dsl.StructDefA, layout: dsl.LayoutA) -> StructPlan:
    sp = StructPlan(name=sd.name)
    scope: list[str] = []  # 可见名字（按声明顺序）
    for f in sd.fields:
        sp.fields.append(_compile_field(f, layout, scope, sd.name))
    return sp


def _check_expr_refs(e: Any, scope: list[str], where: str) -> None:
    if e is None:
        return
    for name in sorted(root_refs(e)):
        if name not in scope:
            raise CompileError(
                f"{where}: 引用了未声明或声明在后的名字 '{name}'"
                f"（只允许引用本结构体内先前的字段）")


def _resolve_endian(spec_endian: Optional[str], layout: dsl.LayoutA) -> str:
    return spec_endian or layout.default_endian


def _check_int_spec(spec: dsl.IntSpecA, where: str) -> None:
    if spec.bits % 8 != 0 or not (8 <= spec.bits <= MAX_INT_BITS):
        raise CompileError(
            f"{where}: 整数位宽须为 8..{MAX_INT_BITS} 且为 8 的倍数，得到 {spec.bits}")


def _compile_field(f: Any, layout: dsl.LayoutA, scope: list[str],
                   struct_name: str):
    where = f"结构 {struct_name}"

    if isinstance(f, dsl.FLetA):
        _check_expr_refs(f.expr, scope, f"{where} 的 let '{f.name}'")
        _add_name(scope, f.name, where)
        return PLet(name=f.name, expr=f.expr)

    if isinstance(f, dsl.FAlignA):
        _check_expr_refs(f.multiple, scope, f"{where} 的 align")
        return PAlign(multiple=f.multiple)

    if isinstance(f, dsl.FSkipA):
        _check_expr_refs(f.count, scope, f"{where} 的 skip")
        return PSkip(count=f.count)

    where = f"结构 {struct_name} 字段 '{f.name}'"
    _check_expr_refs(getattr(f, "cond", None), scope, where)

    if isinstance(f, dsl.FIntA):
        _check_int_spec(f.spec, where)
        _add_name(scope, f.name, where)
        return PInt(name=f.name, bits=f.spec.bits, signed=f.spec.signed,
                    endian=_resolve_endian(f.spec.endian, layout), cond=f.cond)

    if isinstance(f, dsl.FBitsA):
        seen: set[str] = set()
        total = 0
        items = []
        for it in f.items:
            if it.name in seen:
                raise CompileError(f"{where}: 位域名 '{it.name}' 重复")
            seen.add(it.name)
            if not (1 <= it.bits <= MAX_INT_BITS):
                raise CompileError(f"{where}: 位域 '{it.name}' 宽度 {it.bits} 非法")
            _check_expr_refs(it.cond, scope, f"{where} 位域 '{it.name}'")
            total += it.bits
            items.append(PBitItem(name=it.name, bits=it.bits, cond=it.cond))
        if not items:
            raise CompileError(f"{where}: bits 组不能为空")
        if total > MAX_BITGROUP_BITS:
            raise CompileError(f"{where}: bits 组总宽 {total} 超过 {MAX_BITGROUP_BITS}")
        _add_name(scope, f.name, where)
        return PBits(name=f.name, endian=f.endian or layout.default_endian,
                     items=items, cond=f.cond)

    if isinstance(f, dsl.FArrayA):
        _check_expr_refs(f.count, scope, f"{where} 的长度表达式")
        _add_name(scope, f.name, where)
        if isinstance(f.elem, dsl.IntSpecA):
            _check_int_spec(f.elem, where)
            return PArray(name=f.name, count=f.count, cond=f.cond,
                          elem_bits=f.elem.bits, elem_signed=f.elem.signed,
                          elem_endian=_resolve_endian(f.elem.endian, layout))
        if f.elem not in {s.name for s in layout.structs}:
            raise CompileError(f"{where}: 未知结构 '{f.elem}'")
        return PArray(name=f.name, count=f.count, cond=f.cond,
                      elem_struct=f.elem)

    if isinstance(f, dsl.FBytesA):
        _check_expr_refs(f.count, scope, f"{where} 的长度表达式")
        _add_name(scope, f.name, where)
        return PBytes(name=f.name, count=f.count, cond=f.cond)

    if isinstance(f, dsl.FStructA):
        if f.struct not in {s.name for s in layout.structs}:
            raise CompileError(f"{where}: 未知结构 '{f.struct}'")
        _add_name(scope, f.name, where)
        return PStruct(name=f.name, struct=f.struct, cond=f.cond)

    if isinstance(f, dsl.FChoiceA):
        _check_expr_refs(f.tag, scope, f"{where} 的分支表达式")
        if not f.cases:
            raise CompileError(f"{where}: choice 至少需要一个分支")
        seen_cases: set[int] = set()
        compiled_cases = []
        for key, body in f.cases:
            if key is not None:
                if key in seen_cases:
                    raise CompileError(f"{where}: 重复的 case {key}")
                seen_cases.add(key)
            inner_scope = list(scope)  # 分支体内可见外层先前字段
            compiled_body = [_compile_field(bf, layout, inner_scope, struct_name)
                             for bf in body]
            compiled_cases.append((key, compiled_body))
        _add_name(scope, f.name, where)
        return PChoice(name=f.name, tag=f.tag, cases=compiled_cases, cond=f.cond)

    if isinstance(f, dsl.FChecksumA):
        _check_int_spec(f.spec, where)
        if f.spec.signed:
            raise CompileError(f"{where}: checksum 字段必须是无符号整数")
        if f.algo not in ALGO_BITS:
            raise CompileError(
                f"{where}: 未知校验算法 '{f.algo}'"
                f"（支持 {', '.join(sorted(ALGO_BITS))}）")
        if f.spec.bits < ALGO_BITS[f.algo]:
            raise CompileError(
                f"{where}: 存储位宽 {f.spec.bits} 小于算法 {f.algo} 的"
                f" {ALGO_BITS[f.algo]} 位输出")
        if f.src is not None and f.src not in scope:
            raise CompileError(f"{where}: 校验起点 '{f.src}' 不是先前的字段")
        _add_name(scope, f.name, where)
        return PChecksum(name=f.name, bits=f.spec.bits,
                         endian=_resolve_endian(f.spec.endian, layout),
                         algo=f.algo, src=f.src, cond=f.cond)

    raise CompileError(f"{where}: 内部错误，未知字段类型 {type(f).__name__}")


def _add_name(scope: list[str], name: str, where: str) -> None:
    if name in scope:
        raise CompileError(f"{where}: 名字 '{name}' 重复定义")
    scope.append(name)


def _check_recursion(structs: dict[str, StructPlan]) -> None:
    """结构体引用图中的任何环都意味着无界递归尺寸。"""
    graph: dict[str, set[str]] = {name: set() for name in structs}

    def collect(fields: list, out: set[str]) -> None:
        for f in fields:
            if isinstance(f, PStruct):
                out.add(f.struct)
            elif isinstance(f, PArray) and f.elem_struct:
                out.add(f.elem_struct)
            elif isinstance(f, PChoice):
                for _, body in f.cases:
                    collect(body, out)

    for name, sp in structs.items():
        collect(sp.fields, graph[name])

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {name: WHITE for name in structs}
    stack: list[str] = []

    def dfs(u: str) -> None:
        color[u] = GRAY
        stack.append(u)
        for v in graph[u]:
            if color[v] == GRAY:
                cycle = stack[stack.index(v):] + [v]
                raise CompileError(
                    "递归无界: " + " -> ".join(cycle) +
                    "（结构体不允许直接或间接包含自身）")
            if color[v] == WHITE:
                dfs(v)
        stack.pop()
        color[u] = BLACK

    for name in structs:
        if color[name] == WHITE:
            dfs(name)
