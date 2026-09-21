'use strict';

// 语义检查 + 编译为与解析/编码共享的执行计划（plan）。
// 编译期检查：
//   - 未知类型 / 重复结构体 / 重复字段
//   - 前向引用（表达式只能引用同一结构体内此前定义的字段）
//   - 无界递归（结构体包含环且环上没有被数组/分支“可空”边打断）
//   - 位域总宽、对齐参数、常量范围、分支标签重复等

const { collectRefs } = require('./expr');

const CHECKSUM_BITS = { crc16: 16, crc32: 32, sum8: 8, sum16: 16, xor8: 8 };

function compileSchema(ast) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  const structNames = new Map();
  for (const s of ast.structs) {
    if (structNames.has(s.name)) err(`结构体 '${s.name}' 重复定义`);
    structNames.set(s.name, s);
  }

  const plan = { structs: {}, root: ast.structs[0].name, errors };

  // 第一遍：建立结构体骨架，便于递归引用解析
  for (const s of ast.structs) {
    plan.structs[s.name] = { name: s.name, endian: s.endian, fields: [] };
  }

  // 表达式引用检查：refs 中的首段必须出现在 prior（此前字段的 name->type 映射）里；
  // 点号后续段沿位域/结构体类型静态下钻。
  function checkExprRefs(exprAst, prior, ownerName, what) {
    for (const path of collectRefs(exprAst)) {
      const head = path[0];
      if (!prior.has(head)) {
        err(`结构体 '${ownerName}' 的 ${what} 引用了未在此前定义的字段 '${head}'（禁止前向引用）`);
        continue;
      }
      // 静态下钻点号路径
      let type = prior.get(head);
      for (let i = 1; i < path.length; i++) {
        const seg = path[i];
        if (type.t === 'bits') {
          const sub = type.fields.find((f) => f.name === seg);
          if (!sub) { err(`${what}: 位域 '${head}' 中没有子字段 '${seg}'`); type = null; break; }
          type = { t: 'int', bits: sub.bits, signed: false };
        } else if (type.t === 'struct' && plan.structs[type.name]) {
          const def = ast.structs.find((s) => s.name === type.name);
          const fld = def.fields.find((f) => f.name === seg);
          if (!fld) { err(`${what}: 结构体 '${type.name}' 中没有字段 '${seg}'`); type = null; break; }
          type = fld.type;
        } else {
          err(`${what}: '${path.slice(0, i).join('.')}' 不是可下钻的复合字段`);
          type = null;
          break;
        }
      }
    }
  }

  function checkCountExpr(exprAst, prior, ownerName, what) {
    checkExprRefs(exprAst, prior, ownerName, what);
  }

  function compileType(type, prior, ownerName, fieldName) {
    switch (type.t) {
      case 'int': {
        const p = { kind: 'int', bits: type.bits, signed: type.signed };
        if (type.const !== undefined) {
          const max = type.signed ? 2 ** (type.bits - 1) - 1 : 2 ** type.bits - 1;
          const min = type.signed ? -(2 ** (type.bits - 1)) : 0;
          if (!Number.isSafeInteger(type.const) || type.const < min || type.const > max) {
            err(`字段 '${ownerName}.${fieldName}' 的常量 ${type.const} 超出 ${type.signed ? 'i' : 'u'}${type.bits} 范围`);
          }
          p.const = type.const;
        }
        return p;
      }
      case 'bits': {
        const total = type.fields.reduce((a, f) => a + f.bits, 0);
        const seen = new Set();
        for (const f of type.fields) {
          if (seen.has(f.name)) err(`位域 '${ownerName}.${fieldName}' 子字段 '${f.name}' 重复`);
          seen.add(f.name);
          if (!Number.isInteger(f.bits) || f.bits < 1) err(`位域 '${ownerName}.${fieldName}.${f.name}' 宽度必须 ≥ 1`);
        }
        if (total > type.bits) {
          err(`位域 '${ownerName}.${fieldName}' 子字段总宽 ${total} 超过容器宽度 ${type.bits}`);
        }
        return { kind: 'bits', bits: type.bits, fields: type.fields.map((f) => ({ name: f.name, bits: f.bits })) };
      }
      case 'bytes': {
        checkCountExpr(type.count, prior, ownerName, `字段 '${fieldName}' 的长度表达式`);
        return { kind: 'bytes', count: type.count, countField: bareCountField(type.count, prior) };
      }
      case 'array': {
        checkCountExpr(type.count, prior, ownerName, `数组 '${fieldName}' 的长度表达式`);
        const elem = type.elem.t === 'int'
          ? { kind: 'int', bits: type.elem.bits, signed: type.elem.signed }
          : { kind: 'struct', struct: type.elem.name };
        if (type.elem.t === 'struct' && !structNames.has(type.elem.name)) {
          err(`数组 '${ownerName}.${fieldName}' 引用了未知结构体 '${type.elem.name}'`);
        }
        return { kind: 'array', elem, count: type.count, countField: bareCountField(type.count, prior) };
      }
      case 'struct': {
        if (!structNames.has(type.name)) err(`字段 '${ownerName}.${fieldName}' 引用了未知结构体 '${type.name}'`);
        return { kind: 'struct', struct: type.name };
      }
      case 'choose': {
        checkExprRefs(type.expr, prior, ownerName, `choose 字段 '${fieldName}' 的分支表达式`);
        const seenVal = new Set();
        let hasDefault = false;
        const cases = type.cases.map((c) => {
          if (c.value === null) {
            if (hasDefault) err(`choose 字段 '${ownerName}.${fieldName}' 有多个默认分支`);
            hasDefault = true;
          } else {
            if (seenVal.has(c.value)) err(`choose 字段 '${ownerName}.${fieldName}' 分支值 ${c.value} 重复`);
            seenVal.add(c.value);
          }
          return { value: c.value, type: compileCaseType(c.type, prior, ownerName, fieldName) };
        });
        return { kind: 'choice', expr: type.expr, cases };
      }
      case 'checksum':
        return { kind: 'checksum', algo: type.algo, bits: CHECKSUM_BITS[type.algo] };
      default:
        err(`字段 '${ownerName}.${fieldName}' 类型未知`);
        return { kind: 'int', bits: 8, signed: false };
    }
  }

  function compileCaseType(t, prior, ownerName, fieldName) {
    if (t.t === 'int') return { kind: 'int', bits: t.bits, signed: t.signed };
    if (t.t === 'bytes') {
      checkCountExpr(t.count, prior, ownerName, `choose 字段 '${fieldName}' 分支的长度表达式`);
      return { kind: 'bytes', count: t.count, countField: bareCountField(t.count, prior) };
    }
    if (t.t === 'struct') {
      if (!structNames.has(t.name)) err(`choose 字段 '${ownerName}.${fieldName}' 引用了未知结构体 '${t.name}'`);
      return { kind: 'struct', struct: t.name };
    }
    err(`choose 字段 '${ownerName}.${fieldName}' 分支类型非法`);
    return { kind: 'int', bits: 8, signed: false };
  }

  // 长度表达式若为“裸字段引用”且该字段是此前的整数字段，则编码时可回填
  function bareCountField(exprAst, prior) {
    if (exprAst && exprAst.t === 'ref' && exprAst.path.length === 1) {
      const t = prior.get(exprAst.path[0]);
      if (t && t.t === 'int') return exprAst.path[0];
    }
    return null;
  }

  // 第二遍：逐结构体编译字段
  for (const s of ast.structs) {
    const prior = new Map(); // name -> 原始 type AST（供引用下钻）
    const out = [];
    for (const f of s.fields) {
      if (prior.has(f.name)) {
        err(`结构体 '${s.name}' 字段 '${f.name}' 重复定义`);
        continue;
      }
      const compiled = compileType(f.type, prior, s.name, f.name);
      compiled.name = f.name;
      if (f.type.align !== undefined) {
        const a = f.type.align;
        if (!Number.isInteger(a) || a < 1 || (a & (a - 1)) !== 0) {
          err(`字段 '${s.name}.${f.name}' 的 align(${a}) 必须是 2 的幂且 ≥ 1`);
        } else {
          compiled.align = a;
        }
      }
      out.push(compiled);
      prior.set(f.name, f.type);
    }
    plan.structs[s.name].fields = out;
  }

  // 无界递归检查：结构体包含图中，若存在环且环上所有边都是“必选定长”边
  // （未经过数组或 choose），则布局尺寸不可终止。
  const edges = new Map(); // name -> [{to, guarded}]
  for (const s of ast.structs) {
    const list = [];
    const walk = (type, guarded) => {
      if (!type) return;
      if (type.t === 'struct') list.push({ to: type.name, guarded });
      else if (type.t === 'array') walk(type.elem, true);
      else if (type.t === 'choose') for (const c of type.cases) walk(c.type, true);
    };
    for (const f of s.fields) walk(f.type, false);
    edges.set(s.name, list);
  }
  const state = new Map(); // 0=未访问 1=在栈中 2=完成
  const stack = [];      // 结构体名
  const guards = [];     // guards[i] = 从 stack[i-1] 到 stack[i] 的边是否可空
  const dfs = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const e of edges.get(n) || []) {
      if (!structNames.has(e.to)) continue;
      if (state.get(e.to) === 1) {
        // 只检查环上的边：stack 中 e.to 之后的边 + 当前这条回边
        const from = stack.indexOf(e.to);
        const cycleGuards = guards.slice(from + 1).concat(e.guarded);
        if (!cycleGuards.some(Boolean)) {
          const cyc = stack.slice(from).concat(e.to).join(' -> ');
          err(`无界递归布局: ${cyc}（递归未经过可空的数组或分支）`);
        }
        continue;
      }
      if (!state.get(e.to)) {
        guards.push(e.guarded);
        dfs(e.to);
        guards.pop();
      }
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const name of structNames.keys()) if (!state.get(name)) dfs(name);

  // 根结构体：优先取未被任何其他结构体引用的那个（唯一时），否则取最后定义的
  const referenced = new Set();
  for (const s of ast.structs) {
    const walkRefs = (type) => {
      if (!type) return;
      if (type.t === 'struct') referenced.add(type.name);
      else if (type.t === 'array') walkRefs(type.elem);
      else if (type.t === 'choose') for (const c of type.cases) walkRefs(c.type);
    };
    for (const f of s.fields) walkRefs(f.type);
  }
  const roots = ast.structs.map((s) => s.name).filter((n) => !referenced.has(n));
  plan.root = roots.length === 1 ? roots[0] : ast.structs[ast.structs.length - 1].name;

  plan.errors = errors;
  return plan;
}

module.exports = { compileSchema, CHECKSUM_BITS };
