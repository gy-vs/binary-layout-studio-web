'use strict';

// 受限表达式语言：整数算术 / 位运算 / 比较、字段引用、len(数组或字节字段)。
// 无函数调用（除 len）、无副作用，结果必须是安全整数。

class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

const PUNCT = ['<<', '>>', '<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '<', '>', '&', '|', '(', ')', ',', '.'];

function tokenizeExpr(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (src.startsWith('0x', i) || src.startsWith('0X', i)) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        if (j === i + 2) throw new ExprError(`非法十六进制字面量: ${src.slice(i, j + 1)}`);
      } else {
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = PUNCT.find((p) => src.startsWith(p, i));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    throw new ExprError(`表达式中出现非法字符 '${c}'`);
  }
  return toks;
}

// 优先级（低→高）: 比较 < | < & < 移位 < 加减 < 乘除模 < 一元 < 原子
function parseExpr(src) {
  const toks = tokenizeExpr(src);
  let pos = 0;
  const peek = () => toks[pos];
  const eatOp = (op) => {
    const t = toks[pos];
    if (t && t.t === 'op' && t.v === op) { pos++; return true; }
    return false;
  };
  const expectOp = (op) => {
    if (!eatOp(op)) throw new ExprError(`表达式缺少 '${op}'`);
  };

  function parseCmp() {
    let l = parseBitor();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
        pos++;
        l = { t: 'bin', op: t.v, l, r: parseBitor() };
      } else return l;
    }
  }
  function parseBitor() {
    let l = parseBitand();
    while (eatOp('|')) l = { t: 'bin', op: '|', l, r: parseBitand() };
    return l;
  }
  function parseBitand() {
    let l = parseShift();
    while (eatOp('&')) l = { t: 'bin', op: '&', l, r: parseShift() };
    return l;
  }
  function parseShift() {
    let l = parseAdd();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '<<' || t.v === '>>')) {
        pos++;
        l = { t: 'bin', op: t.v, l, r: parseAdd() };
      } else return l;
    }
  }
  function parseAdd() {
    let l = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        pos++;
        l = { t: 'bin', op: t.v, l, r: parseMul() };
      } else return l;
    }
  }
  function parseMul() {
    let l = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        pos++;
        l = { t: 'bin', op: t.v, l, r: parseUnary() };
      } else return l;
    }
  }
  function parseUnary() {
    if (eatOp('-')) return { t: 'un', op: '-', arg: parseUnary() };
    if (eatOp('~')) return { t: 'un', op: '~', arg: parseUnary() };
    return parsePrimary();
  }
  function parseRef() {
    const t = peek();
    if (!t || t.t !== 'ident') throw new ExprError('表达式此处应为字段名');
    pos++;
    const path = [t.v];
    while (eatOp('.')) {
      const s = peek();
      if (!s || s.t !== 'ident') throw new ExprError("'.' 后应为字段名");
      pos++;
      path.push(s.v);
    }
    return path;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new ExprError('表达式意外结束');
    if (t.t === 'num') { pos++; return { t: 'num', v: t.v }; }
    if (t.t === 'ident') {
      if (t.v === 'len') {
        pos++;
        expectOp('(');
        const path = parseRef();
        expectOp(')');
        return { t: 'len', path };
      }
      return { t: 'ref', path: parseRef() };
    }
    if (eatOp('(')) {
      const e = parseCmp();
      expectOp(')');
      return e;
    }
    throw new ExprError(`表达式中出现意外的 '${t.v}'`);
  }

  const ast = parseCmp();
  if (pos !== toks.length) throw new ExprError('表达式末尾有多余内容');
  return ast;
}

function checkInt(v, what) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new ExprError(`${what} 溢出或不是整数`);
  }
  return v;
}

function resolvePath(env, path) {
  let cur = env;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') {
      throw new ExprError(`字段 '${path.join('.')}' 不可访问`);
    }
    cur = cur[seg];
    if (cur === undefined) throw new ExprError(`未知字段 '${path.join('.')}'`);
  }
  return cur;
}

function evalExpr(node, env) {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'ref': {
      const v = resolvePath(env, node.path);
      if (typeof v !== 'number') {
        throw new ExprError(`字段 '${node.path.join('.')}' 不是整数，不能直接参与运算`);
      }
      return v;
    }
    case 'len': {
      const v = resolvePath(env, node.path);
      if (!Array.isArray(v)) {
        throw new ExprError(`len() 只能用于数组或字节字段，'${node.path.join('.')}' 不是`);
      }
      return v.length;
    }
    case 'un': {
      const a = evalExpr(node.arg, env);
      return checkInt(node.op === '-' ? -a : ~a, '一元运算结果');
    }
    case 'bin': {
      const l = evalExpr(node.l, env);
      const r = evalExpr(node.r, env);
      switch (node.op) {
        case '+': return checkInt(l + r, '加法结果');
        case '-': return checkInt(l - r, '减法结果');
        case '*': return checkInt(l * r, '乘法结果');
        case '/':
          if (r === 0) throw new ExprError('除以零');
          return checkInt(Math.trunc(l / r), '除法结果');
        case '%':
          if (r === 0) throw new ExprError('对零取模');
          return checkInt(l % r, '取模结果');
        case '<<':
          if (r < 0 || r > 52) throw new ExprError('移位量非法');
          return checkInt(l * 2 ** r, '左移结果');
        case '>>':
          if (r < 0 || r > 52) throw new ExprError('移位量非法');
          return checkInt(Math.trunc(l / 2 ** r), '右移结果');
        case '&': return checkInt(l & r, '按位与结果');
        case '|': return checkInt(l | r, '按位或结果');
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        case '<': return l < r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        default: throw new ExprError(`未知运算符 ${node.op}`);
      }
    }
    default:
      throw new ExprError('未知表达式节点');
  }
}

// 收集表达式引用的字段（含 len() 参数），供编译期前向引用检查。
function collectRefs(node, out = []) {
  switch (node.t) {
    case 'ref':
    case 'len':
      out.push(node.path);
      break;
    case 'un':
      collectRefs(node.arg, out);
      break;
    case 'bin':
      collectRefs(node.l, out);
      collectRefs(node.r, out);
      break;
    default:
      break;
  }
  return out;
}

module.exports = { ExprError, parseExpr, evalExpr, collectRefs };
