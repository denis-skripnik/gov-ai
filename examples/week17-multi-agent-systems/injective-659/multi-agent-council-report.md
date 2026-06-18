# Week 17 multi-agent governance council

## Workflow
Research agent -> Risk analysis agent -> Decision agent -> Verification agent

## Shared state summary
- Facts collected: 2
- High-severity risks: 0
- Decision: YES (medium confidence)
- Verification: verified
- Shared-state hash: d8a75826d79ee30663aa22c45a6afdd5662f7e6981b8223da881a35df102cdaf

## Agent messages
- research_agent: Collected 2 grounded proposal facts
- risk_analysis_agent: Classified 3 risks
- decision_agent: Selected YES with medium confidence
- verification_agent: Council verification verified

## Decision blockers
- none

## Why this improves gov-ai
The normal report remains the model-generated governance analysis. This council adds a deterministic, auditable multi-agent review layer over that report, with explicit shared memory and a verification hash that can be committed or attached to review tickets.
