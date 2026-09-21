'use strict';

/* 二进制布局工作台前端：字段树 ↔ 字节网格双向定位，编辑后重编码并校验往返一致性 */

const DEFAULT_SCHEMA = `// 演示协议：常量、跨字节位域、动态数组、choose、对齐、crc16
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

const DEFAULT_HEX = 'abcd31aa020407d4fe08e803deadbeefcafe00000badcd3f';

const schemaEl = document.getElementById('schema');
const hexEl = document.getElementById('hex');
const treeEl = document.getElementById('tree');
const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const roundtripEl = document.getElementById('roundtrip');

schemaEl.value = DEFAULT_SCHEMA;
hexEl.value = DEFAULT_HEX;

const state = {
  plan: null, // 编译计划（用于数组元素模板）
  values: null, // 当前逻辑值（可被编辑）
  tree: [], // 最近一次解析的节点树
  lengthBits: 0,
  bytes: [],
  selected: null, // 选中节点路径（JSON 字符串）
  byteMap: new Map(), // 字节下标 -> 最深覆盖节点
  byteColor: [], // 字节下标 -> 顶层字段下标
};

// ---------- 工具 ----------

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function parseHex(text) {
  const clean = text.replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function segKey(seg) {
  const m = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
  return { name: m[1], index: m[2] !== undefined ? Number(m[2]) : null };
}

function getByPath(obj, pathArr) {
  let cur = obj;
  for (const seg of pathArr) {
    const { name, index } = segKey(seg);
    cur = cur?.[name];
    if (index !== null) cur = cur?.[index];
  }
  return cur;
}

function setByPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const { name, index } = segKey(pathArr[i]);
    cur = cur[name];
    if (index !== null) cur = cur[index];
  }
  const last = segKey(pathArr[pathArr.length - 1]);
  if (last.index !== null) cur[last.name][last.index] = value;
  else cur[last.name] = value;
}

function pathStr(pathArr) {
  return pathArr.join('.');
}

function walkNodes(nodes, fn, depth = 0) {
  for (const n of nodes || []) {
    fn(n, depth);
    if (n.children) walkNodes(n.children, fn, depth + 1);
  }
}

function fmtRange(n) {
  if (n.start === n.end) return `空 @B${n.start / 8}`;
  if (n.start % 8 === 0 && n.end % 8 === 0) {
    return `B${n.start / 8}..B${n.end / 8 - 1}`;
  }
  return `bit ${n.start}..${n.end - 1}`;
}

// ---------- 渲染：状态栏 ----------

function showStatus(html) {
  statusEl.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------- 渲染：字段树 ----------

function makeInput(node, value) {
  const input = document.createElement('input');
  if (node.kind === 'bytes') {
    input.type = 'text';
    input.className = 'bytes';
    input.value = value;
    input.placeholder = 'hex';
    input.addEventListener('change', () => {
      setByPath(state.values, node.path, input.value.trim());
      markDirty();
    });
  } else {
    input.type = 'number';
    input.value = value;
    input.addEventListener('change', () => {
      setByPath(state.values, node.path, Number(input.value));
      markDirty();
    });
  }
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

function markDirty() {
  roundtripEl.textContent = '已编辑，待重编码';
  roundtripEl.className = 'badge';
}

function renderNode(node, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'node';
  wrap.dataset.path = pathStr(node.path);
  if (node.kind === 'error') wrap.classList.add('errnode');
  if (state.selected === pathStr(node.path)) wrap.classList.add('sel');

  const row = document.createElement('div');
  row.className = 'row';
  row.addEventListener('click', () => selectNode(node));

  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = node.name;
  row.appendChild(name);

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = node.kind + (node.struct ? `<${node.struct}>` : '');
  row.appendChild(kind);

  const range = document.createElement('span');
  range.className = 'range';
  range.textContent = fmtRange(node);
  row.appendChild(range);

  // 值与编辑器
  if (node.kind === 'error') {
    const e = document.createElement('span');
    e.className = 'csfail';
    e.textContent = node.error;
    row.appendChild(e);
  } else if (node.kind === 'int' || node.kind === 'bitfield') {
    row.appendChild(makeInput(node, node.value));
  } else if (node.kind === 'bytes') {
    row.appendChild(makeInput(node, node.value));
    const meta = document.createElement('span');
    meta.className = 'kind';
    meta.textContent = `${node.meta?.count ?? 0}B`;
    row.appendChild(meta);
  } else if (node.kind === 'checksum') {
    row.appendChild(makeInput(node, node.value));
    const tag = document.createElement('span');
    if (node.meta && node.meta.ok === false) {
      tag.className = 'csfail';
      tag.textContent = `✗ ${node.meta.algo} 应为 ${node.meta.computed}`;
    } else {
      tag.className = 'csok';
      tag.textContent = `✓ ${node.meta?.algo ?? ''}（编码时自动重算）`;
    }
    row.appendChild(tag);
  } else if (node.kind === 'choice') {
    const tag = document.createElement('span');
    tag.className = 'caseinfo';
    tag.textContent = `case ${node.meta?.case} (expr=${node.meta?.exprValue})`;
    row.appendChild(tag);
  } else if (node.kind === 'array') {
    const tag = document.createElement('span');
    tag.className = 'kind';
    tag.textContent = `[${node.meta?.count ?? node.children?.length ?? 0}]`;
    row.appendChild(tag);
    row.appendChild(arrayButton(node, +1));
    row.appendChild(arrayButton(node, -1));
  } else if (node.kind === 'pad') {
    // 仅展示
  }

  wrap.appendChild(row);
  if (node.children && node.children.length) {
    const kids = document.createElement('div');
    kids.className = 'kids';
    for (const c of node.children) kids.appendChild(renderNode(c, depth + 1));
    wrap.appendChild(kids);
  }
  return wrap;
}

function arrayButton(node, delta) {
  const btn = document.createElement('button');
  btn.className = 'arrbtn';
  btn.textContent = delta > 0 ? '+' : '−';
  btn.title = delta > 0 ? '追加元素（自动重编码）' : '移除末尾元素（自动重编码）';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const arr = getByPath(state.values, node.path);
    if (!Array.isArray(arr)) return;
    if (delta > 0) {
      const fp = resolveFieldPlan(node.path);
      if (!fp || fp.kind !== 'array') return;
      arr.push(templateFor(fp.elem));
    } else {
      arr.pop();
    }
    await doEncode(); // 结构变化 → 立即重编码+重解析，偏移全部重算
  });
  return btn;
}

// 在编译计划中按路径定位字段计划（用于数组元素模板）
function resolveFieldPlan(pathArr) {
  if (!state.plan) return null;
  let fields = state.plan.structs[state.plan.root].fields;
  let fp = null;
  for (const seg of pathArr) {
    const { name } = segKey(seg);
    fp = (fields || []).find((f) => f.name === name);
    if (!fp) return null;
    if (fp.kind === 'struct') fields = state.plan.structs[fp.struct].fields;
    else if (fp.kind === 'array' && fp.elem.kind === 'struct') fields = state.plan.structs[fp.elem.struct].fields;
    else fields = null;
  }
  return fp;
}

function templateFor(fp) {
  switch (fp.kind) {
    case 'int': return fp.const ?? 0;
    case 'bits': return Object.fromEntries(fp.fields.map((s) => [s.name, 0]));
    case 'bytes': return '';
    case 'array': return [];
    case 'struct':
      return Object.fromEntries(state.plan.structs[fp.struct].fields.map((f) => [f.name, templateFor(f)]));
    case 'checksum': return 0;
    case 'choice': return templateFor(fp.cases[0].type);
    default: return 0;
  }
}

function renderTree() {
  treeEl.innerHTML = '';
  for (const n of state.tree) treeEl.appendChild(renderNode(n, 0));
}

// ---------- 渲染：字节网格 ----------

function buildByteIndex() {
  state.byteMap.clear();
  state.byteColor = new Array(state.bytes.length).fill(-1);
  const top = state.tree;
  top.forEach((node, ti) => {
    walkNodes([node], (n) => {
      const from = Math.floor(n.start / 8);
      const to = Math.ceil(n.end / 8);
      for (let b = from; b < to && b < state.bytes.length; b++) {
        state.byteColor[b] = ti;
        const cur = state.byteMap.get(b);
        if (!cur || n.path.length >= cur.path.length) state.byteMap.set(b, n);
      }
    });
  });
}

function renderGrid() {
  gridEl.innerHTML = '';
  const perRow = 16;
  for (let base = 0; base < state.bytes.length; base += perRow) {
    const row = document.createElement('div');
    row.className = 'grow-row';
    const off = document.createElement('span');
    off.className = 'goff';
    off.textContent = base.toString(16).padStart(8, '0');
    row.appendChild(off);
    for (let i = base; i < Math.min(base + perRow, state.bytes.length); i++) {
      const b = document.createElement('span');
      b.className = 'byte ' + (state.byteColor[i] >= 0 ? `c${state.byteColor[i] % 12}` : 'none');
      b.dataset.idx = i;
      b.textContent = state.bytes[i].toString(16).padStart(2, '0');
      const owner = state.byteMap.get(i);
      b.title = owner ? `B${i} · ${pathStr(owner.path)}` : `B${i} · (未覆盖)`;
      b.addEventListener('click', () => {
        const n = state.byteMap.get(i);
        if (n) selectNode(n, true);
      });
      row.appendChild(b);
    }
    gridEl.appendChild(row);
  }
}

function highlightSelection() {
  gridEl.querySelectorAll('.byte.sel').forEach((el) => el.classList.remove('sel'));
  treeEl.querySelectorAll('.node.sel').forEach((el) => el.classList.remove('sel'));
  if (!state.selected) return;
  const node = findNode(state.tree, state.selected.split('.'));
  if (!node) return;
  const from = Math.floor(node.start / 8);
  const to = Math.ceil(node.end / 8);
  for (let b = from; b < to && b < state.bytes.length; b++) {
    const el = gridEl.querySelector(`.byte[data-idx="${b}"]`);
    if (el) el.classList.add('sel');
  }
  const treeRow = treeEl.querySelector(`.node[data-path="${CSS.escape(state.selected)}"]`);
  if (treeRow) {
    treeRow.classList.add('sel');
    treeRow.scrollIntoView({ block: 'nearest' });
  }
  const firstByte = gridEl.querySelector(`.byte[data-idx="${from}"]`);
  if (firstByte) firstByte.scrollIntoView({ block: 'nearest' });
}

function findNode(nodes, pathArr) {
  for (const n of nodes || []) {
    if (pathStr(n.path) === pathArr.join('.')) return n;
    const found = findNode(n.children, pathArr);
    if (found) return found;
  }
  return null;
}

function selectNode(node) {
  state.selected = pathStr(node.path);
  highlightSelection();
}

// ---------- 解析 / 编码 ----------

async function doParse() {
  roundtripEl.textContent = '';
  // 同步刷新编译计划（数组元素模板依赖它）
  const c = await post('/api/compile', { schema: schemaEl.value });
  state.plan = c.ok ? c.plan : null;
  const res = await post('/api/parse', { schema: schemaEl.value, hex: hexEl.value });
  state.bytes = parseHex(hexEl.value);
  state.lengthBits = res.lengthBits ?? state.bytes.length * 8;
  state.selected = null;

  if (res.compileErrors) {
    state.tree = [];
    state.values = null;
    renderTree();
    renderGrid();
    showStatus(`<span class="err">编译失败：</span>\n` + res.compileErrors.map((e) => '  · ' + esc(e)).join('\n'));
    return;
  }

  if (res.ok) {
    state.tree = res.tree;
    state.values = res.values;
    const parts = [`<span class="ok">解析成功</span>：${res.parsedBits / 8}/${res.lengthBits / 8} 字节`];
    if (res.trailingBytes > 0) parts.push(`<span class="warn">尾随 ${res.trailingBytes} 字节未消费</span>`);
    for (const f of res.checksumFailures || []) {
      parts.push(`<span class="err">校验失败 ${esc(f.path)}：${f.algo} 应为 ${f.expected}，实际 ${f.actual}</span>`);
    }
    showStatus(parts.join('\n'));
  } else {
    state.tree = res.partial || [];
    state.values = res.values || null;
    const deep = res.deepest && res.deepest.path
      ? `最深成功：${esc(res.deepest.path.join('.'))} @B${res.deepest.bit / 8}`
      : '最深成功：起点';
    showStatus(
      `<span class="err">解析失败：${esc(res.error.message)}</span>\n` +
      `位置：${esc(res.error.path || '(root)')} @B${Math.floor(res.error.bit / 8)}\n` +
      deep + '\n<span class="warn">已显示部分树（红色为失败点），可修复后重试</span>',
    );
  }
  buildByteIndex();
  renderTree();
  renderGrid();
}

function diffValues(a, b, base, ignore, out) {
  const p = base.join('.');
  if (ignore.has(p)) return;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (!aObj || !bObj) {
    if (a !== b) out.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${p}: 类型不一致`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { out.push(`${p}: 长度 ${a.length} → ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) {
      const seg = base.slice();
      seg[seg.length - 1] = `${seg[seg.length - 1]}[${i}]`;
      diffValues(a[i], b[i], seg, ignore, out);
    }
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffValues(a[k], b[k], [...base, k], ignore, out);
  }
}

async function doEncode() {
  if (!state.values) {
    showStatus('<span class="err">没有可编码的值（先成功解析）</span>');
    return;
  }
  const before = JSON.parse(JSON.stringify(state.values));
  const res = await post('/api/encode', { schema: schemaEl.value, values: state.values });
  if (res.compileErrors) {
    showStatus(`<span class="err">编译失败：</span>\n` + res.compileErrors.map((e) => '  · ' + esc(e)).join('\n'));
    return;
  }
  if (!res.ok) {
    showStatus(`<span class="err">编码失败：${esc(res.error.message)}</span>${res.error.path ? `\n位置：${esc(res.error.path)}` : ''}`);
    roundtripEl.textContent = '编码失败';
    roundtripEl.className = 'badge err';
    return;
  }
  hexEl.value = res.hex;
  await doParse();
  // 往返一致性：重解析后的逻辑值应与编辑值一致（派生字段除外）
  const ignore = new Set((res.derived || []).map((d) => d.path));
  const diffs = [];
  if (state.values) {
    const rootKeys = Object.keys(before);
    for (const k of rootKeys) diffValues({ [k]: before[k] }, { [k]: state.values[k] }, [k], ignore, diffs);
  }
  const derivedNote = (res.derived || []).map((d) => `<span class="derived">重算 ${esc(d.path)} = ${d.value}（${esc(d.reason)}）</span>`);
  if (diffs.length === 0) {
    roundtripEl.textContent = '往返一致 ✓';
    roundtripEl.className = 'badge ok';
  } else {
    roundtripEl.textContent = `往返差异 ${diffs.length} 处`;
    roundtripEl.className = 'badge err';
    diffs.slice(0, 5).forEach((d) => derivedNote.push(`<span class="err">差异 ${esc(d)}</span>`));
  }
  if (derivedNote.length) showStatus((statusEl.innerHTML ? statusEl.innerHTML + '\n' : '') + derivedNote.join('\n'));
}

// ---------- 启动 ----------

async function boot() {
  document.getElementById('btn-parse').addEventListener('click', doParse);
  document.getElementById('btn-encode').addEventListener('click', doEncode);
  await doParse();
}

boot();
