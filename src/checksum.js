'use strict';

// 校验和算法：crc16(CCITT) / crc32(IEEE) / sum8 / sum16 / xor8

function crc16(bytes, start, end) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sum8(bytes, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s = (s + bytes[i]) & 0xff;
  return s;
}

function sum16(bytes, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s = (s + bytes[i]) & 0xffff;
  return s;
}

function xor8(bytes, start, end) {
  let x = 0;
  for (let i = start; i < end; i++) x ^= bytes[i];
  return x;
}

const ALGOS = { crc16, crc32, sum8, sum16, xor8 };

function computeChecksum(algo, bytes, start, end) {
  const fn = ALGOS[algo];
  if (!fn) throw new Error(`未知校验算法 ${algo}`);
  return fn(bytes, start, end);
}

module.exports = { computeChecksum, ALGOS };
