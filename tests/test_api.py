"""HTTP API：示例、解析、编码、错误分级。"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_example_endpoint():
    r = client.get("/api/example")
    assert r.status_code == 200
    body = r.json()
    assert "struct Packet" in body["layout"]
    assert body["hex"]


def test_parse_example_roundtrip():
    ex = client.get("/api/example").json()
    r = client.post("/api/parse", json={"layout": ex["layout"], "hex": ex["hex"]})
    body = r.json()
    assert body["ok"] and body["issues"] == []
    assert body["values"]["hdr"]["magic"] == 0xCAFE
    # 编码回去应得到同样的字节
    r2 = client.post("/api/encode", json={"layout": ex["layout"],
                                          "values": body["values"]})
    assert r2.json()["ok"] and r2.json()["hex"] == ex["hex"]


def test_parse_compile_error():
    r = client.post("/api/parse", json={"layout": "struct A { a: A; }",
                                        "hex": "00"})
    body = r.json()
    assert not body["ok"] and body["stage"] == "compile"
    assert "递归无界" in body["error"]["message"]


def test_parse_hex_error():
    r = client.post("/api/parse", json={"layout": "struct S { a: u8; }",
                                        "hex": "0g"})
    assert r.json()["stage"] == "hex"


def test_parse_truncation_deepest_path():
    r = client.post("/api/parse", json={
        "layout": "struct S { a: u8; b: u32; }", "hex": "01 02"})
    body = r.json()
    assert not body["ok"]
    assert body["error"]["path"] == ["b"]
    assert body["tree"]["children"][0]["value"] == 1


def test_encode_overflow_via_api():
    r = client.post("/api/encode", json={
        "layout": "struct S { a: u8; }", "values": {"a": 999}})
    body = r.json()
    assert not body["ok"] and "溢出" in body["error"]["message"]


def test_encode_checksum_failure_visible_when_not_fixed():
    lay = "struct S { a: u8; c: checksum(u8, sum8, $start); }"
    r = client.post("/api/encode", json={
        "layout": lay, "values": {"a": 1, "c": 9}, "fix_checksums": False})
    body = r.json()
    assert body["ok"] and len(body["issues"]) == 1


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200 and "二进制布局检查工作台" in r.text
