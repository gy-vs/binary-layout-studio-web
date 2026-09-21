"""受限表达式：AST、求值器、引用收集。

表达式只允许整数运算、比较、布尔、三元与 len()，无任何函数调用或外部访问，
因此可以安全地用于用户提供的布局定义。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


class ExprError(Exception):
    """表达式求值期错误（运行期，例如除零、名字缺失）。"""


# ---------------------------------------------------------------- AST

@dataclass(frozen=True)
class Lit:
    value: int


@dataclass(frozen=True)
class Ref:
    """点路径引用，例如 count 或 hdr.version。path[0] 是编译期可检查的名字。"""
    path: tuple[str, ...]


@dataclass(frozen=True)
class Len:
    """len(name)：数组/字节字段的长度。"""
    name: str


@dataclass(frozen=True)
class Un:
    op: str  # '-', '!', '~'
    a: Any


@dataclass(frozen=True)
class Bin:
    op: str
    a: Any
    b: Any


@dataclass(frozen=True)
class Cond:
    c: Any
    t: Any
    f: Any


# ---------------------------------------------------------------- 求值

def _truth(v: int) -> int:
    return 1 if v else 0


def evaluate(node: Any, env: Mapping[str, Any]) -> int:
    if isinstance(node, Lit):
        return node.value
    if isinstance(node, Ref):
        cur: Any = env
        for seg in node.path:
            if isinstance(cur, Mapping) and seg in cur:
                cur = cur[seg]
            else:
                raise ExprError(f"未知名字 '{'.'.join(node.path)}'")
        if not isinstance(cur, int) or isinstance(cur, bool):
            raise ExprError(f"'{'.'.join(node.path)}' 不是整数")
        return cur
    if isinstance(node, Len):
        if node.name not in env:
            raise ExprError(f"未知名字 '{node.name}'")
        v = env[node.name]
        if isinstance(v, (list, bytes, bytearray, str)):
            return len(v)
        raise ExprError(f"len() 不能用于 '{node.name}'")
    if isinstance(node, Un):
        a = evaluate(node.a, env)
        if node.op == "-":
            return -a
        if node.op == "~":
            return ~a
        if node.op == "!":
            return _truth(a == 0)
        raise ExprError(f"未知一元运算 {node.op}")
    if isinstance(node, Bin):
        return _eval_bin(node, env)
    if isinstance(node, Cond):
        return evaluate(node.t if evaluate(node.c, env) else node.f, env)
    raise ExprError(f"非法表达式节点 {node!r}")


def _eval_bin(node: Bin, env: Mapping[str, Any]) -> int:
    op = node.op
    # 短路运算
    if op == "&&":
        return _truth(evaluate(node.a, env) != 0 and evaluate(node.b, env) != 0)
    if op == "||":
        return _truth(evaluate(node.a, env) != 0 or evaluate(node.b, env) != 0)
    a = evaluate(node.a, env)
    b = evaluate(node.b, env)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op in ("/", "//"):
        if b == 0:
            raise ExprError("除零")
        return a // b
    if op == "%":
        if b == 0:
            raise ExprError("对零取模")
        return a % b
    if op == "<<":
        if not 0 <= b < 1024:
            raise ExprError("移位量越界")
        return a << b
    if op == ">>":
        if not 0 <= b < 1024:
            raise ExprError("移位量越界")
        return a >> b
    if op == "&":
        return a & b
    if op == "|":
        return a | b
    if op == "^":
        return a ^ b
    if op == "==":
        return _truth(a == b)
    if op == "!=":
        return _truth(a != b)
    if op == "<":
        return _truth(a < b)
    if op == "<=":
        return _truth(a <= b)
    if op == ">":
        return _truth(a > b)
    if op == ">=":
        return _truth(a >= b)
    raise ExprError(f"未知二元运算 {op}")


# ---------------------------------------------------------------- 静态分析

def root_refs(node: Any) -> set[str]:
    """收集表达式引用的所有顶层名字（编译期前向引用检查用）。"""
    out: set[str] = set()

    def walk(n: Any) -> None:
        if isinstance(n, Ref):
            out.add(n.path[0])
        elif isinstance(n, Len):
            out.add(n.name)
        elif isinstance(n, Un):
            walk(n.a)
        elif isinstance(n, Bin):
            walk(n.a)
            walk(n.b)
        elif isinstance(n, Cond):
            walk(n.c)
            walk(n.t)
            walk(n.f)

    walk(node)
    return out


def is_bare_ref(node: Any) -> str | None:
    """若表达式只是单个字段名引用，返回该名字（编码期可回写）。"""
    if isinstance(node, Ref) and len(node.path) == 1:
        return node.path[0]
    return None
