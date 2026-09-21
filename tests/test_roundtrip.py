"""编码再解析必须得到同一逻辑值；合法报文解析后原样编码应得到原字节。"""
import pytest

from app.compiler import compile_layout
from app.engine import encode, parse

CASES = [
    # 跨字节位域（be/le）
    ("struct S { f: bits be { a: 4; b: 12; }; t: u8; }", "abcdef"),
    ("struct S { f: bits le { a: 4; b: 12; }; }", "cd0a"),
    # 零长度数组
    ("struct S { n: u8; items: [u16; n]; tail: u8; }", "002a"),
    ("struct S { n: u8; items: [u16be; n]; }", "02000a0014"),
    # 联合分支
    ("""struct S { k: u8; c: choice (k) {
            case 1: { x: u8; }
            case 2: { y: u16le; }
            default: { z: u8; } }; }""", "0234 12".replace(" ", "")),
    ("""struct S { k: u8; c: choice (k) {
            case 1: { x: u8; }
            default: { z: u8; } }; }""", "0977"),
    # 填充与跳过
    ("struct S { a: u8; align(4); skip(1); b: u8; }", "01000000" + "00" + "02"),
    # 嵌套结构 + 条件字段
    ("""struct S { h: H; x: u8 if h.ver > 1; }
        struct H { ver: u8; }""", "0209"),
    # 校验（正确的 sum8）
    ("struct S { a: u8; b: u8; c: checksum(u8, sum8, $start); }", "010203"),
    # 结构数组
    ("""struct S { n: u8; pts: [P; n]; }
        struct P { x: u8; y: u8; }""", "020102030 4".replace(" ", "")),
    # 有符号 + 混合端序
    ("endian le; struct S { a: i16; b: u16be; }", "feff1234"),
]


@pytest.mark.parametrize("layout,hexstr", CASES)
def test_roundtrip_values(layout, hexstr):
    plan = compile_layout(layout)
    data = bytes.fromhex(hexstr)
    p1 = parse(plan, data)
    assert p1["ok"] and not p1["issues"]
    # 解析 -> 编码 -> 再解析：逻辑值一致
    e = encode(plan, p1["values"])
    assert e["ok"], e.get("error")
    p2 = parse(plan, bytes.fromhex(e["hex"]))
    assert p2["ok"]
    assert p2["values"] == p1["values"]
    # 未编辑的合法报文应原样还原字节
    assert e["hex"] == data.hex()
    # 再编码幂等
    e2 = encode(plan, p2["values"])
    assert e2["ok"] and e2["hex"] == e["hex"]


def test_roundtrip_example_layout():
    from app.main import EXAMPLE_LAYOUT, EXAMPLE_VALUES
    plan = compile_layout(EXAMPLE_LAYOUT)
    e1 = encode(plan, EXAMPLE_VALUES)
    assert e1["ok"], e1.get("error")
    p = parse(plan, bytes.fromhex(e1["hex"]))
    assert p["ok"] and not p["issues"]
    e2 = encode(plan, p["values"])
    assert e2["ok"] and e2["hex"] == e1["hex"]
    assert e2["values"] == p["values"]


def test_edit_then_roundtrip_keeps_logical_values():
    """编辑（改字段值 + 增删数组元素 + 切换分支）后再编码解析，逻辑值保持。"""
    lay = """
    struct S {
        kind: u8;
        n: u8;
        items: [u16le; n];
        p: choice (kind) { case 0: { t: bytes[2]; } case 1: { v: u8; } };
        c: checksum(u16, crc16, $start);
    }
    """
    plan = compile_layout(lay)
    v = {"kind": 1, "n": 0, "items": [0x1234, 0xABCD],
         "p": {"_case": 1, "v": 0x42}, "c": 0}
    e1 = encode(plan, v)
    assert e1["ok"], e1.get("error")
    p = parse(plan, bytes.fromhex(e1["hex"]))
    assert p["ok"] and not p["issues"]
    got = p["values"]
    assert got["kind"] == 1
    assert got["items"] == [0x1234, 0xABCD]
    assert got["n"] == 2                       # 依赖长度已重算
    assert got["p"] == {"_case": 1, "_branch": 1, "v": 0x42}
    assert got["c"] != 0                       # 校验已重算
