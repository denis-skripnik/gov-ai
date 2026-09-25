import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decision = (status, reason) => ({ status, reason, local_reward_eligible: status === 'valid' });
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function jsonSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !plainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return false;
  if (Array.isArray(value)) {
    if (Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).some(x => !x)) return false;
    if (keys.some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false;
  }
  if (keys.some(key => {
    if (Array.isArray(value) && key === 'length') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
  })) return false;
  seen.add(value);
  const ok = (Array.isArray(value) ? value : Object.values(value)).every(x => jsonSafe(x, seen));
  seen.delete(value);
  return ok;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Local fixture gate only. Hashes bind fixture fields; they do NOT attest real miner execution.
// The caller must retain the accepted-work registry for the whole accounting window.
export function verifyLocalWork(job, attempt, priorAcceptedWorkIds) {
  if (!(priorAcceptedWorkIds instanceof Set)) throw new Error('accepted-work registry is required');
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  if (!plainObject(job) || !validId(job.work_id) || !plainObject(job.input) || !plainObject(job.expected) ||
      !Object.keys(job.input).length || !Object.keys(job.expected).length ||
      !jsonSafe(job.input) || !jsonSafe(job.expected) || !plainObject(attempt) ||
      !validId(attempt.attempt_id) || attempt.work_id !== job.work_id) throw new Error('invalid local fixture');
  if (priorAcceptedWorkIds.has(job.work_id)) return decision('invalid', 'duplicate_work');
  if (attempt.state !== 'completed') return decision('needs_review', 'interrupted');
  if (!Array.isArray(attempt.results) || !jsonSafe(attempt.results) || attempt.results.length === 0 || attempt.results.some(x => !plainObject(x) || !Object.keys(x).length || Object.keys(job.expected).some(k => x[k] === null || x[k] === undefined)))
    return decision('needs_review', 'incomplete_result');
  if (attempt.results.length !== 1) return decision('needs_review', attempt.results.every(x => canonical(x) === canonical(attempt.results[0])) ? 'duplicate_output' : 'inconsistent_outputs');
  const evidence = attempt.evidence;
  if (!plainObject(evidence) || evidence.completion_marker !== true || !evidence.input_sha256 || !evidence.output_sha256)
    return decision('needs_review', 'missing_evidence');
  if (evidence.work_id !== job.work_id || evidence.attempt_id !== attempt.attempt_id)
    return decision('needs_review', 'evidence_identity_mismatch');
  if (evidence.input_sha256 !== digest(job.input) || evidence.output_sha256 !== digest(attempt.results[0]))
    return decision('needs_review', 'evidence_hash_mismatch');
  if (canonical(attempt.results[0]) !== canonical(job.expected))
    return decision('invalid', 'incorrect_result');
  priorAcceptedWorkIds.add(job.work_id);
  return decision('valid', 'local_checks_passed');
}

export function buildWeek27Fixtures() {
  const job = { work_id: 'local-work-001', input: { values: [2, 3] }, expected: { sum: 5 } };
  const good = { sum: 5 }, wrong = { sum: 6 };
  const make = (id, output = good) => ({
    work_id: job.work_id, attempt_id: id, state: 'completed', results: [output],
    evidence: { work_id: job.work_id, attempt_id: id, input_sha256: digest(job.input), output_sha256: digest(output), completion_marker: true },
  });
  return [
    { name: 'correct_execution', job, attempt: make('a1') },
    { name: 'incorrect_execution', job, attempt: make('a2', wrong) },
    { name: 'interrupted_job', job, attempt: { ...make('a3'), state: 'interrupted' } },
    { name: 'incomplete_result', job, attempt: { ...make('a4'), results: [{ sum: null }] } },
    { name: 'duplicate_work', job, attempt: make('a5'), priorAcceptedWorkIds: new Set([job.work_id]) },
    { name: 'inconsistent_outputs', job, attempt: { ...make('a6'), results: [good, wrong] } },
    { name: 'missing_evidence', job, attempt: { ...make('a7'), evidence: null } },
    { name: 'foreign_evidence', job, attempt: { ...make('a8'), evidence: { ...make('a8').evidence, work_id: 'foreign-job' } } },
  ];
}

export function runWeek27Simulation() {
  const cases = buildWeek27Fixtures().map(({ name, job, attempt, priorAcceptedWorkIds }) => ({
    name, ...verifyLocalWork(job, attempt, priorAcceptedWorkIds ?? new Set()),
  }));
  return {
    kind: 'week27-local-simulation-not-ambient-protocol',
    status: cases.length === 8 && cases.filter(x => x.local_reward_eligible).length === 1 ? 'complete' : 'needs_review',
    fast_mode: false,
    actual_miner_jobs: 0,
    real_rewards_issued: 0,
    caveat: 'Self-declared fixture hashes are not Proof of Logits, independent validation, or evidence of Ambient rewards.',
    cases,
  };
}
