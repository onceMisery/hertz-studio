// SPDX-License-Identifier: MIT
// Explicit live-provider acceptance helpers; credentials stay in isolated memory.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function configuration() {
  const origin = process.env.HERTZ_SUBAPI_ORIGIN;
  const model = process.env.HERTZ_SUBAPI_MODEL;
  const key = process.env.HERTZ_SUBAPI_KEY;
  assert.ok(origin && model && key, 'Live acceptance requires explicit origin, model and isolated key');
  const url = new URL(origin);
  assert.equal(url.protocol, 'https:');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.ok(['/v1', '/v1/'].includes(url.pathname));
  assert.ok(!/[\r\n]/.test(model));
  url.pathname = '/v1';
  return { origin: url.href, model, key };
}

async function storeCredential(api, config) {
  const status = await api('/v1/ai/provider-credential', 'PUT', { api_key: config.key });
  assert.equal(status.provider, 'openai-compatible');
  assert.equal(status.origin, config.origin);
  assert.equal(status.configured, true);
}

function verifyUsage(data, output, jobId, config, composition) {
  const db = new DatabaseSync(path.join(data, 'vmusic.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM ai_jobs').get().n, 1);
    const job = db.prepare('SELECT state, failure_code FROM ai_jobs WHERE job_id=?').get(jobId);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.failure_code, null);
    const rows = db.prepare('SELECT usage_state, accounted_micro_usd, reported_usage FROM ai_usage_entries WHERE job_id=?').all(jobId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.usage_state, 'unpriced');
    const usage = JSON.parse(row.reported_usage);
    assert.ok(Number.isInteger(usage.inputTokens) && usage.inputTokens > 0);
    assert.ok(Number.isInteger(usage.outputTokens) && usage.outputTokens > 0);
    const report = { passed: true, provider: 'openai-compatible', origin: config.origin, model: config.model,
      outputKind: composition ? 'composition' : 'builtin', jobId, state: job.state, usageState: row.usage_state,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, amountMicroUsd: null };
    fs.writeFileSync(path.join(output, 'compatible-results.json'), JSON.stringify(report, null, 2));
  } finally { db.close(); }
}

module.exports = { configuration, storeCredential, verifyUsage };
