#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson, runMultiAgentCouncil, writeCouncilArtifacts } from '../week17-multi-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const reportPath = process.argv[2] || 'examples/week16-trust-verification/gov-ai-main-report.json';
const proposalPath = process.argv[3] || 'examples/week16-trust-verification/treasury-transfer-proposal.json';
const outputDir = process.argv[4] || 'examples/week17-multi-agent-systems';

const absoluteReportPath = path.resolve(repoRoot, reportPath);
const absoluteProposalPath = path.resolve(repoRoot, proposalPath);
const absoluteOutputDir = path.resolve(repoRoot, outputDir);

const report = loadJson(absoluteReportPath);
const proposal = loadJson(absoluteProposalPath);

const state = runMultiAgentCouncil({
  proposal,
  report,
  source: {
    report_path: reportPath,
    proposal_path: proposalPath,
    mode: 'deterministic-local-demo',
  },
});

const artifacts = writeCouncilArtifacts(state, absoluteOutputDir);
console.log(JSON.stringify({
  status: state.shared_memory.verification.status,
  decision: state.shared_memory.decision.suggested_option,
  agent_count: state.run.agent_count,
  artifacts,
}, null, 2));
