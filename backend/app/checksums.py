"""校验算法：sum8 / sum16 / xor8 / crc16(CCITT-FALSE) / crc32(IEEE)。"""
from __future__ import annotations

ALGO_BITS = {
    "sum8": 8,
    "xor8": 8,
    "sum16": 16,
    "crc16": 16,
    "crc32": 32,
}


def checksum(algo: str, data: bytes) -> int:
    if algo == "sum8":
        return sum(data) & 0xFF
    if algo == "sum16":
        return sum(data) & 0xFFFF
    if algo == "xor8":
        v = 0
        for b in data:
            v ^= b
        return v
    if algo == "crc16":
        return _crc16_ccitt(data)
    if algo == "crc32":
        return _crc32_ieee(data)
    raise ValueError(f"未知校验算法 {algo!r}")


def _crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _crc32_ieee(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xEDB88320 if crc & 1 else crc >> 1
    return crc ^ 0xFFFFFFFF
