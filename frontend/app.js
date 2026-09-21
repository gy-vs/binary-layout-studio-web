"use strict";

const $ = (s) => document.querySelector(s);

const state = {
  tree: null,
  values: null,
  hex: "",
  length: 0,
  nodes: [],        // {node, el, path}
  byteEls: [],
  selected: -1,
  collapsed: new Set(),   // 以路径字符串为键
};

/* ---------------- 工具 ---------------- */

function getPath(obj, path) {
  for (const seg of path) {
    if (obj == null) return undefined;
    obj = seg.startsWith("[") ? obj[parseInt(seg.slice(1, -1), 10)] : obj[seg];
  }
  return obj;
}

function setPath(obj, path, v) {
  const last = path[path.length - 1];
  const parent = getPath(obj, path.slice(0, -1));
  if (last.startsWith("[")) parent[parseInt(last.slice(1, -1), 10)] = v;
  else parent[last] = v;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

function parseNum(s) {
  s = String(s).trim();
  let neg = false;
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  let v;
  if (/^0x[0-9a-f]+$/i.test(s)) v = parseInt(s, 16);
  else if (/^[0-9]+$/.test(s)) v = parseInt(s, 10);
  else return null;
  return neg ? -v : v;
}

function fmtNum(v) {
  if (typeof v !== "number") return String(v);
  if (v < 0) return `${v}`;
  return v > 9 ? `${v} (0x${v.toString(16).toUpperCase()})` : `${v}`;
}

function cleanHex(text) {
  return text.replace(/0x/gi, "").replace(/[\s,，、]+/g, "");
}

function hexToBytes(hex) {
  const c = cleanHex(hex);
  const out = [];
  for (let i = 0; i + 1 < c.length; i += 2) out.push(parseInt(c.substr(i, 2), 16));
  return out;
}

function fmtHexText(hex) {
  const b = hexToBytes(hex);
  const rows = [];
  for (let i = 0; i < b.length; i += 16)
    rows.push(b.slice(i, i + 16).map((x) => x.toString(16).padStart(2, "0")).join(" "));
  return rows.join("\n");
}

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/* ---------------- 字段树 ---------------- */

const KIND_LABEL = {
  struct: "struct", int: "int", bits: "bits", bit: "bit", array: "array",
  bytes: "bytes", choice: "choice", checksum: "crc", pad: "pad", let: "let",
};

function renderTree() {
  const host = $("#tree");
  host.innerHTML = "";
  state.nodes = [];
  if (!state.tree) {
    host.innerHTML = '<div class="empty">尚无解析结果 — 点击「解析」</div>';
    return;
  }
  host.appendChild(treeNode(state.tree, [], true));
}

function rangeText(n) {
  if (n.bit_start === n.bit_end) return `@${n.byte_start}`;
  if (n.bit_start % 8 === 0 && n.bit_end % 8 === 0)
    return `[${n.byte_start}, ${n.byte_end})`;
  return `[${n.byte_start}, ${n.byte_end}) 位${n.bit_start}..${n.bit_end}`;
}

function treeNode(node, path, isRoot) {
  const wrap = document.createElement("div");
  wrap.className = "tnode" + (isRoot ? " root" : "");
  const uid = state.nodes.length;
  const pathKey = path.join("/");

  const line = document.createElement("div");
  line.className = "tline" + (node.error ? " err" : "");
  state.nodes.push({ node, el: line, path });
  line.addEventListener("click", (ev) => {
    if (ev.target.closest("input,select,button")) return;
    selectNode(uid);
  });

  const kids = node.children || [];
  const tog = document.createElement("span");
  tog.className = "toggle";
  if (kids.length) {
    const open = !state.collapsed.has(pathKey);
    tog.textContent = open ? "▾" : "▸";
    tog.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.collapsed.has(pathKey)) state.collapsed.delete(pathKey);
      else state.collapsed.add(pathKey);
      kidsEl.style.display = state.collapsed.has(pathKey) ? "none" : "";
      tog.textContent = state.collapsed.has(pathKey) ? "▸" : "▾";
    });
  }
  line.appendChild(tog);

  const nm = document.createElement("span");
  nm.className = "tname";
  nm.textContent = node.name;
  line.appendChild(nm);

  const kd = document.createElement("span");
  kd.className = "tkind";
  kd.textContent = KIND_LABEL[node.kind] || node.kind;
  line.appendChild(kd);

  const rg = document.createElement("span");
  rg.className = "trange";
  rg.textContent = rangeText(node);
  line.appendChild(rg);

  appendValueEditor(line, node, path);

  if (node.error) {
    const er = document.createElement("span");
    er.className = "terr";
    er.textContent = "⚠ " + node.error;
    line.appendChild(er);
  }

  wrap.appendChild(line);
  const kidsEl = document.createElement("div");
  if (state.collapsed.has(pathKey)) kidsEl.style.display = "none";
  for (const c of kids) kidsEl.appendChild(treeNode(c, childPath(node, path, c), false));
  wrap.appendChild(kidsEl);
  return wrap;
}

function childPath(node, path, child) {
  // 容器节点的子节点值路径 = 本节点路径 + 子节点名（数组子节点名为 "[i]"）
  return [...path, child.name];
}

function appendValueEditor(line, node, path) {
  const k = node.kind;
  if (k === "int" || k === "bit" || k === "checksum") {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = node.value;
    inp.title = "十进制或 0x 十六进制";
    inp.addEventListener("change", () => {
      const v = parseNum(inp.value);
      if (v === null) { inp.value = getPath(state.values, path); return; }
      setPath(state.values, path, v);
      inp.value = v;
    });
    line.appendChild(inp);
    if (k === "checksum" && node.checksum) {
      const b = document.createElement("span");
      const c = node.checksum;
      b.className = c.ok ? "badge-ok" : "badge-bad";
      b.textContent = c.ok ? `✓ ${c.algo}` : `✗ ${c.algo} 应为 ${c.computed}`;
      b.title = `存储 ${c.stored} / 计算 ${c.computed}`;
      line.appendChild(b);
    }
    return;
  }
  if (k === "let") {
    const s = document.createElement("span");
    s.className = "tval";
    s.textContent = "= " + fmtNum(node.value);
    line.appendChild(s);
    return;
  }
  if (k === "bytes") {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.style.width = "220px";
    inp.value = node.value || "";
    inp.placeholder = "十六进制";
    inp.addEventListener("change", () => {
      const c = cleanHex(inp.value);
      if (c.length % 2 || /[^0-9a-f]/i.test(c)) { inp.value = getPath(state.values, path); return; }
      setPath(state.values, path, c);
      inp.value = c;
    });
    line.appendChild(inp);
    return;
  }
  if (k === "pad") {
    const s = document.createElement("span");
    s.className = "tinfo";
    s.textContent = node.info || "";
    line.appendChild(s);
    return;
  }
  if (k === "array") {
    const s = document.createElement("span");
    s.className = "tinfo";
    s.textContent = `[${node.count != null ? node.count : (node.children || []).length}]`;
    line.appendChild(s);
    const mk = (txt, title, fn) => {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = txt;
      b.title = title;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
      line.appendChild(b);
    };
    mk("+", "追加元素并重新编码", () => {
      const arr = getPath(state.values, path);
      arr.push(clone(node.template !== undefined ? node.template
        : (arr.length ? arr[arr.length - 1] : 0)));
      doEncode();
    });
    mk("−", "移除末元素并重新编码", () => {
      const arr = getPath(state.values, path);
      if (arr.length) arr.pop();
      doEncode();
    });
    return;
  }
  if (k === "choice") {
    const sel = document.createElement("select");
    for (const opt of node.options || []) {
      const o = document.createElement("option");
      o.value = String(opt);
      o.textContent = opt === "default" ? "default" : `case ${opt}`;
      if (String(node.case) === String(opt)) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      const opt = sel.value;
      const tpl = clone((node.templates || {})[opt] || {});
      let caseVal;
      if (opt === "default") {
        const nums = (node.options || []).filter((x) => typeof x === "number");
        caseVal = 0;
        while (nums.includes(caseVal)) caseVal++;
      } else caseVal = Number(opt);
      setPath(state.values, path, { _case: caseVal, ...tpl });
      doEncode();
    });
    line.appendChild(sel);
    const t = document.createElement("span");
    t.className = "tinfo";
    t.textContent = `tag=${node.tag}`;
    line.appendChild(t);
    return;
  }
}

/* ---------------- 字节视图 ---------------- */

function renderHex() {
  const host = $("#hexview");
  host.innerHTML = "";
  state.byteEls = [];
  const bytes = hexToBytes(state.hex);
  if (!bytes.length) {
    host.innerHTML = '<div class="empty">无数据</div>';
    return;
  }
  for (let off = 0; off < bytes.length; off += 16) {
    const row = document.createElement("div");
    row.className = "hrow";
    const offEl = document.createElement("span");
    offEl.className = "hoff";
    offEl.textContent = off.toString(16).padStart(4, "0");
    row.appendChild(offEl);
    const bs = document.createElement("span");
    bs.className = "hbytes";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i === 8) { const g = document.createElement("span"); g.className = "gap"; bs.appendChild(g); }
      const idx = off + i;
      const b = document.createElement("span");
      b.className = "hb";
      if (idx < bytes.length) {
        const v = bytes[idx];
        b.textContent = v.toString(16).padStart(2, "0");
        ascii += v >= 32 && v < 127 ? String.fromCharCode(v) : "·";
        b.addEventListener("click", () => selectDeepest(idx));
      } else {
        b.textContent = "  ";
        b.style.visibility = "hidden";
      }
      state.byteEls[idx] = b;
      bs.appendChild(b);
    }
    row.appendChild(bs);
    const as = document.createElement("span");
    as.className = "hascii";
    as.textContent = ascii;
    row.appendChild(as);
    host.appendChild(row);
  }
}

function selectDeepest(idx) {
  let best = -1, bestSize = Infinity;
  state.nodes.forEach((rec, uid) => {
    const n = rec.node;
    if (n.byte_start <= idx && idx < n.byte_end) {
      const sz = n.byte_end - n.byte_start;
      if (sz < bestSize) { bestSize = sz; best = uid; }
    }
  });
  if (best >= 0) selectNode(best);
}

function selectNode(uid) {
  state.selected = uid;
  document.querySelectorAll(".tline.sel").forEach((e) => e.classList.remove("sel"));
  document.querySelectorAll(".hb.hl").forEach((e) => e.classList.remove("hl"));
  const rec = state.nodes[uid];
  if (!rec) return;
  rec.el.classList.add("sel");
  rec.el.scrollIntoView({ block: "nearest" });
  const n = rec.node;
  const hi = Math.min(n.byte_end, state.byteEls.length);   // 不越过输入
  for (let i = n.byte_start; i < hi; i++) {
    const el = state.byteEls[i];
    if (el) el.classList.add("hl");
  }
}

/* ---------------- 状态区 ---------------- */

function showStatus(resp, mode) {
  const el = $("#status");
  el.innerHTML = "";
  const add = (cls, text, path) => {
    const d = document.createElement("div");
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    d.appendChild(s);
    if (path && path.length) {
      const p = document.createElement("span");
      p.className = "path";
      p.textContent = "  @ " + path.join(" › ");
      p.addEventListener("click", () => {
        const key = JSON.stringify(path);
        const uid = state.nodes.findIndex((r) => JSON.stringify(r.path) === key);
        if (uid >= 0) selectNode(uid);
      });
      d.appendChild(p);
    }
    el.appendChild(d);
  };

  if (resp.stage === "compile") { add("bad", "布局编译失败: " + resp.error.message); return; }
  if (resp.stage === "hex") { add("bad", "十六进制输入错误: " + resp.error.message); return; }
  if (resp.error) {
    const bit = resp.error.bit_offset != null ? `（位偏移 ${resp.error.bit_offset}，字节 ${Math.floor(resp.error.bit_offset / 8)}）` : "";
    add("bad", `${mode === "parse" ? "解析" : "编码"}失败: ${resp.error.message}${bit}`, resp.error.path);
  }
  for (const it of resp.issues || []) add("warn", "⚠ " + it.message, it.path);
  if (resp.ok && !(resp.issues || []).length)
    add("ok", `${mode === "parse" ? "解析" : "编码"}成功 · ${resp.length} 字节`);
  else if (resp.ok)
    add("warn", `${mode === "parse" ? "解析" : "编码"}完成，但有校验问题`);
}

/* ---------------- 动作 ---------------- */

async function doParse() {
  const layout = $("#layout").value;
  const hex = $("#hex").value;
  const resp = await api("/api/parse", { layout, hex });
  if (resp.tree) {
    state.tree = resp.tree;
    state.values = resp.values;
    state.length = resp.length;
    state.hex = cleanHex(hex);
    $("#hex").value = fmtHexText(hex);
    $("#hex-hint").textContent = `${resp.length} 字节`;
    renderTree();
    renderHex();
  }
  showStatus(resp, "parse");
}

async function doEncode() {
  if (!state.values) return;
  const resp = await api("/api/encode", {
    layout: $("#layout").value,
    values: state.values,
    fix_checksums: $("#opt-fix-crc").checked,
    fix_lengths: $("#opt-fix-len").checked,
  });
  if (resp.ok) {
    state.tree = resp.tree;
    state.values = resp.values;
    state.hex = resp.hex;
    state.length = resp.length;
    $("#hex").value = fmtHexText(resp.hex);
    $("#hex-hint").textContent = `${resp.length} 字节`;
    renderTree();
    renderHex();
  }
  showStatus(resp, "encode");
}

async function loadExample() {
  const r = await fetch("/api/example");
  const ex = await r.json();
  $("#layout").value = ex.layout;
  $("#hex").value = fmtHexText(ex.hex);
  await doParse();
}

$("#btn-parse").addEventListener("click", doParse);
$("#btn-encode").addEventListener("click", doEncode);
$("#btn-example").addEventListener("click", loadExample);

loadExample();
