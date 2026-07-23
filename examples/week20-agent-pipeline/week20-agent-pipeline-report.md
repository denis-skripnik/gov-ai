# Week 20 agent architecture pipeline

## Workflow
Intake agent -> Long-context agent -> Tool reliability agent -> Council agent -> Handoff agent

## Result
- Status: ready_for_reviewer
- Stages: 5
- Pipeline hash: bb66c0a600e763c9213d1aa5a7305ff690f3fb27f067e2c4c108d26385522f71
- Council verification: verified
- Council decision: Against

## Stage statuses
- intake_agent: complete
- long_context_agent: complete
- tool_reliability_agent: complete
- council_agent: verified
- handoff_agent: ready_for_reviewer

## Human handoff
- no blockers from deterministic pipeline
- next: Review recommendation and council hash
- next: Use the artifact as evidence for the voting decision

## Why this fits gov-ai
The pipeline keeps the project centered on governance proposals. It turns a proposal analysis into an auditable autonomous workflow with shared state, tool checks, long-context evidence windows, multi-agent council review, and explicit human handoff.
