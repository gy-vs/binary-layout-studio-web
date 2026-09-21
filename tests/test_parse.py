"""解析：跨字节位域、零长数组、联合分支、填充、截断（最深路径）、校验、嵌套。"""
from app.compiler import compile_layout
from app.engine import parse


def run(layout, hexstr):
    return parse(compile_layout(layout), bytes.fromhex(hexstr))


def child(node, name):
    for c in node["children"]:
        if c["name"] == name:
            return c
    raise KeyError(name)


def walk(node):
    yield node
    for c in node.get("children", []):
        yield from walk(c)


# ---------------- 跨字节位域 ----------------

def test_bits_cross_byte_be():
    r = run("struct S { f: bits be { a: 4; b: 12; }; }", "ab cd")
    assert r["ok"] and not r["issues"]
    assert r["values"]["f"] == {"a": 0xA, "b": 0xBCD}
    f = child(r["tree"], "f")
    a, b = f["children"]
    assert (a["bit_start"], a["bit_end"]) == (0, 4)
    assert (b["bit_start"], b["bit_end"]) == (4, 16)


def test_bits_cross_byte_le():
    # 组共 16 位：字节 CD AB 按小端解释，a 取低 4 位，b 取接下来 12 位
    r = run("struct S { f: bits le { a: 4; b: 12; }; }", "cd ab")
    assert r["values"]["f"] == {"a": 0xD, "b": 0xABC}


def test_bits_unaligned_following_field():
    # 位域组 12 位，后续字段落在半字节边界上
    r = run("struct S { f: bits be { a: 4; b: 8; }; t: u8; }", "ab cd ef")
    assert r["values"]["f"] == {"a": 0xA, "b": 0xBC}
    assert r["values"]["t"] == 0xDE   # 第 12..20 位
    t = child(r["tree"], "t")
    assert (t["bit_start"], t["bit_end"]) == (12, 20)
    assert t["byte_end"] <= 3


# ---------------- 数组 ----------------

def test_zero_length_array():
    r = run("struct S { n: u8; items: [u16; n]; tail: u8; }", "00 2a")
    assert r["ok"]
    assert r["values"]["items"] == []
    assert r["values"]["tail"] == 0x2A
    items = child(r["tree"], "items")
    assert items["byte_start"] == items["byte_end"] == 1  # 零宽，不吞字节
    assert child(r["tree"], "tail")["byte_start"] == 1


def test_array_values_and_ranges():
    r = run("struct S { n: u8; items: [u16be; n]; }", "02 00 0a 00 14")
    assert r["values"]["items"] == [10, 20]
    items = child(r["tree"], "items")
    assert [c["value"] for c in items["children"]] == [10, 20]
    assert items["children"][1]["byte_start"] == 3


# ---------------- 联合分支 ----------------

CHOICE = """
struct S {
    k: u8;
    c: choice (k) {
        case 1: { x: u8; }
        case 2: { y: u16le; }
        default: { z: u8; }
    };
}
"""


def test_choice_case1():
    r = run(CHOICE, "01 2a")
    assert r["values"]["c"] == {"_case": 1, "_branch": 1, "x": 0x2A}


def test_choice_case2():
    r = run(CHOICE, "02 34 12")
    assert r["values"]["c"]["y"] == 0x1234


def test_choice_default():
    r = run(CHOICE, "09 77")
    v = r["values"]["c"]
    assert v["_branch"] == "default" and v["z"] == 0x77


def test_choice_no_matching_case_aborts():
    lay = """
    struct S {
        k: u8;
        c: choice (k) { case 1: { x: u8; } };
    }
    """
    r = run(lay, "05 2a")
    assert not r["ok"]
    assert r["error"]["path"] == ["c"]
    assert "无匹配" in r["error"]["message"]


# ---------------- 填充 / 跳过 ----------------

def test_align_padding():
    r = run("struct S { a: u8; align(4); b: u8; }", "01 00 00 00 02")
    assert r["ok"]
    assert r["values"]["b"] == 2
    pad = r["tree"]["children"][1]
    assert pad["kind"] == "pad" and pad["byte_start"] == 1 and pad["byte_end"] == 4
    assert child(r["tree"], "b")["byte_start"] == 4


def test_align_already_aligned():
    r = run("struct S { a: u16; align(2); b: u8; }", "01 02 03")
    pad = r["tree"]["children"][1]
    assert pad["byte_start"] == pad["byte_end"] == 2


def test_skip():
    r = run("struct S { a: u8; skip(2); b: u8; }", "01 aa bb 02")
    assert r["values"]["b"] == 2
    assert child(r["tree"], "b")["byte_start"] == 3


# ---------------- 截断与最深成功路径 ----------------

def test_truncation_returns_deepest_path():
    r = run("struct S { a: u8; b: u32; }", "01 02")
    assert not r["ok"]
    assert r["error"]["path"] == ["b"]
    assert r["error"]["bit_offset"] == 8
    # 已成功的字段保留在树与值中
    assert child(r["tree"], "a")["value"] == 1
    assert r["values"]["a"] == 1
    assert "b" not in r["values"]


def test_truncation_inside_array_keeps_completed_elements():
    r = run("struct S { n: u8; items: [u16; n]; }", "02 01 00")
    assert not r["ok"]
    assert r["error"]["path"] == ["items", "[1]"]
    items = child(r["tree"], "items")
    assert len(items["children"]) == 2          # 完整元素 + 失败元素占位
    assert items["children"][0]["value"] == 0x0100
    assert "error" in items["children"][1]      # 最深失败点被标记
    assert items["children"][1]["byte_end"] <= 3
    assert r["values"]["items"] == [0x0100]


def test_truncation_inside_nested_struct():
    lay = """
    struct S { h: H; tail: u8; }
    struct H { x: u16; y: u16; }
    """
    r = run(lay, "00 01 00")
    assert not r["ok"]
    assert r["error"]["path"] == ["h", "y"]
    h = child(r["tree"], "h")
    assert child(h, "x")["value"] == 1
    assert r["values"]["h"] == {"x": 1}


def test_truncation_inside_choice_body():
    lay = """
    struct S { k: u8; c: choice (k) { case 1: { x: u16; } default: {} }; }
    """
    r = run(lay, "01 05")
    assert not r["ok"]
    assert r["error"]["path"] == ["c", "x"]


def test_ranges_never_exceed_input():
    for lay, hx in [
        ("struct S { a: u8; b: u32; }", "01 02"),
        ("struct S { n: u8; items: [u16; n]; }", "03 00 01"),
        ("struct S { a: u8; align(8); b: u8; }", "01 00"),
    ]:
        data = bytes.fromhex(hx)
        r = parse(compile_layout(lay), data)
        for n in walk(r["tree"]):
            assert 0 <= n["byte_start"] <= n["byte_end"] <= len(data), n


# ---------------- 校验 ----------------

SUM8 = "struct S { a: u8; b: u8; c: checksum(u8, sum8, $start); }"


def test_checksum_ok():
    r = run(SUM8, "01 02 03")
    assert r["ok"] and r["issues"] == []
    c = child(r["tree"], "c")
    assert c["checksum"]["ok"] and c["checksum"]["computed"] == 3


def test_checksum_failure_reported():
    r = run(SUM8, "01 02 09")
    assert r["ok"]                      # 结构解析成功
    assert len(r["issues"]) == 1        # 但校验失败被记录
    assert "校验失败" in r["issues"][0]["message"]
    c = child(r["tree"], "c")
    assert c["checksum"]["stored"] == 9
    assert c["checksum"]["computed"] == 3
    assert not c["checksum"]["ok"]


def test_checksum_from_named_field():
    lay = "struct S { h: u8; x: u8; y: u8; c: checksum(u8, sum8, x); }"
    r = run(lay, "ff 01 02 03")   # 只覆盖 x,y，不含 h
    assert r["issues"] == []


def test_crc16_known_vector():
    # CRC-16/CCITT-FALSE of "123456789" = 0x29B1
    lay = "struct S { d: bytes[9]; c: checksum(u16, crc16, $start); }"
    r = run(lay, "313233343536373839 29 b1")
    assert r["issues"] == [] and r["tree"]["children"][1]["checksum"]["ok"]


# ---------------- 其余 ----------------

def test_nested_struct_offsets():
    lay = """
    struct S { h: H; b: u8; }
    struct H { x: u8; y: u8; }
    """
    r = run(lay, "01 02 03")
    assert r["values"] == {"h": {"x": 1, "y": 2}, "b": 3}
    assert child(r["tree"], "h")["byte_start"] == 0
    assert child(r["tree"], "b")["byte_start"] == 2


def test_conditional_field():
    lay = "struct S { f: u8; x: u8 if f == 1; y: u8; }"
    r1 = run(lay, "01 0a 0b")
    assert r1["values"] == {"f": 1, "x": 10, "y": 11}
    r0 = run(lay, "00 0b")
    assert r0["values"] == {"f": 0, "y": 11}
    assert child(r0["tree"], "y")["byte_start"] == 1


def test_endianness():
    r = run("struct S { a: u16le; b: u16be; }", "34 12 12 34")
    assert r["values"]["a"] == 0x1234
    assert r["values"]["b"] == 0x1234


def test_signed_ints():
    r = run("struct S { a: i8; b: i16le; }", "ff 00 80")
    assert r["values"]["a"] == -1
    assert r["values"]["b"] == -32768


def test_let_and_expr():
    lay = "struct S { a: u8; let d = a * 2; b: u8 if d > 4; }"
    assert run(lay, "03 09")["values"].get("b") == 9
    assert "b" not in run(lay, "01")["values"]


def test_len_function():
    lay = "struct S { n: u8; items: [u8; n]; m: u8 if len(items) > 1; }"
    assert run(lay, "02 05 06 07")["values"]["m"] == 7
    assert "m" not in run(lay, "01 05")["values"]


def test_bytes_field():
    r = run("struct S { n: u8; d: bytes[n]; }", "03 aa bb cc")
    assert r["values"]["d"] == "aabbcc"


def test_dotted_ref_into_struct():
    lay = """
    struct S { h: H; x: u8 if h.ver > 0; }
    struct H { ver: u8; }
    """
    assert run(lay, "01 09")["values"]["x"] == 9
    assert "x" not in run(lay, "00 09")["values"]


def test_division_by_zero_is_parse_error():
    r = run("struct S { a: u8; b: u8 if a / (a - a) > 0; }", "01")
    assert not r["ok"]
    assert "除零" in r["error"]["message"]
