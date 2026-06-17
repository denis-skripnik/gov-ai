# Week 17 multi-agent governance council

## Workflow
Research agent -> Risk analysis agent -> Decision agent -> Verification agent

## Shared state summary
- Facts collected: 5
- High-severity risks: 2
- Decision: Against (high confidence)
- Verification: verified
- Shared-state hash: dd83eabd10405dd97d3ea9972ed1cb5c5a96c5404e3d6ea796074894b82b5e2d

## Agent messages
- research_agent: Collected 5 grounded proposal facts
- risk_analysis_agent: Classified 7 risks
- decision_agent: Selected Against with high confidence
- verification_agent: Council verification verified

## Decision blockers
- High-impact execution evidence is incomplete: invoice, multisig signer list, recipient-control proof, budget breakdown
- Treasury transfer of 250,000 USDC targets 0x1234567890abcdef1234567890abcdef12345678, so recipient-control proof should be mandatory before approval

## Why this improves gov-ai
The normal report remains the model-generated governance analysis. This council adds a deterministic, auditable multi-agent review layer over that report, with explicit shared memory and a verification hash that can be committed or attached to review tickets.
