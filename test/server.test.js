'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

const SCHEMA = 'struct A be { n: u8; data: u8[n]; crc: sum8; }';

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('HTTP API：compile / parse / encode 往返', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const c = await post(port, '/api/compile', { schema: SCHEMA });
    assert.equal(c.ok, true);
    assert.equal(c.root, 'A');

    const p = await post(port, '/api/parse', { schema: SCHEMA, hex: '02aabb' });
    assert.equal(p.ok, false, '缺校验字节应失败并给最深路径');
    assert.ok(p.deepest.bit > 0);

    const e = await post(port, '/api/encode', { schema: SCHEMA, values: { n: 2, data: [0xaa, 0xbb], crc: 0 } });
    assert.equal(e.ok, true);
    const p2 = await post(port, '/api/parse', { schema: SCHEMA, hex: e.hex });
    assert.equal(p2.ok, true);
    assert.deepEqual(p2.values.data, [0xaa, 0xbb]);
    assert.equal(p2.checksumFailures.length, 0);

    const bad = await post(port, '/api/parse', { schema: 'struct A { x: u8[y]; }', hex: '00' });
    assert.equal(bad.ok, false);
    assert.ok(Array.isArray(bad.compileErrors));
  } finally {
    server.close();
  }
});
