import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyLocalWork as verifyWithRegistry, runWeek27Simulation, buildWeek27Fixtures } from './week27-valid-work.js';
const verifyLocalWork = (job, attempt, accepted = new Set()) => verifyWithRegistry(job, attempt, accepted);

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const job = { work_id: 'job-a', input: { values: [2, 3] }, expected: { sum: 5 } };
const result = { sum: 5 };
const attempt = (overrides = {}) => ({
  work_id: job.work_id, attempt_id: 'attempt-a', state: 'completed', results: [result],
  evidence: { work_id: job.work_id, attempt_id: 'attempt-a', input_sha256: hash(job.input), output_sha256: hash(result), completion_marker: true },
  ...overrides,
});

test('correct complete unique work is locally eligible, without claiming Ambient settlement', () => {
  assert.deepEqual(verifyLocalWork(job, attempt()), { status: 'valid', reason: 'local_checks_passed', local_reward_eligible: true });
});
test('wrong execution is invalid even with matching self-declared output evidence', () => {
  const wrong = { sum: 6 };
  assert.deepEqual(verifyLocalWork(job, attempt({ results: [wrong], evidence: { ...attempt().evidence, output_sha256: hash(wrong) } })),
    { status: 'invalid', reason: 'incorrect_result', local_reward_eligible: false });
});
test('interrupted and incomplete work cannot be locally rewarded', () => {
  assert.equal(verifyLocalWork(job, attempt({ state: 'interrupted' })).reason, 'interrupted');
  assert.equal(verifyLocalWork(job, attempt({ results: [{ sum: null }] })).reason, 'incomplete_result');
  assert.equal(verifyLocalWork(job, attempt({ evidence: null })).reason, 'missing_evidence');
});
test('duplicate, contradictory and cross-job evidence fail closed', () => {
  assert.equal(verifyLocalWork(job, attempt(), new Set(['job-a'])).reason, 'duplicate_work');
  assert.equal(verifyLocalWork(job, attempt({ results: [result, { sum: 6 }] })).reason, 'inconsistent_outputs');
  assert.equal(verifyLocalWork(job, attempt({ evidence: { ...attempt().evidence, work_id: 'other' } })).reason, 'evidence_identity_mismatch');
  assert.equal(verifyLocalWork(job, attempt({ evidence: { ...attempt().evidence, output_sha256: hash({ sum: 6 }) } })).reason, 'evidence_hash_mismatch');
});
test('no evidence, forged complete marker, or replay with altered attempt ID cannot earn', () => {
  assert.equal(verifyLocalWork(job, attempt({ evidence: { ...attempt().evidence, completion_marker: false } })).local_reward_eligible, false);
  assert.equal(verifyLocalWork(job, attempt({ evidence: { ...attempt().evidence, completion_marker: 'false' } })).local_reward_eligible, false);
  assert.equal(verifyLocalWork(job, attempt({ attempt_id: 'attempt-b' })).reason, 'evidence_identity_mismatch');
  assert.equal(verifyLocalWork(job, attempt({ evidence: { ...attempt().evidence, input_sha256: '0'.repeat(64) } })).reason, 'evidence_hash_mismatch');
});
test('registry must be supplied and a second accepted call is a duplicate', () => {
  assert.throws(() => verifyWithRegistry(job, attempt()), /registry|accepted/);
  const accepted = new Set();
  assert.equal(verifyWithRegistry(job, attempt(), accepted).status, 'valid');
  assert.equal(accepted.has(job.work_id), true);
  assert.equal(verifyWithRegistry(job, attempt(), accepted).reason, 'duplicate_work');
});
test('JSON comparison ignores object key order but rejects non-JSON fields', () => {
  const expanded = { ...job, expected: { sum: 5, unit: 'x' } };
  const reordered = { unit: 'x', sum: 5 };
  assert.equal(verifyLocalWork(expanded, attempt({ results: [reordered], evidence: { ...attempt().evidence, output_sha256: hash(reordered) } })).status, 'valid');
  const malformed = { sum: 5, ghost: undefined };
  assert.equal(verifyLocalWork(job, attempt({ results: [malformed], evidence: { ...attempt().evidence, output_sha256: hash(malformed) } })).local_reward_eligible, false);
});
test('repeated identical outputs are not misclassified as contradictory', () => {
  assert.equal(verifyLocalWork(job, attempt({ results: [result, result] })).reason, 'duplicate_output');
});
test('rejects hidden or extra properties that JSON serialization drops', () => {
  const hidden = { sum: 5 };
  Object.defineProperty(hidden, 'ghost', { value: undefined });
  assert.equal(verifyLocalWork(job, attempt({ results: [hidden] })).local_reward_eligible, false);
  const results = [result];
  results.other = { sum: 3 };
  assert.equal(verifyLocalWork(job, attempt({ results })).local_reward_eligible, false);
  const badArray = [2, 3];
  badArray.ghost = undefined;
  const badJob = { ...job, input: { values: badArray } };
  assert.throws(() => verifyLocalWork(badJob, attempt()), /invalid local fixture/);
});
test('empty IDs and empty work/result cannot be eligible', () => {
  assert.throws(() => verifyLocalWork({ ...job, work_id: '' }, attempt()), /invalid local fixture/);
  assert.throws(() => verifyLocalWork(job, attempt({ attempt_id: '' })), /invalid local fixture/);
  assert.throws(() => verifyLocalWork({ ...job, input: {} }, attempt()), /invalid local fixture/);
  assert.throws(() => verifyLocalWork({ ...job, expected: {} }, attempt()), /invalid local fixture/);
  const emptyJob = { ...job, expected: { sum: 5 } };
  assert.equal(verifyLocalWork(emptyJob, attempt({ results: [{}] })).local_reward_eligible, false);
});
test('bounded local fixture matrix covers all announced failure modes once', () => {
  const cases = buildWeek27Fixtures();
  assert.equal(cases.length, 8);
  const report = runWeek27Simulation();
  assert.equal(report.kind, 'week27-local-simulation-not-ambient-protocol');
  assert.equal(report.cases.length, 8);
  assert.deepEqual(report.cases.map(x => x.reason), [
    'local_checks_passed', 'incorrect_result', 'interrupted', 'incomplete_result',
    'duplicate_work', 'inconsistent_outputs', 'missing_evidence', 'evidence_identity_mismatch',
  ]);
  assert.equal(report.cases.filter(x => x.local_reward_eligible).length, 1);
  assert.equal(report.status, 'complete');
});
