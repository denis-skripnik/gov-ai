import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonMemoryStore } from './memory-store.js';
import { buildMemoryContext, buildStatefulMessages } from './prompt-state.js';
import { contentHash, summarizeStability } from './sglang-bench.js';

test('JsonMemoryStore persists and bounds prompt state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week14-memory-'));
  const store = new JsonMemoryStore(path.join(dir, 'memory.json'));

  store.upsertSession('s1', { summary: 'summary', facts: { risk: 'unknown funding' } });
  store.appendTurn('s1', { role: 'user', content: 'first' });
  store.appendTurn('s1', { role: 'assistant', content: 'second' });
  store.appendTurn('s1', { role: 'user', content: 'third' });

  const state = store.getPromptState('s1', { maxTurns: 2, maxChars: 1000 });
  assert.equal(state.summary, 'summary');
  assert.equal(state.facts.risk, 'unknown funding');
  assert.deepEqual(state.turns.map((turn) => turn.content), ['second', 'third']);
});

test('buildStatefulMessages injects prior state before current task', () => {
  const messages = buildStatefulMessages({
    systemPrompt: 'system',
    userPrompt: 'current task',
    promptState: { session_id: 's1', summary: 'prior summary', facts: { a: 1 }, turns: [{ role: 'user', content: 'old task' }] },
  });

  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /PRIOR_STATE/);
  assert.match(messages[1].content, /prior summary/);
  assert.match(messages[1].content, /CURRENT_TASK:\ncurrent task/);
});

test('contentHash normalizes whitespace and case', () => {
  assert.equal(contentHash(' Hello   World '), contentHash('hello world'));
});

test('summarizeStability reports exact match and recommendation consistency', () => {
  const runs = [
    { ok: true, output_hash: contentHash('{"recommendation":"yes"}'), parsed: { recommendation: 'yes' } },
    { ok: true, output_hash: contentHash('{"recommendation":"yes"}'), parsed: { recommendation: 'yes' } },
    { ok: true, output_hash: contentHash('{"recommendation":"no"}'), parsed: { recommendation: 'no' } },
    { ok: false },
  ];

  const summary = summarizeStability(runs);
  assert.equal(summary.ok_runs, 3);
  assert.equal(summary.unique_output_hashes, 2);
  assert.equal(summary.exact_match_rate, 0.667);
  assert.equal(summary.unique_recommendations, 2);
  assert.equal(summary.recommendation_consistency_rate, 0.667);
});

test('buildMemoryContext handles empty state', () => {
  const context = buildMemoryContext({ session_id: 'empty' });
  assert.match(context, /facts: none/);
  assert.match(context, /recent_turns: none/);
});
