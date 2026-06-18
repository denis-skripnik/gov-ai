import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REQUIRED_EVIDENCE = [
  'invoice',
  'multisig signer list',
  'recipient-control proof',
  'budget breakdown',
];

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2), 'utf8').digest('hex');
}

function nowIso(runtime = {}) {
  return runtime.now ? runtime.now() : new Date().toISOString();
}

function pushMessage(sharedState, role, summary, data = {}) {
  sharedState.messages.push({
    index: sharedState.messages.length,
    at: sharedState.run.started_at,
    role,
    summary,
    data,
  });
}

function textIncludesAny(text, needles) {
  const haystack = String(text || '').toLowerCase();
  return needles.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

function inferAmount(text) {
  const match = String(text || '').match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:USDC|USD|DAI)?\b|\b\d+(?:\.\d+)?\s*(?:USDC|USD|DAI)\b/i);
  return match ? match[0] : null;
}

function inferAddresses(text) {
  return Array.from(new Set(String(text || '').match(/0x[a-fA-F0-9]{40}/g) || []));
}

export function createInitialAgentState({ proposal, report, source = {}, runtime = {} }) {
  const startedAt = nowIso(runtime);
  const extracted = report?.extracted || proposal || {};
  return {
    version: 1,
    run: {
      kind: 'gov-ai-week17-multi-agent-council',
      started_at: startedAt,
      source,
    },
    shared_memory: {
      proposal: extracted,
      prior_report: report || null,
      facts: [],
      risks: [],
      decision: null,
      verification: null,
    },
    agents: [],
    messages: [],
    artifacts: [],
  };
}

export function researchAgent(sharedState) {
  const proposal = sharedState.shared_memory.proposal || {};
  const report = sharedState.shared_memory.prior_report || {};
  const text = [proposal.title, proposal.body, report?.analysis?.summary, ...(report?.analysis?.key_changes || [])].join('\n');
  const requiredEvidence = proposal?.metadata?.known_missing_evidence || DEFAULT_REQUIRED_EVIDENCE;
  const missingEvidence = Array.isArray(proposal?.metadata?.known_missing_evidence)
    ? [...proposal.metadata.known_missing_evidence]
    : requiredEvidence.filter((item) => textIncludesAny(text, [`no ${item}`, `missing ${item}`, `${item} is missing`]) || textIncludesAny((report?.analysis?.unknowns || []).join('\n'), [item]));

  const facts = [
    proposal.title ? { key: 'title', value: proposal.title, source: 'proposal.title' } : null,
    inferAmount(text) ? { key: 'amount', value: inferAmount(text), source: 'proposal/report text' } : null,
    inferAddresses(text).length ? { key: 'addresses', value: inferAddresses(text), source: 'proposal/report text' } : null,
    Array.isArray(proposal.options) ? { key: 'voting_options', value: proposal.options, source: 'proposal.options' } : null,
    missingEvidence.length ? { key: 'missing_evidence', value: missingEvidence, source: 'metadata plus report unknowns' } : null,
  ].filter(Boolean);

  sharedState.shared_memory.facts = facts;
  sharedState.agents.push({ role: 'research_agent', status: 'complete', wrote: ['shared_memory.facts'] });
  pushMessage(sharedState, 'research_agent', `Collected ${facts.length} grounded proposal facts`, { facts });
  return sharedState;
}

export function riskAnalysisAgent(sharedState) {
  const report = sharedState.shared_memory.prior_report || {};
  const facts = sharedState.shared_memory.facts || [];
  const missingEvidence = facts.find((f) => f.key === 'missing_evidence')?.value || [];
  const amount = facts.find((f) => f.key === 'amount')?.value || null;
  const addresses = facts.find((f) => f.key === 'addresses')?.value || [];

  const risks = [
    ...((report?.analysis?.risks || []).map((text) => ({ text, source: 'prior_report.analysis.risks', severity: 'medium' }))),
  ];

  if (missingEvidence.length >= 3) {
    risks.push({
      text: `High-impact execution evidence is incomplete: ${missingEvidence.join(', ')}`,
      source: 'research_agent.missing_evidence',
      severity: 'high',
    });
  }
  if (amount && addresses.length) {
    risks.push({
      text: `Treasury transfer of ${amount} targets ${addresses[0]}, so recipient-control proof should be mandatory before approval`,
      source: 'research_agent.amount_and_addresses',
      severity: 'high',
    });
  }

  sharedState.shared_memory.risks = risks;
  sharedState.agents.push({ role: 'risk_analysis_agent', status: 'complete', read: ['shared_memory.facts'], wrote: ['shared_memory.risks'] });
  pushMessage(sharedState, 'risk_analysis_agent', `Classified ${risks.length} risks`, { high_severity_count: risks.filter((r) => r.severity === 'high').length });
  return sharedState;
}

export function decisionAgent(sharedState) {
  const proposal = sharedState.shared_memory.proposal || {};
  const report = sharedState.shared_memory.prior_report || {};
  const risks = sharedState.shared_memory.risks || [];
  const options = proposal.options || [];
  const highSeverityCount = risks.filter((risk) => risk.severity === 'high').length;
  const priorOption = report?.recommendation?.suggested_option;
  const priorConfidence = report?.recommendation?.confidence || 'medium';
  const againstOption = options.find((option) => /^(against|nay|no)$/i.test(option));
  const abstainOption = options.find((option) => /^abstain$/i.test(option));

  const suggestedOption = highSeverityCount > 0
    ? (againstOption || priorOption || abstainOption || 'HUMAN_REVIEW')
    : (priorOption || abstainOption || options[0] || 'UNKNOWN');

  const decision = {
    suggested_option: suggestedOption,
    confidence: highSeverityCount > 0 ? 'high' : priorConfidence,
    rationale: highSeverityCount > 0
      ? 'Do not approve until high-severity execution and evidence gaps are resolved.'
      : 'No high-severity blocker was found by the deterministic council, so the council preserves the primary report recommendation and confidence.',
    blockers: risks.filter((risk) => risk.severity === 'high').map((risk) => risk.text),
  };

  sharedState.shared_memory.decision = decision;
  sharedState.agents.push({ role: 'decision_agent', status: 'complete', read: ['shared_memory.facts', 'shared_memory.risks'], wrote: ['shared_memory.decision'] });
  pushMessage(sharedState, 'decision_agent', `Selected ${suggestedOption} with ${decision.confidence} confidence`, decision);
  return sharedState;
}

export function verificationAgent(sharedState) {
  const facts = sharedState.shared_memory.facts || [];
  const risks = sharedState.shared_memory.risks || [];
  const decision = sharedState.shared_memory.decision || {};
  const blockers = [];

  if (!facts.find((fact) => fact.key === 'title')) blockers.push('missing proposal title fact');
  if (!Array.isArray(decision.blockers)) blockers.push('decision lacks blocker list');
  if (risks.some((risk) => risk.severity === 'high') && decision.blockers.length === 0) blockers.push('high risk did not propagate to decision blockers');

  const verification = {
    status: blockers.length ? 'needs_review' : 'verified',
    blockers,
    shared_state_sha256: sha256Json({ facts, risks, decision }),
    checks: [
      'research facts are stored in shared memory',
      'risk agent reads research facts before decision',
      'decision blockers include high-severity risks',
      'verification hash covers facts risks and decision',
    ],
  };

  sharedState.shared_memory.verification = verification;
  sharedState.agents.push({ role: 'verification_agent', status: 'complete', read: ['shared_memory.facts', 'shared_memory.risks', 'shared_memory.decision'], wrote: ['shared_memory.verification'] });
  pushMessage(sharedState, 'verification_agent', `Council verification ${verification.status}`, verification);
  return sharedState;
}

export function runMultiAgentCouncil({ proposal, report, source = {}, runtime = {} }) {
  const state = createInitialAgentState({ proposal, report, source, runtime });
  researchAgent(state);
  riskAnalysisAgent(state);
  decisionAgent(state);
  verificationAgent(state);
  state.run.completed_at = nowIso(runtime);
  state.run.agent_count = state.agents.length;
  state.run.message_count = state.messages.length;
  return state;
}

export function renderCouncilMarkdown(state) {
  const decision = state.shared_memory.decision || {};
  const verification = state.shared_memory.verification || {};
  const facts = state.shared_memory.facts || [];
  const highRisks = (state.shared_memory.risks || []).filter((risk) => risk.severity === 'high');

  return [
    '# Week 17 multi-agent governance council',
    '',
    '## Workflow',
    'Research agent -> Risk analysis agent -> Decision agent -> Verification agent',
    '',
    '## Shared state summary',
    `- Facts collected: ${facts.length}`,
    `- High-severity risks: ${highRisks.length}`,
    `- Decision: ${decision.suggested_option || 'UNKNOWN'} (${decision.confidence || 'unknown'} confidence)`,
    `- Verification: ${verification.status || 'unknown'}`,
    `- Shared-state hash: ${verification.shared_state_sha256 || 'missing'}`,
    '',
    '## Agent messages',
    ...state.messages.map((message) => `- ${message.role}: ${message.summary}`),
    '',
    '## Decision blockers',
    ...(decision.blockers?.length ? decision.blockers.map((blocker) => `- ${blocker}`) : ['- none']),
    '',
    '## Why this improves gov-ai',
    'The normal report remains the model-generated governance analysis. This council adds a deterministic, auditable multi-agent review layer over that report, with explicit shared memory and a verification hash that can be committed or attached to review tickets.',
    '',
  ].join('\n');
}

export function renderWorkflowSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360" role="img" aria-label="Week 17 multi-agent workflow">
  <rect width="1200" height="360" fill="#0b1020"/>
  <text x="60" y="56" fill="#f8fafc" font-family="Arial" font-size="30" font-weight="700">gov-ai Week 17 multi-agent council</text>
  ${[
    ['Research agent', 'extracts grounded facts', 60],
    ['Risk agent', 'classifies blockers', 330],
    ['Decision agent', 'selects option', 600],
    ['Verification agent', 'checks shared state', 870],
  ].map(([title, subtitle, x]) => `<rect x="${x}" y="120" width="220" height="110" rx="18" fill="#172554" stroke="#60a5fa" stroke-width="3"/>
  <text x="${Number(x) + 24}" y="165" fill="#dbeafe" font-family="Arial" font-size="22" font-weight="700">${title}</text>
  <text x="${Number(x) + 24}" y="200" fill="#bfdbfe" font-family="Arial" font-size="16">${subtitle}</text>`).join('\n  ')}
  <path d="M280 175 H330 M550 175 H600 M820 175 H870" stroke="#93c5fd" stroke-width="5" marker-end="url(#arrow)"/>
  <rect x="335" y="270" width="530" height="48" rx="12" fill="#064e3b" stroke="#34d399" stroke-width="2"/>
  <text x="385" y="301" fill="#d1fae5" font-family="Arial" font-size="18">shared JSON memory: facts, risks, decision, verification hash</text>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#93c5fd"/></marker></defs>
</svg>`;
}

export function writeCouncilArtifacts(state, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'multi-agent-council-output.json');
  const mdPath = path.join(outputDir, 'multi-agent-council-report.md');
  const svgPath = path.join(outputDir, 'multi-agent-workflow.svg');
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2));
  fs.writeFileSync(mdPath, renderCouncilMarkdown(state));
  fs.writeFileSync(svgPath, renderWorkflowSvg());
  return { jsonPath, mdPath, svgPath };
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
