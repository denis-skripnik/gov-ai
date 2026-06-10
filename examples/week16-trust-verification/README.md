# Ambient Week 16 — Trust & Verification in gov-ai

Week 16 asks whether verified execution is enough to rely on an AI output.

For `gov-ai`, the answer is deliberately conservative:

> verified inference is useful provenance, but it is not verified truth about a DAO proposal.

## Why this belongs in the main product flow

This is not a separate Web3/trading-agent demo. It extends the existing Ambient → `gov-ai` arc:

- Week 7: users need to understand what Ambient does and does not verify.
- Week 9: `gov-ai` added deterministic / probabilistic / unverifiable verification hooks.
- Week 16: the same distinction is tested on a treasury-spending proposal where a voter needs to decide whether to rely on the output.

The reusable product change is in the core verification hooks:

- `analysis.unknowns` are always classified as `unverifiable`, even when they contain hard literals such as addresses or amounts.
- Reason: the literal address is source text, but control, signer authority, recipient legitimacy, invoice validity, and budget justification require external evidence.

## Reproducible main-pipeline run

Input fixture:

- `treasury-transfer-proposal.json`

Run through the normal product pipeline:

```bash
MULTI_NODE_ENABLED=false AMBIENT_STREAM=false AMBIENT_MODEL=zai-org/GLM-5.1-FP8 node gov-ai.js analyze examples/week16-trust-verification/treasury-transfer-proposal.json
```

This uses:

1. `fetchAndExtract()` local JSON fixture support.
2. `analyzeWithLLM()` against Ambient.
3. `gov-ai.js` post-processing: verification boundary, verification hooks, refusal handling, routing, and report writing.

Retained main-pipeline artifact:

- `gov-ai-main-report.json`

Focused verification-hook snapshot:

- `gov-ai-verification-hooks-output.json`

Supplementary Ambient API exploration artifact:

- `ambient-api-userloop-result.json`

## Scenario

A DAO proposal asks to transfer `250,000 USDC` from the community treasury to `0x1234567890abcdef1234567890abcdef12345678` for Q2 grants funding.

The proposal claims the recipient is the grants multisig, but it does not include:

- invoice;
- multisig signer list;
- recipient-control proof;
- budget breakdown.

## Expected Week 16 behavior

`gov-ai` should separate:

- deterministic proposal facts: amount, address, stated purpose, missing fields;
- probabilistic judgment: treasury-transfer risk and recommendation reasoning;
- unverifiable claims: multisig control, signer authority, recipient legitimacy, budget justification.

The correct routing posture is `WARN`, because a voter still needs external evidence before relying on the analysis.

## Validation commands

```bash
node --test test-fetcher-local-fixture.test.js test-verification-hooks.test.js
node examples/week16-trust-verification/run-existing-verification-hooks.js
MULTI_NODE_ENABLED=false AMBIENT_STREAM=false AMBIENT_MODEL=zai-org/GLM-5.1-FP8 node gov-ai.js analyze examples/week16-trust-verification/treasury-transfer-proposal.json
```

## Takeaway

Ambient can verify execution/provenance of inference. `gov-ai` should still make the trust boundary visible: what is source-anchored, what is judgment, and what is not currently proven.
