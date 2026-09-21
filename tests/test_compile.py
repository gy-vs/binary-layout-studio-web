"""编译期检查：前向引用、递归无界、重复定义、非法位宽等。"""
import pytest

from app.compiler import CompileError, compile_layout


def test_forward_reference_in_cond():
    with pytest.raises(CompileError, match="声明在后|未声明"):
        compile_layout("struct S { b: u8 if a > 0; a: u8; }")


def test_forward_reference_in_array_count():
    with pytest.raises(CompileError, match="声明在后|未声明"):
        compile_layout("struct S { items: [u8; n]; n: u8; }")


def test_unknown_name():
    with pytest.raises(CompileError, match="未声明"):
        compile_layout("struct S { a: u8 if missing == 1; }")


def test_let_forward_reference():
    with pytest.raises(CompileError, match="声明在后|未声明"):
        compile_layout("struct S { let x = later + 1; later: u8; }")


def test_backward_reference_ok():
    plan = compile_layout(
        "struct S { n: u8; items: [u16le; n]; tail: u8 if n > 0; }")
    assert plan.root == "S"


def test_choice_body_sees_outer_earlier_fields():
    compile_layout("""
        struct S {
            n: u8;
            c: choice (n) { case 1: { data: bytes[n]; } default: {} };
        }
    """)


def test_case_body_fields_do_not_leak():
    with pytest.raises(CompileError, match="未声明|声明在后"):
        compile_layout("""
            struct S {
                k: u8;
                c: choice (k) { case 1: { inner: u8; } default: {} };
                x: u8 if inner == 1;
            }
        """)


def test_direct_recursion_rejected():
    with pytest.raises(CompileError, match="递归无界"):
        compile_layout("struct A { a: A; }")


def test_indirect_recursion_rejected():
    with pytest.raises(CompileError, match="递归无界"):
        compile_layout("""
            struct A { b: B; }
            struct B { a: A; }
        """)


def test_array_recursion_rejected():
    # 即便长度是常量，A 包含 [A; 2] 仍然尺寸无界
    with pytest.raises(CompileError, match="递归无界"):
        compile_layout("struct A { items: [A; 2]; }")


def test_choice_recursion_rejected():
    with pytest.raises(CompileError, match="递归无界"):
        compile_layout("""
            struct A { k: u8; c: choice (k) { case 1: { a: A; } default: {} }; }
        """)


def test_duplicate_field():
    with pytest.raises(CompileError, match="重复"):
        compile_layout("struct S { a: u8; a: u8; }")


def test_duplicate_struct():
    with pytest.raises(CompileError, match="重复"):
        compile_layout("struct S { a: u8; } struct S { b: u8; }")


def test_duplicate_case():
    with pytest.raises(CompileError, match="重复"):
        compile_layout("""
            struct S { k: u8; c: choice (k) { case 1: {} case 1: {} }; }
        """)


def test_duplicate_bit_name():
    with pytest.raises(CompileError, match="重复"):
        compile_layout("struct S { f: bits be { a: 1; a: 2; }; }")


def test_bad_int_width():
    with pytest.raises(CompileError, match="位宽"):
        compile_layout("struct S { a: u12; }")
    with pytest.raises(CompileError, match="位宽"):
        compile_layout("struct S { a: u128; }")
    with pytest.raises(CompileError, match="位宽"):
        compile_layout("struct S { a: u0; }")


def test_unknown_struct_type():
    with pytest.raises(CompileError, match="未知结构"):
        compile_layout("struct S { a: Missing; }")


def test_unknown_checksum_algo():
    with pytest.raises(CompileError, match="未知校验算法"):
        compile_layout("struct S { c: checksum(u16, md5, $start); }")


def test_checksum_storage_too_small():
    with pytest.raises(CompileError, match="位宽"):
        compile_layout("struct S { c: checksum(u8, crc16, $start); }")


def test_checksum_src_must_be_earlier_field():
    with pytest.raises(CompileError, match="起点"):
        compile_layout("struct S { c: checksum(u8, sum8, later); later: u8; }")


def test_checksum_signed_rejected():
    with pytest.raises(CompileError, match="无符号"):
        compile_layout("struct S { c: checksum(i16, crc16, $start); }")


def test_default_endian_and_override():
    plan = compile_layout("""
        endian le;
        struct S { a: u16; b: u16be; }
    """)
    a, b = plan.structs["S"].fields
    assert a.endian == "le" and b.endian == "be"


def test_len_of_unknown_rejected():
    with pytest.raises(CompileError, match="未声明"):
        compile_layout("struct S { a: u8 if len(nope) > 0; }")


def test_expression_restricted_no_calls():
    with pytest.raises(CompileError, match="语法错误"):
        compile_layout("struct S { a: u8 if f(1) == 2; }")


def test_empty_layout_rejected():
    with pytest.raises(CompileError, match="至少"):
        compile_layout("endian be;")
