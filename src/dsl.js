'use strict';

// 布局 DSL 词法/语法分析，产出 AST（语义检查在 compiler.js）。
//
// 语法概览：
//   struct Packet be {
//     magic:  u16 = 0xABCD;
//     hdr:    u16 { version: 4, type: 4, flags: 8 };
//     count:  u8;
//     items:  Item[count];
//     payload: bytes[length - 2];
//     body:   choose (hdr.type) { 1: u16; 2: bytes[2]; _: u8; };
//     tail:   u16 align(4);
//     crc:    crc16;
//   }

const { parseExpr } = require('./expr');

class DslError extends Error {
  constructor(message, line) {
    super(line ? `第 ${line} 行: ${message}` : message);
    this.name = 'DslError';
    this.line = line || 0;
  }
}

const INT_TYPES = new Set(['u8', 'u16', 'u32', 'i8', 'i16', 'i32']);
const CHECKSUMS = new Set(['crc16', 'crc32', 'sum8', 'sum16', 'xor8']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new DslError('块注释未闭合', line);
      line += src.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (src.startsWith('0x', i) || src.startsWith('0X', i)) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        if (j === i + 2) throw new DslError('非法十六进制字面量', line);
      } else {
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)), line });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (':;{}[](),=.*/%+-<>&|!~'.includes(c)) {
      toks.push({ t: 'punct', v: c, line });
      i++;
      continue;
    }
    throw new DslError(`非法字符 '${c}'`, line);
  }
  return toks;
}

// 读取平衡括号内的文本（用于表达式），start 指向开括号之后，返回 [文本, 消耗token数]
function readBalanced(toks, start, open, close) {
  let depth = 1;
  let j = start;
  for (; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === 'punct' && t.v === open) depth++;
    else if (t.t === 'punct' && t.v === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= toks.length) throw new DslError(`'${open}' 未闭合`, toks[start] ? toks[start].line : 0);
  // 无空格拼接：多字符运算符（==、<< 等）在 DSL 分词时已被拆开，需原样拼回
  const text = toks.slice(start, j).map((t) => (t.t === 'num' ? String(t.v) : t.v)).join('');
  return [text, j - start + 1];
}

function parseSchema(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const line = () => (toks[pos] ? toks[pos].line : 0);
  const eatPunct = (p) => {
    const t = toks[pos];
    if (t && t.t === 'punct' && t.v === p) { pos++; return true; }
    return false;
  };
  const expectPunct = (p) => {
    if (!eatPunct(p)) throw new DslError(`应为 '${p}'`, line());
  };
  const expectIdent = (what) => {
    const t = toks[pos];
    if (!t || t.t !== 'ident') throw new DslError(`应为${what}`, line());
    pos++;
    return t.v;
  };
  const expectNum = () => {
    const t = toks[pos];
    if (!t || t.t !== 'num') throw new DslError('应为数字', line());
    pos++;
    return t.v;
  };
  // 读取 [ ... ] 或 ( ... ) 中的表达式
  const readExpr = (open, close) => {
    expectPunct(open);
    const [text, consumed] = readBalanced(toks, pos, open, close);
    pos += consumed;
    try {
      return parseExpr(text);
    } catch (e) {
      throw new DslError(`表达式错误: ${e.message}`, line());
    }
  };

  function parseBitFields() {
    // 消费 '{' name: bits (, name: bits)* ,? '}'
    expectPunct('{');
    const fields = [];
    for (;;) {
      if (eatPunct('}')) break;
      const name = expectIdent('位域名');
      expectPunct(':');
      const bits = expectNum();
      fields.push({ name, bits });
      if (eatPunct(',')) continue;
      expectPunct('}');
      break;
    }
    return fields;
  }

  function parseCaseType() {
    const t = peek();
    if (t && t.t === 'ident') {
      if (INT_TYPES.has(t.v)) {
        pos++;
        const bits = Number(t.v.slice(1));
        return { t: 'int', bits, signed: t.v[0] === 'i' };
      }
      if (t.v === 'bytes') {
        pos++;
        return { t: 'bytes', count: readExpr('[', ']') };
      }
      // 结构体引用
      pos++;
      return { t: 'struct', name: t.v };
    }
    throw new DslError('分支类型应为整数类型、bytes[N] 或结构体名', line());
  }

  function parsePrimary() {
    const t = peek();
    if (!t || t.t !== 'ident') throw new DslError('应为类型', line());
    const v = t.v;
    if (INT_TYPES.has(v)) {
      pos++;
      const bits = Number(v.slice(1));
      const signed = v[0] === 'i';
      if (peek() && peek().t === 'punct' && peek().v === '{') {
        if (signed) throw new DslError('位域容器必须是无符号类型', t.line);
        return { t: 'bits', bits, fields: parseBitFields() };
      }
      return { t: 'int', bits, signed };
    }
    if (v === 'bytes') {
      pos++;
      return { t: 'bytes', count: readExpr('[', ']') };
    }
    if (v === 'choose') {
      pos++;
      const expr = readExpr('(', ')');
      expectPunct('{');
      const cases = [];
      for (;;) {
        if (eatPunct('}')) break;
        let value = null; // null 表示默认分支 '_'
        const ct = peek();
        if (ct && ct.t === 'ident' && ct.v === '_') {
          pos++;
        } else if (ct && ct.t === 'num') {
          pos++;
          value = ct.v;
        } else {
          throw new DslError('分支标签应为整数或 _', line());
        }
        expectPunct(':');
        const type = parseCaseType();
        expectPunct(';');
        cases.push({ value, type });
      }
      return { t: 'choose', expr, cases };
    }
    if (CHECKSUMS.has(v)) {
      pos++;
      return { t: 'checksum', algo: v };
    }
    // 结构体引用
    pos++;
    return { t: 'struct', name: v };
  }

  function parseFieldType() {
    let type = parsePrimary();
    // 数组后缀：仅整数与结构体可构成数组
    if (peek() && peek().t === 'punct' && peek().v === '[') {
      if (type.t !== 'int' && type.t !== 'struct') {
        throw new DslError('只有整数或结构体可以构成数组', line());
      }
      type = { t: 'array', elem: type, count: readExpr('[', ']') };
    }
    // align(N)
    if (peek() && peek().t === 'ident' && peek().v === 'align') {
      pos++;
      expectPunct('(');
      const n = expectNum();
      expectPunct(')');
      type.align = n;
    }
    // = 常量（仅整数字段）
    if (peek() && peek().t === 'punct' && peek().v === '=') {
      pos++;
      const value = expectNum();
      if (type.t !== 'int') throw new DslError('只有整数字段可以声明常量', line());
      type.const = value;
    }
    return type;
  }

  const structs = [];
  while (pos < toks.length) {
    const t = peek();
    if (!t || t.t !== 'ident' || t.v !== 'struct') {
      throw new DslError("顶层只允许 'struct' 定义", line());
    }
    pos++;
    const name = expectIdent('结构体名');
    let endian = 'be';
    if (peek() && peek().t === 'ident' && (peek().v === 'be' || peek().v === 'le')) {
      endian = toks[pos].v;
      pos++;
    }
    expectPunct('{');
    const fields = [];
    for (;;) {
      if (eatPunct('}')) break;
      const fname = expectIdent('字段名');
      expectPunct(':');
      const type = parseFieldType();
      expectPunct(';');
      fields.push({ name: fname, type, line: t.line });
    }
    structs.push({ name, endian, fields });
  }
  if (structs.length === 0) throw new DslError('至少需要一个 struct 定义', 0);
  return { structs };
}

module.exports = { DslError, parseSchema, INT_TYPES, CHECKSUMS };
