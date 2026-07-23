import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runMultiAgentCouncil } from './week17-multi-agent.js';

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2), 'utf8').digest('hex');
}

function nowIso(runtime = {}) {
  return runtime.now ? runtime.now() : new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function textOfProposal(proposal = {}) {
  return [
    proposal.title,
    proposal.body,
    proposal.description,
    proposal.metadata?.description,
  ].filter(Boolean).join('\n\n');
}

function splitEvidenceWindows(text, maxWords = 120) {
  const all = words(text);
  if (!all.length) return [];
  const windows = [];
  for (let i = 0; i < all.length; i += maxWords) {
    const chunk = all.slice(i, i + maxWords);
    windows.push({
      index: windows.length,
      word_start: i,
      word_end: i + chunk.length - 1,
      word_count: chunk.length,
      preview: chunk.join(' ').slice(0, 240),
    });
  }
  return windows;
}

export function intakeAgent({ proposal = {}, report = {}, source = {} }) {
  const proposalText = textOfProposal(proposal);
  const sourceType = proposal.source_type || report.extracted?.source_type || source.source_type || 'unknown';
  const title = proposal.title || report.extracted?.title || report.analysis?.summary || 'UNKNOWN';
  const options = asArray(proposal.options || report.extracted?.options);
  const unknowns = asArray(report.analysis?.unknowns);
  return {
    role: 'intake_agent',
    status: title === 'UNKNOWN' ? 'needs_review' : 'complete',
    output: {
      title,
      source_type: sourceType,
      source,
      proposal_text_words: words(proposalText).length,
      voting_options_count: options.length,
      unknowns_count: unknowns.length,
    },
  };
}

export function longContextAgent({ proposal = {}, report = {}, maxWords = 120 }) {
  const text = [textOfProposal(proposal), ...(report.analysis?.unknowns || []), ...(report.analysis?.risks || [])].filter(Boolean).join('\n\n');
  const evidence_windows = splitEvidenceWindows(text, maxWords);
  const plan = evidence_windows.map((w) => ({
    window_index: w.index,
    inspect_for: ['proposal intent', 'treasury/action details', 'missing evidence', 'risk claims'],
    preview: w.preview,
  }));
  return {
    role: 'long_context_agent',
    status: evidence_windows.length ? 'complete' : 'needs_review',
    output: {
      max_words_per_window: maxWords,
      evidence_windows,
      plan,
    },
  };
}

export function toolReliabilityAgent({ proposal = {}, report = {}, requiredTools = ['fetcher', 'analyzer', 'verification_hooks', 'multi_agent_council'] }) {
  const checks = [
    { name: 'proposal_title_present', ok: Boolean(proposal.title || report.extracted?.title) },
    { name: 'analysis_summary_present', ok: Boolean(report.analysis?.summary) },
    { name: 'recommendation_present', ok: Boolean(report.recommendation?.suggested_option || report.recommendation?.action) },
    { name: 'verification_hooks_present', ok: Boolean(report.verification_hooks) },
    { name: 'unknowns_are_listed', ok: Array.isArray(report.analysis?.unknowns) },
  ];
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    role: 'tool_reliability_agent',
    status: failed.length ? 'needs_review' : 'complete',
    output: {
      required_tools: requiredTools,
      checks,
      failed,
    },
  };
}

export function councilAgent({ proposal = {}, report = {}, source = {}, runtime = {} }) {
  const state = runMultiAgentCouncil({ proposal, report, source: { ...source, mode: 'week20-agent-pipeline' }, runtime });
  return {
    role: 'council_agent',
    status: state.shared_memory?.verification?.status || 'unknown',
    output: state,
  };
}

export function handoffAgent({ stages = [] }) {
  const blockers = stages.flatMap((stage) => {
    if (stage.status === 'complete' || stage.status === 'verified') return [];
    if (stage.role === 'tool_reliability_agent') return stage.output.failed.map((name) => `Tool check failed: ${name}`);
    if (stage.role === 'council_agent') return stage.output.shared_memory?.verification?.blockers || [];
    return [`${stage.role} status: ${stage.status}`];
  });
  return {
    role: 'handoff_agent',
    status: blockers.length ? 'human_review_required' : 'ready_for_reviewer',
    output: {
      blockers,
      next_actions: blockers.length
        ? ['Resolve listed blockers before relying on the proposal recommendation', 'Attach pipeline artifact to the human review ticket']
        : ['Review recommendation and council hash', 'Use the artifact as evidence for the voting decision'],
    },
  };
}

export function runWeek20AgentPipeline({ proposal = {}, report = {}, source = {}, runtime = {}, maxWords = 120 } = {}) {
  const startedAt = nowIso(runtime);
  const stages = [];
  stages.push(intakeAgent({ proposal, report, source }));
  stages.push(longContextAgent({ proposal, report, maxWords }));
  stages.push(toolReliabilityAgent({ proposal, report }));
  stages.push(councilAgent({ proposal, report, source, runtime }));
  stages.push(handoffAgent({ stages }));
  const completedAt = nowIso(runtime);
  const status = stages.at(-1).status;
  const pipeline = {
    version: 1,
    kind: 'gov-ai-week20-agent-architecture-pipeline',
    started_at: startedAt,
    completed_at: completedAt,
    status,
    stage_count: stages.length,
    stages,
  };
  pipeline.pipeline_sha256 = sha256Json(stages.map((stage) => ({ role: stage.role, status: stage.status, output: stage.output })));
  return pipeline;
}

export function renderPipelineMarkdown(pipeline) {
  const handoff = pipeline.stages.find((stage) => stage.role === 'handoff_agent')?.output || {};
  const council = pipeline.stages.find((stage) => stage.role === 'council_agent')?.output?.shared_memory || {};
  return [
    '# Week 20 agent architecture pipeline',
    '',
    '## Workflow',
    'Intake agent -> Long-context agent -> Tool reliability agent -> Council agent -> Handoff agent',
    '',
    '## Result',
    `- Status: ${pipeline.status}`,
    `- Stages: ${pipeline.stage_count}`,
    `- Pipeline hash: ${pipeline.pipeline_sha256}`,
    `- Council verification: ${council.verification?.status || 'unknown'}`,
    `- Council decision: ${council.decision?.suggested_option || 'UNKNOWN'}`,
    '',
    '## Stage statuses',
    ...pipeline.stages.map((stage) => `- ${stage.role}: ${stage.status}`),
    '',
    '## Human handoff',
    ...(handoff.blockers?.length ? handoff.blockers.map((b) => `- blocker: ${b}`) : ['- no blockers from deterministic pipeline']),
    ...(handoff.next_actions?.length ? handoff.next_actions.map((a) => `- next: ${a}`) : []),
    '',
    '## Why this fits gov-ai',
    'The pipeline keeps the project centered on governance proposals. It turns a proposal analysis into an auditable autonomous workflow with shared state, tool checks, long-context evidence windows, multi-agent council review, and explicit human handoff.',
    '',
  ].join('\n');
}

export function writePipelineArtifacts(pipeline, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'week20-agent-pipeline-output.json');
  const mdPath = path.join(outputDir, 'week20-agent-pipeline-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(pipeline, null, 2));
  fs.writeFileSync(mdPath, renderPipelineMarkdown(pipeline));
  return { json: jsonPath, markdown: mdPath };
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
