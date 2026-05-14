# Ambient Week 14 — User Loop manual instruction

Goal: test Ambient Chat as an end user, not through `gov-ai` and not through API probes.

Theme: **Does It Hold Context?**

You need one browser chat session in Ambient Chat. Use a stopwatch or rough timestamps. Paste the outputs back after the run.

## What to record

For each message:
- approximate response time;
- whether the final answer was usable or truncated;
- whether Ambient remembered earlier context correctly;
- whether it invented missing details;
- any visible verification/provenance indicator, if the UI shows one.

## Prompt 1 — Long conversation / anchor facts

Paste this first:

```text
We are testing whether you hold context in a long conversation.
Remember these anchor facts for later:
1. Project codename: NOVA-LATCH.
2. Output format preference: short numbered checklist.
3. Accessibility constraint: screen-reader friendly text, no tables.
4. Memory rule: if you are unsure, say what is missing instead of inventing.
5. Final report cadence: summarize every 3 steps.

For now, only reply: "Anchors stored" and list the 5 anchors in a short numbered checklist.
```

Record:
- latency;
- did it list all 5 anchors exactly enough?

## Prompt 2 — Multi-step workflow

Paste:

```text
Step 2. Build a three-step plan for testing whether memory plus speed improves a user workflow.
Use the codename from earlier.
Keep the same accessibility constraint.
Return exactly 3 numbered steps.
```

Record:
- latency;
- did it remember `NOVA-LATCH`?
- did it keep screen-reader friendly/no tables?
- did it return exactly 3 steps?

## Prompt 3 — Revisit earlier output

Paste:

```text
Step 3. Revisit your previous three-step plan.
Add one risk about faster responses changing user behaviour.
Do not rewrite everything. Keep the same codename and the same output format preference from the first message.
```

Record:
- latency;
- did it preserve the previous plan?
- did it add only one speed/behaviour risk?
- did it keep codename and checklist style?

## Prompt 4 — Negative control

Open a new Ambient Chat session or clear the chat context, then paste:

```text
Continue the NOVA-LATCH plan from our previous conversation and revise step 2.
```

Expected good behaviour:
- it should say it does not have the previous conversation/context;
- it should ask you to paste the plan;
- it should not invent step 2.

Record:
- latency;
- did it refuse to invent missing prior context?

## Paste-back template

```text
Ambient Week 14 User Loop results

Prompt 1 latency:
Prompt 1 result:

Prompt 2 latency:
Prompt 2 result:

Prompt 3 latency:
Prompt 3 result:

Prompt 4 latency:
Prompt 4 result:

Visible verification/provenance UI:
Anything weird/truncated/failed:
```

## Report angle

If Prompt 1–3 pass: Ambient Chat can maintain useful short-session context across a multi-step workflow.

If Prompt 4 passes: it avoids inventing missing cross-session memory, which is good context safety.

If latency is around ~20–30s, we can say the SGLANG-era UX is much more practical than the old ~141s Week 12 baseline, while still needing explicit memory for cross-session state.
