"""HTTP API + 前端静态托管。

POST /api/parse   {layout, hex}                        -> 解析结果（含最深成功路径）
POST /api/encode  {layout, values, fix_checksums,
                   fix_lengths}                        -> 重新编码（重算长度/校验/偏移）
GET  /api/example -> 内置示例（布局 + 由引擎生成的报文）
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .compiler import CompileError, compile_layout
from .engine import encode, parse

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

EXAMPLE_LAYOUT = """\
// 示例布局：嵌套结构、跨字节位域、动态长度、联合分支、对齐填充、校验
// （根结构 = 第一个声明的 struct）
endian be;

struct Packet {
    hdr:    Header;               // 嵌套结构
    length: u8;                   // 决定 payload 长度的先前字段
    kind:   u8;
    payload: choice (kind) {      // 联合分支
        case 0: {
            text: bytes[length];  // 长度由先前字段决定
        }
        case 1: {
            count:   u8;
            samples: [u16le; count];   // 数组（可为零长度）
        }
        default: {
            raw: bytes[2];
        }
    };
    align(4);                     // 填充到 4 字节边界
    crc: checksum(u16, crc16, $start);   // 覆盖整个 Packet
}

struct Header {
    magic:   u16;                 // 0xCAFE
    version: u8;
    flags: bits be {              // 跨字节位域组（共 12 位）
        mode:      4;
        encrypted: 1;
        priority:  7;
    };
}
"""

EXAMPLE_VALUES = {
    "hdr": {"magic": 0xCAFE, "version": 1,
            "flags": {"mode": 9, "encrypted": 1, "priority": 100}},
    "length": 2,
    "kind": 0,
    "payload": {"_case": 0, "text": "4869"},   # "Hi"
    "crc": 0,
}

app = FastAPI(title="二进制布局检查工作台")


class ParseReq(BaseModel):
    layout: str
    hex: str


class EncodeReq(BaseModel):
    layout: str
    values: dict
    fix_checksums: bool = True
    fix_lengths: bool = True


def _compile_or_error(layout: str):
    try:
        return compile_layout(layout), None
    except CompileError as e:
        return None, {"ok": False, "stage": "compile",
                      "error": {"message": str(e), "path": []}}


_HEX_CLEAN = re.compile(r"0[xX]|[\s,，、]+")


def parse_hex(text: str):
    """容忍空白、逗号与 0x 前缀的十六进制输入。"""
    cleaned = _HEX_CLEAN.sub("", text.strip())
    if not cleaned:
        return b"", None
    if len(cleaned) % 2:
        return None, "十六进制长度必须为偶数"
    try:
        return bytes.fromhex(cleaned), None
    except ValueError:
        return None, "包含非法的十六进制字符"


@app.post("/api/parse")
def api_parse(req: ParseReq):
    plan, err = _compile_or_error(req.layout)
    if err:
        return JSONResponse(err)
    data, hex_err = parse_hex(req.hex)
    if hex_err:
        return JSONResponse({"ok": False, "stage": "hex",
                             "error": {"message": hex_err, "path": []}})
    return parse(plan, data)


@app.post("/api/encode")
def api_encode(req: EncodeReq):
    plan, err = _compile_or_error(req.layout)
    if err:
        return JSONResponse(err)
    return encode(plan, req.values,
                  fix_checksums=req.fix_checksums,
                  fix_lengths=req.fix_lengths)


@app.get("/api/example")
def api_example():
    plan = compile_layout(EXAMPLE_LAYOUT)
    enc = encode(plan, EXAMPLE_VALUES)
    return {"layout": EXAMPLE_LAYOUT, "hex": enc["hex"],
            "values": enc["values"]}


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
