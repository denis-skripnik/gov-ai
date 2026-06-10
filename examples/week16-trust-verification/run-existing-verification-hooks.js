import fs from 'node:fs';
import { classifyVerificationHooks } from '../../analyzer.js';

const extracted = {
  title: 'Q2 grants treasury transfer',
  body: 'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding. The recipient is described as the grants multisig, but no invoice or multisig signer list is included.',
  options: ['For', 'Against'],
};

const report = {
  analysis: {
    summary: 'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding.',
    risks: [
      'The recipient is described as the grants multisig, but this identity is not independently proven by the proposal text.',
      'No invoice or signer list is included, so delegates should not rely on the label before voting.',
    ],
    unknowns: [
      'Whether 0x1234567890abcdef1234567890abcdef12345678 is actually controlled by the grants multisig.',
      'Whether the 250,000 USDC budget matches approved grant obligations.',
    ],
    evidence_quotes: [
      'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding.',
      'The recipient is described as the grants multisig, but no invoice or multisig signer list is included.',
    ],
  },
  recommendation: {
    suggested_option: 'Against or abstain until evidence is provided',
    confidence: 'medium',
    reasoning: 'Verified inference can classify the claim boundaries, but it does not prove the recipient identity or spending justification.',
  },
};

const hooks = classifyVerificationHooks(report, extracted, { strictMode: true });
fs.writeFileSync(new URL('./gov-ai-verification-hooks-output.json', import.meta.url), JSON.stringify({ extracted, report, verification_hooks: hooks }, null, 2));
console.log(JSON.stringify({ routing_action: hooks.routing_action, mixed: hooks.mixed_categories_detected, strict_rejection: hooks.strict_rejection_triggered, segments: hooks.segments.length }, null, 2));
