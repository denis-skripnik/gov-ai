import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchAndExtract } from './fetcher.js';

test('fetchAndExtract reads local JSON proposal fixtures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-local-proposal-'));
  const file = path.join(dir, 'proposal.json');
  fs.writeFileSync(file, JSON.stringify({
    title: 'Local treasury spend',
    body: 'Transfer 250,000 USDC to 0x1234567890abcdef1234567890abcdef12345678.',
    options: ['For', 'Against'],
    metadata: { week: 16 },
  }));

  try {
    const extracted = await fetchAndExtract(file);
    assert.equal(extracted.source_type, 'local-fixture');
    assert.equal(extracted.title, 'Local treasury spend');
    assert.match(extracted.body, /250,000 USDC/);
    assert.deepEqual(extracted.options, ['For', 'Against']);
    assert.equal(extracted.metadata.week, 16);
    assert.equal(extracted.metadata.local_fixture_path, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchAndExtract treats existing relative .json paths as local fixtures', async () => {
  const extracted = await fetchAndExtract('examples/week16-trust-verification/treasury-transfer-proposal.json');
  assert.equal(extracted.source_type, 'local-fixture');
  assert.equal(extracted.title, 'Q2 grants treasury transfer');
  assert.match(extracted.body, /250,000 USDC/);
  assert.deepEqual(extracted.options, ['For', 'Against', 'Abstain']);
});
