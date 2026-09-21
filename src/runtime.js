'use strict';

// 解析与编码共享同一份编译计划（plan）。计划不含任何预计算偏移，
// 解析/编码都按字段顺序现场推进游标，因此编辑后重编码不会复用旧偏移。

const { evalExpr, ExprError } = require('./expr');
const { computeChecksum } = require('./checksum');

class ParseError extends Error {
  constructor(message, path, bit) {
    super(message);
    this.name = 'ParseError';
    this.path = path; // 数组形式的字段路径
    this.bit = bit; // 出错时的位偏移
  }
}

class EncodeError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'EncodeError';
    this.path = path;
  }
}

const MAX_COUNT = 1 << 20;

// ---------- 十六进制 ----------

function hexToBytes(hex) {
  const clean = String(hex).replace(/\s+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0) throw new ParseError('十六进制长度必须为偶数', [], 0);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new ParseError('十六进制包含非法字符', [], 0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 位流读写（字段边界始终字节对齐；位域经容器整体读写） ----------

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0; // 位
  }
  get lengthBits() {
    return this.bytes.length * 8;
  }
  readUInt(bits, endian, path) {
    if (this.pos % 8 !== 0) throw new ParseError('内部错误：非字节对齐读取', path, this.pos);
    if (this.pos + bits > this.lengthBits) {
      throw new ParseError(
        `输入被截断：在字节 ${this.pos / 8} 处需要 ${bits / 8} 字节，仅剩 ${(this.lengthBits - this.pos) / 8} 字节`,
        path, this.pos,
      );
    }
    let v = 0;
    const start = this.pos / 8;
    const n = bits / 8;
    if (endian === 'be') {
      for (let i = 0; i < n; i++) v = v * 256 + this.bytes[start + i];
    } else {
      for (let i = 0; i < n; i++) v += this.bytes[start + i] * 256 ** i;
    }
    this.pos += bits;
    return v;
  }
  readBytes(n, path) {
    if (this.pos % 8 !== 0) throw new ParseError('内部错误：非字节对齐读取', path, this.pos);
    if (this.pos + n * 8 > this.lengthBits) {
      throw new ParseError(
        `输入被截断：在字节 ${this.pos / 8} 处需要 ${n} 字节，仅剩 ${(this.lengthBits - this.pos) / 8} 字节`,
        path, this.pos,
      );
    }
    const start = this.pos / 8;
    this.pos += n * 8;
    return this.bytes.slice(start, start + n);
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.pos = 0; // 位，始终字节对齐
  }
  writeUInt(value, bits, endian) {
    const n = bits / 8;
    for (let i = 0; i < n; i++) {
      const shift = endian === 'be' ? n - 1 - i : i;
      this.bytes.push(Math.floor(value / 256 ** shift) % 256);
    }
    this.pos += bits;
  }
  writeBytes(arr) {
    for (const b of arr) this.bytes.push(b);
    this.pos += arr.length * 8;
  }
  writeZeros(bits) {
    for (let i = 0; i < bits / 8; i++) this.bytes.push(0);
    this.pos += bits;
  }
  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

function alignedPos(pos, structStart, alignBytes) {
  const a = alignBytes * 8;
  const rel = pos - structStart;
  return pos + ((a - (rel % a)) % a);
}

function joinPath(path) {
  return path.join('.');
}

// ---------- 解析 ----------

function evalCount(exprAst, env, path, bit) {
  let n;
  try {
    n = evalExpr(exprAst, env);
  } catch (e) {
    if (e instanceof ExprError) throw new ParseError(`长度表达式求值失败: ${e.message}`, path, bit);
    throw e;
  }
  if (!Number.isInteger(n) || n < 0) throw new ParseError(`长度表达式结果为非法值 ${n}`, path, bit);
  if (n > MAX_COUNT) throw new ParseError(`长度 ${n} 超过上限`, path, bit);
  return n;
}

function applyAlignRead(br, align, structStart, path, nodes) {
  if (!align) return;
  const target = alignedPos(br.pos, structStart, align);
  const pad = target - br.pos;
  if (pad === 0) return;
  if (target > br.lengthBits) {
    throw new ParseError('对齐填充越界：输入被截断', path, br.pos);
  }
  nodes.push({
    name: `_pad(${align})`, kind: 'pad', path: [...path, '_pad'],
    start: br.pos, end: target, value: null,
  });
  br.pos = target;
}

function parseStruct(plan, structName, br, ctx, path, fieldName) {
  const st = plan.structs[structName];
  if (!st) throw new ParseError(`未知结构体 '${structName}'`, path, br.pos);
  const frame = {
    frameKind: 'struct', structName, fieldName, path, startBit: br.pos, nodes: [], values: {}, env: {},
  };
  ctx.frames.push(frame);
  for (const f of st.fields) {
    applyAlignRead(br, f.align, frame.startBit, path, frame.nodes);
    const r = parseField(plan, f, st, br, ctx, [...path, f.name], frame.startBit, frame.env);
    frame.nodes.push(r.node);
    frame.values[f.name] = r.value;
    frame.env[f.name] = r.envValue;
    if (r.node.end > ctx.deepest.bit) ctx.deepest = { bit: r.node.end, path: r.node.path };
  }
  ctx.frames.pop();
  return { values: frame.values, nodes: frame.nodes, env: frame.env, startBit: frame.startBit, endBit: br.pos };
}

function parseField(plan, f, st, br, ctx, path, structStart, env) {
  const start = br.pos;
  const base = { name: f.name, kind: f.kind, path, start };
  switch (f.kind) {
    case 'int': {
      const raw = br.readUInt(f.bits, st.endian, path);
      let v = raw;
      if (f.signed) {
        const signBit = 2 ** (f.bits - 1);
        if (v >= signBit) v -= 2 ** f.bits;
      }
      if (f.const !== undefined && v !== f.const) {
        throw new ParseError(
          `常量不匹配：期望 0x${f.const.toString(16)}，实际 0x${v.toString(16)}`, path, start,
        );
      }
      return { value: v, envValue: v, node: { ...base, end: br.pos, value: v } };
    }
    case 'bits': {
      const raw = br.readUInt(f.bits, st.endian, path);
      const value = {};
      const children = [];
      let cum = 0;
      for (const sub of f.fields) {
        const shift = st.endian === 'be' ? f.bits - cum - sub.bits : cum;
        const sv = Math.floor(raw / 2 ** shift) % 2 ** sub.bits;
        value[sub.name] = sv;
        // 子字段位范围：be 从最高位起排，le 从最低位起排
        const cs = st.endian === 'be' ? start + cum : start + f.bits - cum - sub.bits;
        children.push({
          name: sub.name, kind: 'bitfield', path: [...path, sub.name],
          start: cs, end: cs + sub.bits, value: value[sub.name],
        });
        cum += sub.bits;
      }
      return {
        value, envValue: value,
        node: { ...base, end: br.pos, value, children },
      };
    }
    case 'bytes': {
      const n = evalCount(f.count, env, path, start);
      const arr = br.readBytes(n, path);
      const hex = bytesToHex(arr);
      return {
        value: hex, envValue: Array.from(arr),
        node: { ...base, end: br.pos, value: hex, meta: { count: n } },
      };
    }
    case 'array': {
      const n = evalCount(f.count, env, path, start);
      const items = [];
      const envItems = [];
      const children = [];
      // 数组同样压帧：失败时部分树能保留已完成的元素
      ctx.frames.push({ frameKind: 'array', fieldName: f.name, path, startBit: start, nodes: children });
      for (let i = 0; i < n; i++) {
        const elemPath = [...path.slice(0, -1), `${f.name}[${i}]`];
        const r = parseElem(plan, f.elem, st, br, ctx, elemPath, structStart, env);
        items.push(r.value);
        envItems.push(r.envValue);
        children.push(r.node);
        if (r.node.end > ctx.deepest.bit) ctx.deepest = { bit: r.node.end, path: r.node.path };
      }
      ctx.frames.pop();
      return {
        value: items, envValue: envItems,
        node: { ...base, end: br.pos, value: items, children, meta: { count: n } },
      };
    }
    case 'struct': {
      const r = parseStruct(plan, f.struct, br, ctx, path, f.name);
      return {
        value: r.values, envValue: r.env,
        node: { ...base, end: br.pos, value: r.values, children: r.nodes, struct: f.struct },
      };
    }
    case 'choice': {
      let key;
      try {
        key = evalExpr(f.expr, env);
      } catch (e) {
        if (e instanceof ExprError) throw new ParseError(`分支表达式求值失败: ${e.message}`, path, start);
        throw e;
      }
      let chosen = f.cases.find((c) => c.value === key);
      let isDefault = false;
      if (!chosen) {
        chosen = f.cases.find((c) => c.value === null);
        isDefault = true;
        if (!chosen) {
          throw new ParseError(`分支表达式值 ${key} 没有匹配的分支，且无默认分支`, path, start);
        }
      }
      const r = parseElem(plan, chosen.type, st, br, ctx, path, structStart, env);
      return {
        value: r.value, envValue: r.envValue,
        node: {
          ...base, end: br.pos, value: r.value, children: [r.node],
          meta: { case: isDefault ? '_' : key, exprValue: key },
        },
      };
    }
    case 'checksum': {
      if (structStart % 8 !== 0 || start % 8 !== 0) {
        throw new ParseError('校验字段覆盖范围未字节对齐', path, start);
      }
      const v = br.readUInt(f.bits, st.endian, path);
      const computed = computeChecksum(f.algo, br.bytes, structStart / 8, start / 8);
      return {
        value: v, envValue: v,
        node: {
          ...base, end: br.pos, value: v,
          meta: { algo: f.algo, computed, ok: computed === v, coverStart: structStart / 8, coverEnd: start / 8 },
        },
      };
    }
    default:
      throw new ParseError(`未知字段类型 ${f.kind}`, path, start);
  }
}

// 解析匿名元素（数组成员 / choose 分支）
function parseElem(plan, elemPlan, st, br, ctx, path, structStart, env) {
  const start = br.pos;
  const name = path[path.length - 1];
  switch (elemPlan.kind) {
    case 'int': {
      const raw = br.readUInt(elemPlan.bits, st.endian, path);
      let v = raw;
      if (elemPlan.signed) {
        const signBit = 2 ** (elemPlan.bits - 1);
        if (v >= signBit) v -= 2 ** elemPlan.bits;
      }
      return { value: v, envValue: v, node: { name, kind: 'int', path, start, end: br.pos, value: v } };
    }
    case 'bytes': {
      const n = evalCount(elemPlan.count, env, path, start);
      const arr = br.readBytes(n, path);
      return {
        value: bytesToHex(arr), envValue: Array.from(arr),
        node: { name, kind: 'bytes', path, start, end: br.pos, value: bytesToHex(arr), meta: { count: n } },
      };
    }
    case 'struct': {
      const r = parseStruct(plan, elemPlan.struct, br, ctx, path, name);
      return {
        value: r.values, envValue: r.env,
        node: {
          name, kind: 'struct', path, start, end: br.pos,
          value: r.values, children: r.nodes, struct: elemPlan.struct,
        },
      };
    }
    default:
      throw new ParseError(`未知元素类型 ${elemPlan.kind}`, path, start);
  }
}

// 解析失败时，用未完成的帧栈拼出“最深成功路径”的部分树
function buildPartialTree(ctx, err) {
  const frames = ctx.frames;
  const errNode = {
    name: err.path.length ? err.path[err.path.length - 1] : '(error)',
    kind: 'error', path: err.path, start: err.bit, end: err.bit, error: err.message,
  };
  let node = errNode;
  for (let i = frames.length - 1; i >= 1; i--) {
    const f = frames[i];
    const ends = f.nodes.map((n) => n.end).concat([f.startBit, node.end]);
    node = {
      name: f.fieldName,
      kind: f.frameKind === 'array' ? 'array' : 'struct',
      struct: f.structName, path: f.path,
      start: f.startBit, end: Math.max(...ends),
      children: [...f.nodes, node], value: null,
    };
  }
  const rootFrame = frames[0];
  const tree = rootFrame ? [...rootFrame.nodes, node] : [node];
  const values = rootFrame ? rootFrame.values : {};
  return { nodes: tree, values };
}

function collectChecksumFailures(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.kind === 'checksum' && n.meta && !n.meta.ok) {
      out.push({ path: joinPath(n.path), algo: n.meta.algo, expected: n.meta.computed, actual: n.value });
    }
    if (n.children) collectChecksumFailures(n.children, out);
  }
  return out;
}

function parsePayload(plan, hex) {
  let bytes;
  try {
    bytes = hexToBytes(hex);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: { message: e.message, path: '', bit: 0 }, lengthBits: 0 };
    throw e;
  }
  const br = new BitReader(bytes);
  const ctx = { deepest: { bit: 0, path: null }, frames: [] };
  try {
    const r = parseStruct(plan, plan.root, br, ctx, [], plan.root);
    return {
      ok: true,
      values: r.values,
      tree: r.nodes,
      deepest: ctx.deepest,
      lengthBits: br.lengthBits,
      parsedBits: br.pos,
      trailingBytes: (br.lengthBits - br.pos) / 8,
      checksumFailures: collectChecksumFailures(r.nodes),
    };
  } catch (e) {
    if (e instanceof ParseError) {
      const partial = buildPartialTree(ctx, e);
      return {
        ok: false,
        error: { message: e.message, path: joinPath(e.path), bit: e.bit },
        deepest: ctx.deepest,
        partial: partial.nodes,
        values: partial.values,
        lengthBits: br.lengthBits,
      };
    }
    throw e;
  }
}

// ---------- 编码 ----------

function applyAlignWrite(bw, align, structStart) {
  if (!align) return;
  const target = alignedPos(bw.pos, structStart, align);
  if (target > bw.pos) bw.writeZeros(target - bw.pos);
}

function checkIntRange(value, bits, signed, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EncodeError(`字段 ${joinPath(path)} 的值必须是整数`, path);
  }
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const min = signed ? -(2 ** (bits - 1)) : 0;
  if (value < min || value > max) {
    throw new EncodeError(
      `整数字段 ${joinPath(path)} 溢出：值 ${value} 超出 ${signed ? 'i' : 'u'}${bits} 范围 [${min}, ${max}]`,
      path,
    );
  }
}

function hexToBytesStrict(hex, path) {
  if (typeof hex !== 'string') throw new EncodeError(`字段 ${joinPath(path)} 应为十六进制字符串`, path);
  try {
    return hexToBytes(hex);
  } catch (e) {
    throw new EncodeError(`字段 ${joinPath(path)} 的十六进制非法: ${e.message}`, path);
  }
}

function encodeStruct(plan, structName, values, bw, path, derived) {
  const st = plan.structs[structName];
  if (!st) throw new EncodeError(`未知结构体 '${structName}'`, path);
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new EncodeError(`结构体 ${joinPath(path) || structName} 的值应为对象`, path);
  }
  const structStart = bw.pos;
  const work = { ...values };

  // 预扫描：长度表达式为裸字段引用的数组/字节字段，用实际长度回填该前序字段。
  // 回填发生在任何字段写入之前，因此后续偏移全部基于新长度重新计算。
  for (const f of st.fields) {
    if ((f.kind === 'array' || f.kind === 'bytes') && f.countField) {
      const v = work[f.name];
      if (v === undefined) throw new EncodeError(`缺少字段 ${joinPath([...path, f.name])} 的值`, [...path, f.name]);
      let len;
      if (f.kind === 'bytes') {
        len = hexToBytesStrict(v, [...path, f.name]).length;
      } else {
        if (!Array.isArray(v)) {
          throw new EncodeError(`数组字段 ${joinPath([...path, f.name])} 的值应为数组`, [...path, f.name]);
        }
        len = v.length;
      }
      if (work[f.countField] !== len) {
        derived.push({ path: joinPath([...path, f.countField]), value: len, reason: `由 ${f.name} 的实际长度重算` });
        work[f.countField] = len;
      }
    }
  }

  const env = {};
  for (const f of st.fields) {
    applyAlignWrite(bw, f.align, structStart);
    const fpath = [...path, f.name];
    let v = work[f.name];
    if (v === undefined && f.kind !== 'checksum' && f.const === undefined) {
      throw new EncodeError(`缺少字段 ${joinPath(fpath)} 的值`, fpath);
    }
    env[f.name] = encodeField(plan, f, st, v, bw, fpath, structStart, env, derived);
  }
  return env;
}

function encodeField(plan, f, st, v, bw, path, structStart, env, derived) {
  switch (f.kind) {
    case 'int': {
      const value = f.const !== undefined ? f.const : v;
      if (f.const !== undefined && v !== undefined && v !== f.const) {
        derived.push({ path: joinPath(path), value: f.const, reason: '常量字段以声明值为准' });
      }
      checkIntRange(value, f.bits, f.signed, path);
      const raw = f.signed && value < 0 ? value + 2 ** f.bits : value;
      bw.writeUInt(raw, f.bits, st.endian);
      return value;
    }
    case 'bits': {
      if (v === null || typeof v !== 'object') {
        throw new EncodeError(`位域 ${joinPath(path)} 的值应为对象`, path);
      }
      let raw = 0;
      let cum = 0;
      for (const sub of f.fields) {
        const sv = v[sub.name];
        const spath = [...path, sub.name];
        checkIntRange(sv, sub.bits, false, spath);
        const shift = st.endian === 'be' ? f.bits - cum - sub.bits : cum;
        raw += sv * 2 ** shift;
        cum += sub.bits;
      }
      bw.writeUInt(raw, f.bits, st.endian);
      return v;
    }
    case 'bytes': {
      const arr = hexToBytesStrict(v, path);
      checkCountMatches(f.count, env, arr.length, path);
      bw.writeBytes(arr);
      return Array.from(arr);
    }
    case 'array': {
      if (!Array.isArray(v)) throw new EncodeError(`数组字段 ${joinPath(path)} 的值应为数组`, path);
      checkCountMatches(f.count, env, v.length, path);
      const envItems = [];
      for (let i = 0; i < v.length; i++) {
        const epath = [...path.slice(0, -1), `${f.name}[${i}]`];
        envItems.push(encodeElem(plan, f.elem, st, v[i], bw, epath, structStart, env, derived));
      }
      return envItems;
    }
    case 'struct':
      return encodeStruct(plan, f.struct, v, bw, path, derived);
    case 'choice': {
      let key;
      try {
        key = evalExpr(f.expr, env);
      } catch (e) {
        if (e instanceof ExprError) throw new EncodeError(`分支表达式求值失败: ${e.message}`, path);
        throw e;
      }
      let chosen = f.cases.find((c) => c.value === key);
      if (!chosen) {
        chosen = f.cases.find((c) => c.value === null);
        if (!chosen) {
          throw new EncodeError(`分支表达式值 ${key} 没有匹配的分支，且无默认分支`, path);
        }
      }
      return encodeElem(plan, chosen.type, st, v, bw, path, structStart, env, derived);
    }
    case 'checksum': {
      // 覆盖范围 = 所属结构体起点到本字段起点，全部已写入，顺序流即可计算
      const computed = computeChecksum(f.algo, bw.bytes, structStart / 8, bw.pos / 8);
      derived.push({ path: joinPath(path), value: computed, reason: `${f.algo} 校验重算` });
      bw.writeUInt(computed, f.bits, st.endian);
      return computed;
    }
    default:
      throw new EncodeError(`未知字段类型 ${f.kind}`, path);
  }
}

function checkCountMatches(countAst, env, actual, path) {
  let expect;
  try {
    expect = evalExpr(countAst, env);
  } catch (e) {
    if (e instanceof ExprError) throw new EncodeError(`长度表达式求值失败: ${e.message}`, path);
    throw e;
  }
  if (expect !== actual) {
    throw new EncodeError(
      `字段 ${joinPath(path)} 实际长度 ${actual} 与长度表达式结果 ${expect} 不一致`,
      path,
    );
  }
}

function encodeElem(plan, elemPlan, st, v, bw, path, structStart, env, derived) {
  switch (elemPlan.kind) {
    case 'int': {
      checkIntRange(v, elemPlan.bits, elemPlan.signed, path);
      const raw = elemPlan.signed && v < 0 ? v + 2 ** elemPlan.bits : v;
      bw.writeUInt(raw, elemPlan.bits, st.endian);
      return v;
    }
    case 'bytes': {
      const arr = hexToBytesStrict(v, path);
      checkCountMatches(elemPlan.count, env, arr.length, path);
      bw.writeBytes(arr);
      return Array.from(arr);
    }
    case 'struct':
      return encodeStruct(plan, elemPlan.struct, v, bw, path, derived);
    default:
      throw new EncodeError(`未知元素类型 ${elemPlan.kind}`, path);
  }
}

function encodePayload(plan, values) {
  const bw = new BitWriter();
  const derived = [];
  try {
    encodeStruct(plan, plan.root, values, bw, [], derived);
    return { ok: true, hex: bytesToHex(bw.toBytes()), derived };
  } catch (e) {
    if (e instanceof EncodeError) return { ok: false, error: { message: e.message, path: joinPath(e.path || []) } };
    if (e instanceof ExprError) return { ok: false, error: { message: e.message, path: null } };
    if (e instanceof ParseError) return { ok: false, error: { message: e.message, path: joinPath(e.path || []) } };
    throw e;
  }
}

module.exports = {
  ParseError, EncodeError,
  hexToBytes, bytesToHex,
  parsePayload, encodePayload,
};
