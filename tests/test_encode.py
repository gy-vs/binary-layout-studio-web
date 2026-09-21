"""编码：溢出、依赖长度回写、校验重算、分支标签回写、零长数组。"""
from app.compiler import compile_layout
from app.engine import encode, parse


def enc(layout, values, **kw):
    return encode(compile_layout(layout), values, **kw)


# ---------------- 基本编码 ----------------

def test_encode_basic_bytes():
    lay = "struct S { a: u8; b: u16le; c: u16be; }"
    r = enc(lay, {"a": 1, "b": 0x1234, "c": 0x5678})
    assert r["ok"]
    assert r["hex"] == "0134125678"


def test_encode_bits_cross_byte():
    lay = "struct S { f: bits be { a: 4; b: 12; }; }"
    r = enc(lay, {"f": {"a": 0xA, "b": 0xBCD}})
    assert r["ok"] and r["hex"] == "abcd"


def test_encode_bits_le():
    lay = "struct S { f: bits le { a: 4; b: 12; }; }"
    r = enc(lay, {"f": {"a": 0xD, "b": 0xAC}})
    assert r["ok"] and r["hex"] == "cd0a"


def test_encode_signed():
    lay = "struct S { a: i8; b: i16be; }"
    r = enc(lay, {"a": -1, "b": -2})
    assert r["ok"] and r["hex"] == "fffffe"


def test_encode_align_skip_zeros():
    lay = "struct S { a: u8; align(4); skip(1); b: u8; }"
    r = enc(lay, {"a": 1, "b": 2})
    assert r["ok"] and r["hex"] == "01000000" + "00" + "02"


# ---------------- 整数溢出 ----------------

def test_overflow_unsigned():
    r = enc("struct S { a: u8; }", {"a": 300})
    assert not r["ok"] and "溢出" in r["error"]["message"]
    assert r["error"]["path"] == ["a"]


def test_overflow_negative_into_unsigned():
    r = enc("struct S { a: u8; }", {"a": -1})
    assert not r["ok"] and "溢出" in r["error"]["message"]


def test_overflow_signed_bounds():
    assert enc("struct S { a: i8; }", {"a": 127})["ok"]
    assert enc("struct S { a: i8; }", {"a": -128})["ok"]
    assert not enc("struct S { a: i8; }", {"a": 128})["ok"]
    assert not enc("struct S { a: i8; }", {"a": -129})["ok"]


def test_overflow_bit_item():
    r = enc("struct S { f: bits be { a: 3; b: 5; }; }",
            {"f": {"a": 8, "b": 0}})
    assert not r["ok"] and "溢出" in r["error"]["message"]


def test_overflow_array_element():
    r = enc("struct S { n: u8; items: [u8; n]; }",
            {"n": 2, "items": [1, 256]})
    assert not r["ok"] and "溢出" in r["error"]["message"]


# ---------------- 依赖长度重算（回写计数字段） ----------------

def test_length_backpatched_from_actual_array():
    lay = "struct S { n: u8; items: [u16be; n]; }"
    r = enc(lay, {"n": 99, "items": [1, 2, 3]})   # n 与实际不符
    assert r["ok"]
    assert r["hex"] == "03" + "000100020003"      # n 被重算为 3
    assert r["values"]["n"] == 3


def test_length_mismatch_rejected_when_fix_disabled():
    lay = "struct S { n: u8; items: [u16be; n]; }"
    r = enc(lay, {"n": 2, "items": [1, 2, 3]}, fix_lengths=False)
    assert not r["ok"] and "长度不符" in r["error"]["message"]


def test_zero_length_array_encode():
    lay = "struct S { n: u8; items: [u16be; n]; tail: u8; }"
    r = enc(lay, {"n": 5, "items": [], "tail": 0x2A})
    assert r["ok"] and r["hex"] == "00" + "2a"
    assert r["values"]["n"] == 0


def test_complex_length_expr_not_backpatched():
    lay = "struct S { n: u8; items: [u8; n - 1]; }"
    r = enc(lay, {"n": 3, "items": [1, 2]})
    assert r["ok"] and r["hex"] == "030102"
    bad = enc(lay, {"n": 3, "items": [1, 2, 3]})
    assert not bad["ok"] and "长度不符" in bad["error"]["message"]


def test_bytes_length_backpatch_across_choice_boundary():
    lay = """
    struct S {
        length: u8;
        kind: u8;
        p: choice (kind) { case 0: { text: bytes[length]; } default: {} };
    }
    """
    r = enc(lay, {"length": 1, "kind": 0, "p": {"_case": 0, "text": "414243"}})
    assert r["ok"]
    assert r["values"]["length"] == 3   # 外层计数字段被回写
    assert r["hex"].startswith("0300" + "414243")


# ---------------- 校验重算 ----------------

def test_checksum_recomputed_on_encode():
    lay = "struct S { a: u8; b: u8; c: checksum(u8, sum8, $start); }"
    r = enc(lay, {"a": 1, "b": 2, "c": 0})      # 提供的 c 被忽略
    assert r["ok"] and r["hex"] == "010203"
    assert r["values"]["c"] == 3


def test_checksum_kept_when_fix_disabled():
    lay = "struct S { a: u8; b: u8; c: checksum(u8, sum8, $start); }"
    r = enc(lay, {"a": 1, "b": 2, "c": 9}, fix_checksums=False)
    assert r["ok"] and r["hex"] == "010209"
    assert len(r["issues"]) == 1                # 回读时发现校验失败


def test_checksum_covers_edited_length():
    lay = """
    struct S { n: u8; items: [u8; n]; c: checksum(u8, sum8, $start); }
    """
    r = enc(lay, {"n": 0, "items": [10, 20, 30], "c": 0})
    assert r["ok"]
    assert r["values"]["n"] == 3
    assert r["values"]["c"] == (3 + 10 + 20 + 30) & 0xFF
    assert r["issues"] == []


# ---------------- 分支标签回写 ----------------

def test_choice_tag_backpatched():
    lay = """
    struct S {
        kind: u8;
        p: choice (kind) {
            case 1: { x: u8; }
            case 2: { y: u16be; }
        };
    }
    """
    r = enc(lay, {"kind": 1, "p": {"_case": 2, "y": 0x1234}})
    assert r["ok"]
    assert r["values"]["kind"] == 2             # kind 被重算
    assert r["hex"] == "02" + "1234"


def test_choice_unknown_tag_without_default():
    lay = "struct S { k: u8; p: choice (k) { case 1: { x: u8; } }; }"
    r = enc(lay, {"k": 5, "p": {"_case": 5}})
    assert not r["ok"] and "无匹配" in r["error"]["message"]


# ---------------- 其它错误 ----------------

def test_missing_value():
    r = enc("struct S { a: u8; b: u8; }", {"a": 1})
    assert not r["ok"] and "缺少" in r["error"]["message"]
    assert r["error"]["path"] == ["b"]


def test_wrong_type():
    r = enc("struct S { a: u8; }", {"a": "x"})
    assert not r["ok"] and "整数" in r["error"]["message"]


def test_cond_field_skipped_even_if_value_present():
    lay = "struct S { f: u8; x: u8 if f == 1; y: u8; }"
    r = enc(lay, {"f": 0, "x": 99, "y": 7})
    assert r["ok"] and r["hex"] == "0007"       # x 未写入
    assert "x" not in r["values"]


def test_nested_struct_encode():
    lay = """
    struct S { h: H; b: u8; }
    struct H { x: u8; y: u16le; }
    """
    r = enc(lay, {"h": {"x": 1, "y": 0x1234}, "b": 5})
    assert r["ok"] and r["hex"] == "01341205"


def test_fresh_offsets_after_edit():
    """编辑数组长度后，后续字段偏移必须整体平移，不复用旧偏移。"""
    lay = "struct S { n: u8; items: [u8; n]; tail: u8; }"
    first = enc(lay, {"n": 1, "items": [0xAA], "tail": 0xBB})
    assert first["ok"]
    tail_off_1 = first["tree"]["children"][2]["byte_start"]
    grown = dict(first["values"], items=[0xAA, 0xBB, 0xCC])
    second = enc(lay, grown)
    assert second["ok"]
    tail_off_2 = second["tree"]["children"][2]["byte_start"]
    assert tail_off_1 == 2 and tail_off_2 == 4   # tail 偏移随长度后移
    assert second["values"]["n"] == 3
