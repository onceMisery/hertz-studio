// SPDX-License-Identifier: MIT
// Isolated Ollama protocol fixture for the Windows wallpaper acceptance script.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');

module.exports = async function wallpaperOllamaFixture() {
  let calls = 0;
  const failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/chat');
      assert.equal(request.headers.authorization, undefined);
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 128 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls++;
      assert.equal(body.model, 'test-local');
      assert.equal(body.stream, false);
      assert.equal(body.think, false);
      assert.equal(body.options.num_predict, 4096);
      assert.equal(body.format.oneOf[0].properties.sceneId.const, 'coast');
      assert.equal(body.format.oneOf[0].properties.stateVersion.const, 1);
      assert.equal(body.format.oneOf[0].properties.params.properties.tod.maximum, 1);
      assert.equal(body.messages[1].content, '柔和夜色，宁静频谱');
      const output = { kind: 'builtin', sceneId: 'coast', stateVersion: 1, params: { tod: 0.72, reduced: true } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'test-local', done: true, done_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(output) }, prompt_eval_count: 1234, eval_count: 42 }));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500);
      response.end('{}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    calls: () => calls,
    verify: () => { assert.deepEqual(failures, []); assert.equal(calls, 1); },
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
};
