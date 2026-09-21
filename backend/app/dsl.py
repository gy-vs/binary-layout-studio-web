"""布局 DSL：词法 + 递归下降语法分析，产出未校验的 AST。

语法概览：

    endian be;

    struct Header {
        magic: u16;                 // 默认端序
        ver:   u8;
        flags: bits be { mode: 2; enc: 1; rsv: 5; };
    }

    struct Packet {
        hdr: Header;                // 嵌套结构
        length: u8;
        kind: u8;
        payload: choice (kind) {    // 联合分支
            case 0: { text: bytes[length]; }
            case 1: { n: u8; samples: [u16le; n]; }
            default: { raw: bytes[2]; }
        };
        align(4);                   // 填充到 4 字节倍数
        skip(1);                    // 跳过 1 字节
        crc: checksum(u16, crc16, $start);
        note: u8 if length > 0;     // 条件字段
        let total = length + 1;     // 派生值（不占位）
    }
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import expr as E


class DSLSyntaxError(Exception):
    pass


# ---------------------------------------------------------------- AST

@dataclass
class IntSpecA:
    bits: int
    signed: bool
    endian: Optional[str]  # None = 继承布局默认


@dataclass
class BitItemA:
    name: str
    bits: int
    cond: Any = None


@dataclass
class FIntA:
    name: str
    spec: IntSpecA
    cond: Any = None


@dataclass
class FBitsA:
    name: str
    endian: Optional[str]
    items: list[BitItemA]
    cond: Any = None


@dataclass
class FArrayA:
    name: str
    elem: Any  # IntSpecA | str(结构名)
    count: Any
    cond: Any = None


@dataclass
class FBytesA:
    name: str
    count: Any
    cond: Any = None


@dataclass
class FStructA:
    name: str
    struct: str
    cond: Any = None


@dataclass
class FChoiceA:
    name: str
    tag: Any
    cases: list  # list[(int|None, list[字段])]，None 表示 default
    cond: Any = None


@dataclass
class FAlignA:
    multiple: Any


@dataclass
class FSkipA:
    count: Any


@dataclass
class FChecksumA:
    name: str
    spec: IntSpecA
    algo: str
    src: Optional[str]  # None 表示 $start
    cond: Any = None


@dataclass
class FLetA:
    name: str
    expr: Any


@dataclass
class StructDefA:
    name: str
    fields: list = field(default_factory=list)


@dataclass
class LayoutA:
    structs: list = field(default_factory=list)
    default_endian: str = "be"


# ---------------------------------------------------------------- 词法

_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM_RE = re.compile(r"0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+")
_OPS = ("<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
        "{", "}", "(", ")", "[", "]", ":", ";", ",", ".", "?",
        "+", "-", "*", "/", "%", "<", ">", "=", "!", "~", "&", "|", "^")


@dataclass
class Tok:
    kind: str  # 'IDENT' | 'NUM' | 'OP' | 'EOF'
    text: str
    line: int
    col: int


def tokenize(src: str) -> list[Tok]:
    toks: list[Tok] = []
    i, line, col = 0, 1, 1
    n = len(src)
    while i < n:
        ch = src[i]
        if ch in " \t\r":
            i += 1
            col += 1
            continue
        if ch == "\n":
            i += 1
            line += 1
            col = 1
            continue
        if ch == "#" or src.startswith("//", i):
            j = src.find("\n", i)
            if j == -1:
                break
            i = j
            continue
        m = _IDENT_RE.match(src, i)
        if m:
            toks.append(Tok("IDENT", m.group(0), line, col))
            col += m.end() - i
            i = m.end()
            continue
        m = _NUM_RE.match(src, i)
        if m:
            toks.append(Tok("NUM", m.group(0), line, col))
            col += m.end() - i
            i = m.end()
            continue
        for op in _OPS:
            if src.startswith(op, i):
                toks.append(Tok("OP", op, line, col))
                i += len(op)
                col += len(op)
                break
        else:
            raise DSLSyntaxError(f"{line}:{col}: 无法识别的字符 {ch!r}")
    toks.append(Tok("EOF", "", line, col))
    return toks


def _num_value(text: str) -> int:
    if text.lower().startswith("0x"):
        return int(text, 16)
    if text.lower().startswith("0b"):
        return int(text, 2)
    return int(text, 10)


# ---------------------------------------------------------------- 语法

_INTTYPE_RE = re.compile(r"^([ui])([0-9]+)(le|be)?$")


class Parser:
    def __init__(self, toks: list[Tok]):
        self.toks = toks
        self.i = 0

    # ---- 基础 ----
    def peek(self, ahead: int = 0) -> Tok:
        return self.toks[min(self.i + ahead, len(self.toks) - 1)]

    def next(self) -> Tok:
        t = self.toks[self.i]
        if t.kind != "EOF":
            self.i += 1
        return t

    def err(self, msg: str, tok: Optional[Tok] = None) -> DSLSyntaxError:
        t = tok or self.peek()
        return DSLSyntaxError(f"{t.line}:{t.col}: {msg}（临近 {t.text!r}）")

    def expect_op(self, op: str) -> Tok:
        t = self.peek()
        if t.kind == "OP" and t.text == op:
            return self.next()
        raise self.err(f"期望 '{op}'")

    def accept_op(self, op: str) -> bool:
        t = self.peek()
        if t.kind == "OP" and t.text == op:
            self.next()
            return True
        return False

    def expect_ident(self, what: str = "标识符") -> str:
        t = self.peek()
        if t.kind == "IDENT":
            self.next()
            return t.text
        raise self.err(f"期望{what}")

    def expect_num(self) -> int:
        t = self.peek()
        if t.kind == "NUM":
            self.next()
            return _num_value(t.text)
        raise self.err("期望整数")

    def accept_kw(self, kw: str) -> bool:
        t = self.peek()
        if t.kind == "IDENT" and t.text == kw:
            self.next()
            return True
        return False

    def expect_kw(self, kw: str) -> None:
        if not self.accept_kw(kw):
            raise self.err(f"期望关键字 '{kw}'")

    # ---- 顶层 ----
    def parse_layout(self) -> LayoutA:
        lay = LayoutA()
        while self.peek().kind != "EOF":
            if self.accept_kw("endian"):
                t = self.peek()
                if t.kind == "IDENT" and t.text in ("le", "be"):
                    lay.default_endian = self.next().text
                else:
                    raise self.err("endian 后应为 le 或 be")
                self.expect_op(";")
            elif self.accept_kw("struct"):
                lay.structs.append(self.parse_struct())
            else:
                raise self.err("期望 'struct' 或 'endian'")
        return lay

    def parse_struct(self) -> StructDefA:
        name = self.expect_ident("结构名")
        self.expect_op("{")
        sd = StructDefA(name=name)
        while not self.accept_op("}"):
            if self.peek().kind == "EOF":
                raise self.err("结构体未闭合")
            sd.fields.append(self.parse_member())
        return sd

    def parse_member(self):
        if self.accept_kw("let"):
            name = self.expect_ident("变量名")
            self.expect_op("=")
            e = self.parse_expr()
            self.expect_op(";")
            return FLetA(name=name, expr=e)
        if self.accept_kw("align"):
            self.expect_op("(")
            e = self.parse_expr()
            self.expect_op(")")
            self.expect_op(";")
            return FAlignA(multiple=e)
        if self.accept_kw("skip"):
            self.expect_op("(")
            e = self.parse_expr()
            self.expect_op(")")
            self.expect_op(";")
            return FSkipA(count=e)
        name = self.expect_ident("字段名")
        self.expect_op(":")
        spec = self.parse_spec()
        cond = None
        if self.accept_kw("if"):
            cond = self.parse_expr()
        self.expect_op(";")
        spec.name = name
        spec.cond = cond
        return spec

    def parse_spec(self):
        t = self.peek()
        if t.kind == "IDENT":
            if t.text == "bits":
                return self.parse_bits()
            if t.text == "choice":
                return self.parse_choice()
            if t.text == "bytes":
                self.next()
                self.expect_op("[")
                e = self.parse_expr()
                self.expect_op("]")
                return FBytesA(name="", count=e)
            if t.text == "checksum":
                return self.parse_checksum()
            m = _INTTYPE_RE.match(t.text)
            if m:
                self.next()
                spec = IntSpecA(bits=int(m.group(2)),
                                signed=m.group(1) == "i",
                                endian=m.group(3))
                return FIntA(name="", spec=spec)
            # 嵌套结构引用
            self.next()
            return FStructA(name="", struct=t.text)
        if t.kind == "OP" and t.text == "[":
            self.next()
            et = self.peek()
            if et.kind != "IDENT":
                raise self.err("数组元素应为整数类型或结构名")
            m = _INTTYPE_RE.match(et.text)
            if m:
                self.next()
                elem: Any = IntSpecA(bits=int(m.group(2)),
                                     signed=m.group(1) == "i",
                                     endian=m.group(3))
            else:
                self.next()
                elem = et.text
            self.expect_op(";")
            count = self.parse_expr()
            self.expect_op("]")
            return FArrayA(name="", elem=elem, count=count)
        raise self.err("期望类型（整数/结构/bits/choice/bytes/checksum/数组）")

    def parse_bits(self) -> FBitsA:
        self.expect_kw("bits")
        endian = None
        t = self.peek()
        if t.kind == "IDENT" and t.text in ("le", "be"):
            endian = self.next().text
        self.expect_op("{")
        items: list[BitItemA] = []
        while not self.accept_op("}"):
            if self.peek().kind == "EOF":
                raise self.err("bits 块未闭合")
            nm = self.expect_ident("位域名")
            self.expect_op(":")
            w = self.expect_num()
            cond = None
            if self.accept_kw("if"):
                cond = self.parse_expr()
            self.expect_op(";")
            items.append(BitItemA(name=nm, bits=w, cond=cond))
        return FBitsA(name="", endian=endian, items=items)

    def parse_choice(self) -> FChoiceA:
        self.expect_kw("choice")
        self.expect_op("(")
        tag = self.parse_expr()
        self.expect_op(")")
        self.expect_op("{")
        cases: list = []
        seen_default = False
        while not self.accept_op("}"):
            if self.peek().kind == "EOF":
                raise self.err("choice 块未闭合")
            if self.accept_kw("case"):
                v = self.expect_num()
                self.expect_op(":")
                body = self.parse_case_body()
                cases.append((v, body))
            elif self.accept_kw("default"):
                if seen_default:
                    raise self.err("重复的 default 分支")
                seen_default = True
                self.expect_op(":")
                cases.append((None, self.parse_case_body()))
            else:
                raise self.err("期望 'case' 或 'default'")
        return FChoiceA(name="", tag=tag, cases=cases)

    def parse_case_body(self) -> list:
        self.expect_op("{")
        body: list = []
        while not self.accept_op("}"):
            if self.peek().kind == "EOF":
                raise self.err("case 体未闭合")
            body.append(self.parse_member())
        return body

    def parse_checksum(self) -> FChecksumA:
        self.expect_kw("checksum")
        self.expect_op("(")
        t = self.peek()
        m = _INTTYPE_RE.match(t.text) if t.kind == "IDENT" else None
        if not m:
            raise self.err("checksum 第一个参数应为整数类型，如 u16")
        self.next()
        spec = IntSpecA(bits=int(m.group(2)), signed=m.group(1) == "i",
                        endian=m.group(3))
        self.expect_op(",")
        algo = self.expect_ident("校验算法名")
        src = None
        if self.accept_op(","):
            src = self.expect_ident("校验起点（字段名或 $start）")
            if src == "$start":
                src = None
        self.expect_op(")")
        return FChecksumA(name="", spec=spec, algo=algo, src=src)

    # ---- 表达式（优先级递增） ----
    _BIN_LEVELS = [
        ("||",),
        ("&&",),
        ("|",),
        ("^",),
        ("&",),
        ("==", "!="),
        ("<", "<=", ">", ">="),
        ("<<", ">>"),
        ("+", "-"),
        ("*", "/", "%"),
    ]

    def parse_expr(self, level: int = 0):
        if level >= len(self._BIN_LEVELS):
            return self.parse_unary()
        left = self.parse_expr(level + 1)
        while True:
            t = self.peek()
            if t.kind == "OP" and t.text in self._BIN_LEVELS[level]:
                self.next()
                right = self.parse_expr(level + 1)
                left = E.Bin(t.text, left, right)
            else:
                break
        if level == 0 and self.accept_op("?"):
            t = self.parse_expr()
            self.expect_op(":")
            f = self.parse_expr()
            left = E.Cond(left, t, f)
        return left

    def parse_unary(self):
        t = self.peek()
        if t.kind == "OP" and t.text in ("-", "!", "~"):
            self.next()
            return E.Un(t.text, self.parse_unary())
        return self.parse_primary()

    def parse_primary(self):
        t = self.peek()
        if t.kind == "NUM":
            self.next()
            return E.Lit(_num_value(t.text))
        if t.kind == "OP" and t.text == "(":
            self.next()
            e = self.parse_expr()
            self.expect_op(")")
            return e
        if t.kind == "IDENT":
            if t.text == "true":
                self.next()
                return E.Lit(1)
            if t.text == "false":
                self.next()
                return E.Lit(0)
            if t.text == "len":
                self.next()
                self.expect_op("(")
                nm = self.expect_ident("len 的参数")
                self.expect_op(")")
                return E.Len(nm)
            self.next()
            path = [t.text]
            while self.accept_op("."):
                path.append(self.expect_ident("成员名"))
            return E.Ref(tuple(path))
        raise self.err("期望表达式")


def parse_layout(src: str) -> LayoutA:
    return Parser(tokenize(src)).parse_layout()
