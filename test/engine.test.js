'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSchema } = require('../src/dsl');
const { compileSchema } = require('../src/compiler');
const { parsePayload, encodePayload, hexToBytes } = require('../src/runtime');

const DEMO_SCHEMA = `
struct Item le {
  id: u8;
  score: i16;
}

struct Packet be {
  magic:  u16 = 0xABCD;
  hdr:    u16 { version: 4, type: 4, flags: 8 };
  count:  u8;
  length: u8;
  items:  Item[count];
  payload: bytes[length];
  body:   choose (hdr.type) {
    1: u16;
    2: bytes[2];
    _: u8;
  };
  tail:   u16 align(4);
  crc:    crc16;
}
`;

function compile(text) {
  const plan = compileSchema(parseSchema(text));
  assert.deepEqual(plan.errors, [], `编译不应有错误: ${plan.errors.join('; ')}`);
  return plan;
}

function compileErrors(text) {
  return compileSchema(parseSchema(text)).errors;
}

// 收集树中所有节点（先序）
function walk(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children) walk(n.children, out);
  }
  return out;
}

// ---------- 位域 ----------

test('跨字节位域：be 容器 9+7 位，首字段横跨两个字节', () => {
  const plan = compile('struct H be { a: u8; w: u16 { hi: 9, lo: 7 }; }');
  const r = parsePayload(plan, 'ffb93d');
  assert.equal(r.ok, true);
  assert.equal(r.values.a, 0xff);
  assert.equal(r.values.w.hi, 370); // 高 9 位，横跨字节边界
  assert.equal(r.values.w.lo, 61);
  const w = r.tree.find((n) => n.name === 'w');
  const hi = w.children.find((n) => n.name === 'hi');
  const lo = w.children.find((n) => n.name === 'lo');
  assert.equal(hi.end - hi.start, 9);
  assert.equal(hi.start, 8); // 紧跟 a 之后
  assert.ok(hi.start < 16 && hi.end > 16, 'hi 必须跨越字节边界');
  assert.equal(lo.start, 17);
  assert.equal(lo.end, 24);
});

test('跨字节位域：le 容器从低位起排', () => {
  const plan = compile('struct H le { w: u16 { hi: 9, lo: 7 }; }');
  const r = parsePayload(plan, 'b93d');
  assert.equal(r.ok, true);
  assert.equal(r.values.w.hi, 441); // 低 9 位：0x3DB9 & 0x1FF
  assert.equal(r.values.w.lo, 30);
});

test('位域编码与解析互逆（跨字节）', () => {
  const plan = compile('struct H be { w: u16 { hi: 9, lo: 7 }; }');
  const e = encodePayload(plan, { w: { hi: 300, lo: 100 } });
  assert.equal(e.ok, true);
  const r = parsePayload(plan, e.hex);
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { w: { hi: 300, lo: 100 } });
});

// ---------- 数组 / 零长度 ----------

test('零长度数组：范围为空且不越界', () => {
  const plan = compile('struct A be { n: u8; items: u8[n]; tail: u8; }');
  const r = parsePayload(plan, '002a');
  assert.equal(r.ok, true);
  assert.deepEqual(r.values.items, []);
  const items = r.tree.find((n) => n.name === 'items');
  assert.equal(items.start, items.end);
  assert.equal(items.start, 8);
  assert.equal(r.values.tail, 0x2a);
});

test('表达式长度数组：n * 2', () => {
  const plan = compile('struct A be { n: u8; data: u8[n * 2]; }');
  const r = parsePayload(plan, '0201020304');
  assert.equal(r.ok, true);
  assert.deepEqual(r.values.data, [1, 2, 3, 4]);
});

// ---------- 联合分支 ----------

test('choose 分支：按前字段值选择，含默认分支', () => {
  const schema = `
    struct P be {
      t: u8;
      body: choose (t) {
        1: u16;
        2: bytes[2];
        _: u8;
      };
    }`;
  const plan = compile(schema);
  const r1 = parsePayload(plan, '010123');
  assert.equal(r1.values.body, 0x0123);
  assert.equal(r1.tree[1].meta.case, 1);
  const r2 = parsePayload(plan, '02aabb');
  assert.equal(r2.values.body, 'aabb');
  const r3 = parsePayload(plan, '09ff');
  assert.equal(r3.values.body, 0xff);
  assert.equal(r3.tree[1].meta.case, '_');
});

test('choose 无匹配分支且无默认分支 → 解析失败并报路径', () => {
  const plan = compile('struct P be { t: u8; body: choose (t) { 1: u8; }; }');
  const r = parsePayload(plan, '0700');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /没有匹配的分支/);
  assert.equal(r.error.path, 'body');
});

// ---------- 填充 / 对齐 ----------

test('align(4) 产生填充节点，偏移按结构体起点对齐', () => {
  const plan = compile('struct A be { a: u8; b: u16 align(4); c: u8; }');
  const r = parsePayload(plan, '01000000000203');
  assert.equal(r.ok, true);
  const pad = r.tree.find((n) => n.kind === 'pad');
  assert.ok(pad, '应有填充节点');
  assert.equal(pad.start, 8);
  assert.equal(pad.end, 32); // 填充 3 字节
  const b = r.tree.find((n) => n.name === 'b');
  assert.equal(b.start, 32);
  assert.equal(r.values.b, 2);
  assert.equal(r.values.c, 3);
});

test('编码时对齐写入零填充', () => {
  const plan = compile('struct A be { a: u8; b: u16 align(4); }');
  const e = encodePayload(plan, { a: 1, b: 0x0203 });
  assert.equal(e.ok, true);
  assert.equal(e.hex, '010000000203');
});

// ---------- 截断与最深成功路径 ----------

test('截断：返回最深成功路径与部分树', () => {
  const plan = compile(DEMO_SCHEMA);
  // 完整包：magic(2) hdr(2) count(1)=2 length(1)=0 items(2*3=6) body(1) pad+tail(4) crc(2)
  const values = {
    magic: 0xabcd,
    hdr: { version: 1, type: 9, flags: 0 },
    count: 2,
    length: 0,
    items: [{ id: 1, score: -2 }, { id: 3, score: 4 }],
    payload: '',
    body: 7,
    tail: 0,
    crc: 0,
  };
  const enc = encodePayload(plan, values);
  assert.equal(enc.ok, true);
  const bytes = hexToBytes(enc.hex);
  // 截断到第二个 item 的中间：头部 6 字节 + 第一个 item 3 字节 + 第二个 item 1 字节
  const cut = bytes.slice(0, 10);
  const r = parsePayload(plan, enc.hex.slice(0, 20));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /截断/);
  assert.equal(r.error.path, 'items[1].score');
  // 最深成功路径 = items[1].id 结束处（第 10 字节）
  assert.equal(r.deepest.bit, 10 * 8);
  // 部分树包含已完成的字段
  const names = r.partial.map((n) => n.name);
  assert.deepEqual(names.slice(0, 4), ['magic', 'hdr', 'count', 'length']);
  const items = r.partial.find((n) => n.name === 'items');
  assert.equal(items.children.length, 2); // 一个完整 + 一个出错的
  const bad = walk(r.partial).find((n) => n.kind === 'error');
  assert.ok(bad, '部分树中应有错误节点');
  assert.equal(bad.start, cut.length * 8);
});

test('常量不匹配：解析失败并定位到该字段', () => {
  const plan = compile(DEMO_SCHEMA);
  const r = parsePayload(plan, '0000' + '00'.repeat(20));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /常量不匹配/);
  assert.equal(r.error.path, 'magic');
});

// ---------- 整数溢出 ----------

test('编码时整数溢出被拒绝', () => {
  const plan = compile('struct A be { a: u8; b: i8; c: u16; }');
  const e1 = encodePayload(plan, { a: 300, b: 0, c: 0 });
  assert.equal(e1.ok, false);
  assert.match(e1.error.message, /溢出/);
  assert.equal(e1.error.path, 'a');
  const e2 = encodePayload(plan, { a: 0, b: -129, c: 0 });
  assert.equal(e2.ok, false);
  assert.match(e2.error.message, /溢出/);
  const e3 = encodePayload(plan, { a: 0, b: 127, c: 65535 });
  assert.equal(e3.ok, true);
});

test('位域子字段溢出被拒绝', () => {
  const plan = compile('struct H be { w: u8 { a: 3, b: 5 }; }');
  const e = encodePayload(plan, { w: { a: 8, b: 0 } });
  assert.equal(e.ok, false);
  assert.match(e.error.message, /溢出/);
});

// ---------- 校验 ----------

test('校验失败被标记，重编码后恢复', () => {
  const plan = compile(DEMO_SCHEMA);
  const values = {
    magic: 0xabcd,
    hdr: { version: 2, type: 1, flags: 3 },
    count: 0,
    length: 2,
    items: [],
    payload: 'aabb',
    body: 0x0102,
    tail: 0,
    crc: 0,
  };
  const enc = encodePayload(plan, values);
  assert.equal(enc.ok, true);
  const good = parsePayload(plan, enc.hex);
  assert.equal(good.ok, true);
  assert.equal(good.checksumFailures.length, 0);
  // 破坏 crc 最后一个字节
  const badHex = enc.hex.slice(0, -2) + (enc.hex.endsWith('00') ? '01' : '00');
  const bad = parsePayload(plan, badHex);
  assert.equal(bad.ok, true, '校验失败不应中断解析');
  assert.equal(bad.checksumFailures.length, 1);
  assert.equal(bad.checksumFailures[0].path, 'crc');
  // 用解析出的值重编码 → 校验被重算，再次解析无失败
  const re = encodePayload(plan, bad.values);
  assert.equal(re.ok, true);
  assert.ok(re.derived.some((d) => d.path === 'crc'));
  const fixed = parsePayload(plan, re.hex);
  assert.equal(fixed.checksumFailures.length, 0);
});

// ---------- 嵌套结构 ----------

test('嵌套结构体与结构体数组，各自端序独立', () => {
  const plan = compile(DEMO_SCHEMA);
  const values = {
    magic: 0xabcd,
    hdr: { version: 1, type: 2, flags: 0xaa },
    count: 2,
    length: 1,
    items: [{ id: 7, score: -300 }, { id: 8, score: 1000 }],
    payload: 'ff',
    body: 'beef',
    tail: 0x1234,
    crc: 0,
  };
  const enc = encodePayload(plan, values);
  assert.equal(enc.ok, true);
  const r = parsePayload(plan, enc.hex);
  assert.equal(r.ok, true);
  assert.deepEqual(r.values.items, values.items);
  assert.deepEqual(r.values.hdr, values.hdr);
  // Item 是 le：score=-300 → 0xFED4 → 字节 d4 fe
  const hex = enc.hex;
  const item0 = hex.slice(12, 18); // 第 6 字节起
  assert.equal(item0, '07d4fe');
});

// ---------- 编译期检查 ----------

test('前向引用在编译期被拒绝', () => {
  const errors = compileErrors('struct A be { a: u8[b]; b: u8; }');
  assert.ok(errors.some((e) => e.includes('前向引用')), errors.join(';'));
});

test('choose 表达式中的前向引用在编译期被拒绝', () => {
  const errors = compileErrors('struct A be { x: choose (later) { _: u8; }; later: u8; }');
  assert.ok(errors.some((e) => e.includes('前向引用')), errors.join(';'));
});

test('无界递归在编译期被拒绝，可空递归被允许', () => {
  const bad = compileErrors('struct Node be { v: u8; next: Node; }');
  assert.ok(bad.some((e) => e.includes('无界递归')), bad.join(';'));
  const bad2 = compileErrors('struct A be { b: B; } struct B be { a: A; }');
  assert.ok(bad2.some((e) => e.includes('无界递归')), bad2.join(';'));
  // 经过数组（计数可为 0）的递归是可行的
  const good = compileErrors('struct N be { n: u8; kids: N[n]; }');
  assert.deepEqual(good, []);
  // 经过 choose 的递归也可行
  const good2 = compileErrors('struct T be { tag: u8; next: choose (tag) { 0: u8; _: T; }; }');
  assert.deepEqual(good2, []);
});

test('位域总宽超限、重复字段、未知结构体在编译期被拒绝', () => {
  assert.ok(compileErrors('struct A be { w: u8 { a: 5, b: 4 }; }').some((e) => e.includes('总宽')));
  assert.ok(compileErrors('struct A be { x: u8; x: u8; }').some((e) => e.includes('重复')));
  assert.ok(compileErrors('struct A be { x: Missing; }').some((e) => e.includes('未知结构体')));
});

// ---------- 往返一致性 ----------

test('编码→解析 得到同一逻辑值（含全部特性）', () => {
  const plan = compile(DEMO_SCHEMA);
  const seed = {
    magic: 0xabcd,
    hdr: { version: 15, type: 1, flags: 200 },
    count: 3,
    length: 4,
    items: [{ id: 1, score: -1 }, { id: 2, score: 0 }, { id: 3, score: 32767 }],
    payload: 'deadbeef',
    body: 0xcafe,
    tail: 0x0bad,
    crc: 0,
  };
  const e1 = encodePayload(plan, seed);
  assert.equal(e1.ok, true);
  const p1 = parsePayload(plan, e1.hex);
  assert.equal(p1.ok, true);
  const e2 = encodePayload(plan, p1.values);
  assert.equal(e2.ok, true);
  assert.equal(e2.hex, e1.hex, '再次编码应得到相同字节');
  const p2 = parsePayload(plan, e2.hex);
  assert.equal(p2.ok, true);
  assert.deepEqual(p2.values, p1.values, '编码再解析应得到同一逻辑值');
});

// ---------- 范围不越界 ----------

test('所有节点范围都在输入范围内（含截断的部分树）', () => {
  const plan = compile(DEMO_SCHEMA);
  const values = {
    magic: 0xabcd, hdr: { version: 1, type: 0, flags: 0 },
    count: 2, length: 3,
    items: [{ id: 1, score: 1 }, { id: 2, score: 2 }],
    payload: '010203', body: 5, tail: 0, crc: 0,
  };
  const enc = encodePayload(plan, values);
  const full = parsePayload(plan, enc.hex);
  assert.equal(full.ok, true);
  for (const n of walk(full.tree)) {
    assert.ok(n.start >= 0 && n.start <= n.end && n.end <= full.lengthBits,
      `节点 ${n.path.join('.')} 范围越界`);
  }
  const truncated = parsePayload(plan, enc.hex.slice(0, 14));
  assert.equal(truncated.ok, false);
  for (const n of walk(truncated.partial)) {
    assert.ok(n.start >= 0 && n.start <= n.end && n.end <= truncated.lengthBits,
      `部分树节点 ${n.path.join('.')} 范围越界`);
  }
});

// ---------- 编辑后重算（不复用旧偏移） ----------

test('编辑数组/字节长度后重编码：长度字段与校验重算，后续偏移整体移动', () => {
  const plan = compile(DEMO_SCHEMA);
  const seed = {
    magic: 0xabcd, hdr: { version: 1, type: 0, flags: 0 },
    count: 1, length: 1,
    items: [{ id: 9, score: 9 }],
    payload: 'aa', body: 1, tail: 0, crc: 0,
  };
  const e1 = encodePayload(plan, seed);
  const p1 = parsePayload(plan, e1.hex);
  const crcBefore = walk(p1.tree).find((n) => n.name === 'crc');

  // 编辑：items 增加一个元素，payload 加长 3 字节
  const edited = JSON.parse(JSON.stringify(p1.values));
  edited.items.push({ id: 10, score: 10 });
  edited.payload = 'aabbccdd';
  const e2 = encodePayload(plan, edited);
  assert.equal(e2.ok, true);
  // 派生重算：count、length、crc
  const derivedPaths = e2.derived.map((d) => d.path);
  assert.ok(derivedPaths.includes('count'));
  assert.ok(derivedPaths.includes('length'));
  assert.ok(derivedPaths.includes('crc'));

  const p2 = parsePayload(plan, e2.hex);
  assert.equal(p2.ok, true);
  assert.equal(p2.values.count, 2);
  assert.equal(p2.values.length, 4);
  assert.deepEqual(p2.values.items, edited.items);
  assert.equal(p2.values.payload, 'aabbccdd');
  const crcAfter = walk(p2.tree).find((n) => n.name === 'crc');
  // 偏移整体后移：+1 个 item(3 字节) +3 字节 payload，再经 align(4) 圆整 = 8 字节
  assert.equal(crcAfter.start - crcBefore.start, 8 * 8);
  assert.equal(p2.checksumFailures.length, 0);
});

test('长度表达式非裸引用时，不一致的编辑被拒绝', () => {
  const plan = compile('struct A be { n: u8; data: u8[n + 1]; }');
  const e = encodePayload(plan, { n: 1, data: [1, 2, 3] }); // n+1=2 ≠ 3
  assert.equal(e.ok, false);
  assert.match(e.error.message, /不一致/);
});

// ---------- 其他 ----------

test('尾随字节被报告但不视为错误', () => {
  const plan = compile('struct A be { a: u8; }');
  const r = parsePayload(plan, '01020304');
  assert.equal(r.ok, true);
  assert.equal(r.trailingBytes, 3);
});

test('len() 引用此前数组字段', () => {
  const plan = compile('struct A be { n: u8; data: u8[n]; total: u8; check: choose (len(data) == total) { 1: u8; _: u16; }; }');
  const r = parsePayload(plan, '02010202ff');
  assert.equal(r.ok, true);
  assert.equal(r.values.check, 0xff);
});

test('有符号整数解析与编码', () => {
  const plan = compile('struct A be { a: i8; b: i16; c: i32; }');
  const e = encodePayload(plan, { a: -1, b: -2, c: -2147483648 });
  assert.equal(e.ok, true);
  const r = parsePayload(plan, e.hex);
  assert.deepEqual(r.values, { a: -1, b: -2, c: -2147483648 });
});

test('空输入解析空结构体', () => {
  const plan = compile('struct A be { }');
  const r = parsePayload(plan, '');
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, {});
});
