'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { parseSchema, DslError } = require('./dsl');
const { compileSchema } = require('./compiler');
const { parsePayload, encodePayload } = require('./runtime');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function compileOrReply(schemaText) {
  let ast;
  try {
    ast = parseSchema(String(schemaText ?? ''));
  } catch (e) {
    if (e instanceof DslError) return { error: { ok: false, compileErrors: [e.message] } };
    throw e;
  }
  const plan = compileSchema(ast);
  if (plan.errors.length > 0) return { error: { ok: false, compileErrors: plan.errors } };
  return { plan };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/api/compile') {
        const body = await readBody(req);
        const { plan, error } = compileOrReply(body.schema);
        if (error) return send(res, 200, error);
        return send(res, 200, { ok: true, structs: Object.keys(plan.structs), root: plan.root, plan });
      }
      if (req.method === 'POST' && url.pathname === '/api/parse') {
        const body = await readBody(req);
        const { plan, error } = compileOrReply(body.schema);
        if (error) return send(res, 200, error);
        return send(res, 200, parsePayload(plan, body.hex ?? ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/encode') {
        const body = await readBody(req);
        const { plan, error } = compileOrReply(body.schema);
        if (error) return send(res, 200, error);
        return send(res, 200, encodePayload(plan, body.values ?? {}));
      }
      if (req.method === 'GET') {
        const p = url.pathname === '/' ? '/index.html' : url.pathname;
        const file = path.normalize(path.join(PUBLIC_DIR, p));
        if (!file.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        try {
          const data = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          return res.end(data);
        } catch {
          res.writeHead(404);
          return res.end('not found');
        }
      }
      res.writeHead(404);
      return res.end('not found');
    } catch (e) {
      return send(res, 500, { ok: false, error: { message: `服务器内部错误: ${e.message}` } });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer().listen(port, () => {
    console.log(`binary-layout-studio 已启动: http://localhost:${port}`);
  });
}

module.exports = { createServer };
