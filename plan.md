# gov-ai bot trust improvements plan

## Goal

Improve the existing Telegram bot layer without changing the basic architecture.

Current architecture stays the same:
- `gov-ai.js` remains the analysis engine
- `bot.js` remains the Telegram entry point
- `bot/queue.js` remains the orchestration and long-running worker flow
- `bot/summary.js` remains the Telegram summary formatter
- `pageServer.js` remains the detailed page surface

The purpose of this plan is to add practical trust improvements that are justified by the current codebase:
- traceability from Telegram summary to report evidence
- better user-facing failure UX
- lightweight feedback capture
- small page-server verification improvements only where the current page is not enough

## Scope

In scope:
- improve Telegram summary trust and wording
- improve failed/delayed/started user messages
- add lightweight feedback buttons and persistence
- strengthen page-server positioning as a verification surface
- add minimal deep links from Telegram to meaningful page sections when they improve usability

Out of scope:
- voting integration
- personalization
- dashboards
- shared/team features
- confidence-score redesign
- major page-server rewrite
- changes to the core `gov-ai.js` analysis architecture unless strictly required for traceability

## Non-goals

- Do not redesign the bot into a larger product
- Do not replace the detailed page with a new UI stack
- Do not add noisy Telegram output with too many links
- Do not reduce summary readability in pursuit of traceability
- Do not degrade the current completion flow or queue behavior

## Current code-grounded findings

### Already implemented
- URL validation before enqueue
- FIFO queue with one worker
- persistent job JSON files in `jobs/`
- queued/running/completed/failed statuses
- per-user active job limit
- `Check status` and `My jobs`
- completion message with HTML summary
- optional detailed page link
- detailed page already exposes much more of the report JSON than Telegram does

### Real gaps confirmed from code
1. Telegram summary has no claim-level traceability
2. Failure messages are too raw and technical
3. There is no lightweight feedback loop in Telegram
4. Confirmation/start/failure copy can be clearer
5. Page server is useful as a detailed surface, but Telegram currently under-signals that it is the place for verification

### Product direction for verification surface
The page server should remain the single detailed verification surface.

Recommendation:
- do **not** add many links inside the Telegram message body
- keep **one main verification-oriented link** visible and clean
- optionally add a very small number of section-specific links only if they are stable and clearly valuable

Preferred direction:
- rename the page link wording from generic detail wording to verification wording
- support section anchors on the page so the bot can link to a relevant verification section when needed
- avoid turning the Telegram summary into a cluttered list of links

## Milestones

### Milestone 1: Improve Telegram summary trust wording without clutter

#### Objective
Make the existing summary more trustworthy and clearer, while preserving readability.

#### Files
- `bot/summary.js`
- possibly `bot/page-link.js`

#### Tasks
1. Replace generic link wording like `Detailed view` with verification-oriented wording.
   - Candidate wording:
     - `Verification details`
     - `Open detailed report`
     - `Details and verification`
   - Recommended default: `Details and verification`

2. Keep one primary link in the message body instead of many inline links.
   - Do not append separate Telegram links after every bullet by default.
   - Preserve compact Telegram UX.

3. Add minimal verification framing around the summary when helpful.
   - Example: short wording that the detailed page contains the full report/evidence surface.
   - This must stay compact and not bloat the message.

4. Prepare summary structure so section-targeted URLs can be used later without requiring a summary rewrite.

#### Acceptance criteria
- Telegram summary remains compact and readable
- There is still only one primary details link in normal flow
- Link wording better communicates verification intent
- No reduction in summary clarity

---

### Milestone 2: Add stable section anchors to page server

#### Objective
Allow the detailed page to function more explicitly as a verification surface.

#### Files
- `pageServer.js`
- possibly helper functions if extracted from `pageServer.js`
- `bot/page-link.js`

#### Tasks
1. Add stable anchor ids to key sections already rendered on the report page.
   - likely sections:
     - source info
     - extracted data
     - analysis
     - recommendation
     - limitations
     - verification
     - verification boundary
     - verification hooks
     - refusal handling

2. Ensure anchor ids are deterministic and language-independent.
   - Example ids:
     - `#source-info`
     - `#analysis`
     - `#recommendation`
     - `#verification`
     - `#verification-boundary`

3. Ensure the page remains readable with anchors and does not regress styling or layout.

4. Add or adjust helper logic so the bot can build links to specific sections when needed.

#### Acceptance criteria
- report pages support stable section URLs
- no visual degradation of the page
- anchor ids remain stable across languages and future report content changes

---

### Milestone 3: Use page-server as verification surface, not just “more details”

#### Objective
Strengthen the role the page already plays, without a full redesign.

#### Files
- `pageServer.js`
- `bot/summary.js`

#### Tasks
1. Review whether the existing page already exposes enough data for practical verification.
   - The page already renders:
     - extracted source data
     - analysis
     - recommendation
     - verification structures
   - Confirm that this is sufficient for MVP verification positioning.

2. If needed, add small verification aids only where the current page is truly insufficient.
   - examples of acceptable additions:
     - clearer section heading language
     - short note near verification-related sections
     - anchor-friendly section structure
   - examples of non-acceptable additions for this phase:
     - full annotation UI
     - claim-by-claim interactive overlays
     - large client-side app behavior

3. If the report contains useful evidence arrays already, ensure they are easy to reach from the page.

#### Acceptance criteria
- page server clearly works as a verification surface for MVP
- no major redesign required
- additions are conservative and do not reduce quality

---

### Milestone 4: Improve failure UX and user-facing error messages

#### Objective
Replace raw technical failures with clear user-facing outcomes.

#### Files
- `bot/queue.js`
- `bot/run-analysis.js`
- possibly a new helper such as `bot/error-format.js`

#### Tasks
1. Introduce error categorization for the most common failure types.
   - validation-related failures that escaped earlier checks
   - report not found after analysis
   - analysis process exit errors
   - page-server unavailable cases, when relevant
   - generic fallback

2. Map technical errors to user-friendly messages.
   - user message should explain:
     - what happened
     - whether retrying makes sense
     - whether the job failed completely or partially

3. Keep raw technical details out of the normal Telegram message.
   - raw error text may still be stored in job JSON for debugging

4. Improve the “analysis started” and queued messages only where clarity improves.
   - avoid duplicative wording
   - optionally include a short proposal label if available at that point

5. Ensure failed jobs still provide useful next actions.
   - check status
   - my jobs
   - analyze another

#### Acceptance criteria
- end users no longer receive raw stderr-like failure text by default
- failure messages are short, clear, and actionable
- debug details remain available in stored job data

---

### Milestone 5: Add lightweight feedback loop in Telegram

#### Objective
Capture simple quality feedback without complicating the workflow.

#### Files
- `bot.js`
- `bot/queue.js`
- `bot/status-store.js`
- possibly new helper such as `bot/feedback-store.js`

#### Tasks
1. Add feedback buttons to completed result messages.
   - recommended buttons:
     - `👍 Helpful`
     - `👎 Needs review`

2. Persist feedback in a minimal way.
   - either extend job JSON with feedback fields
   - or create a small separate feedback record per job

3. Acknowledge feedback with a short callback response.
   - keep it lightweight
   - no forced follow-up flow in MVP

4. Prevent repeated noisy feedback submissions if possible.
   - optionally allow one vote per user per job

5. Keep the UX reversible only if trivial; otherwise first version may simply store the latest value.

#### Acceptance criteria
- completed jobs expose lightweight feedback buttons
- feedback is stored durably enough for later review
- the interaction stays small and non-disruptive

---

### Milestone 6: Minimal traceability path from summary to page sections

#### Objective
Create a practical traceability path without cluttering Telegram.

#### Files
- `bot/summary.js`
- `bot/page-link.js`
- `pageServer.js`

#### Tasks
1. Keep one main verification-oriented link in the summary.
2. Optionally route that link to the most relevant section instead of the top of the page.
   - default recommendation:
     - link to `#recommendation` or `#analysis` only if that improves navigation clearly
     - otherwise link to the top of the page
3. Only add section-specific secondary links if testing shows they improve usability.
   - hard rule: do not add “a куча ссылок” to Telegram by default
4. Consider one optional secondary verification link only if needed.
   - example:
     - `Verification details`
     - `Evidence sections`
   - but only if the final Telegram message remains visually clean

#### Acceptance criteria
- Telegram remains uncluttered
- traceability is improved through page structure and wording
- summary does not become a wall of links

## Implementation order

### Phase 1: lowest risk, highest value
1. Milestone 4: failure UX
2. Milestone 1: summary link wording and trust framing
3. Milestone 2: page section anchors

### Phase 2: trust loop
4. Milestone 5: lightweight feedback buttons
5. Milestone 6: minimal section-targeted linking

### Phase 3: conservative page verification polish
6. Milestone 3: page-server verification refinements only if still needed after Phase 1 and 2

## File-by-file expected changes

### `bot/summary.js`
- revise detail-link wording
- optionally support target section selection
- keep message compact
- do not add many inline claim links in Telegram

### `bot/page-link.js`
- support anchor-aware detail links
- keep backward compatibility with current report URLs

### `pageServer.js`
- add stable anchor ids to key sections
- optionally refine headings/verification wording
- avoid major layout rewrite

### `bot/queue.js`
- improve user-facing queued/started/failed messages
- stop exposing raw technical failure text to users
- add feedback buttons to completed messages

### `bot.js`
- add callback handlers for feedback actions
- keep existing callback UX intact

### `bot/status-store.js`
- persist feedback fields or support feedback write helpers

### Optional new helper files
- `bot/error-format.js` for user-safe error categorization and messages
- `bot/feedback-store.js` only if feedback persistence becomes awkward in `status-store.js`

## Validation strategy

### Manual checks
1. Submit a valid proposal URL
   - confirm queued message is still clear
   - confirm no Telegram clutter regression

2. Wait for a completed result
   - confirm summary still reads well
   - confirm verification-oriented wording makes sense
   - confirm feedback buttons appear and work

3. Open detailed page
   - confirm anchors work
   - confirm section links land correctly
   - confirm page readability is unchanged or improved

4. Trigger a failure path
   - confirm user sees a clean, actionable failure message
   - confirm debug detail remains stored internally

5. Check old flows still work
   - `Check status`
   - `My jobs`
   - `Analyze another`
   - optional page-server unavailable path

### Regression concerns
- avoid breaking Telegram HTML formatting
- avoid adding too many buttons or links
- avoid making page URLs unstable
- avoid coupling bot summary logic too tightly to page structure

## Risks and assumptions

### Risks
- section anchors may become fragile if page headings are refactored carelessly
- overly aggressive traceability additions may clutter Telegram output
- feedback persistence may complicate job schema if done sloppily
- error categorization may miss edge cases at first

### Assumptions
- current report JSON already contains enough structure for useful verification positioning
- page server should remain the main evidence surface instead of pushing verification detail into Telegram
- the best MVP tradeoff is one strong link plus better wording, not many Telegram links

## Mintscan support addendum

### Objective
Add Mintscan proposal URL support through Mintscan's proposal API, with conservative field mapping into the existing extracted shape.

### Constraints
- Do not scrape Mintscan HTML for proposal content.
- Use `front.api.mintscan.io/v11/{chain}/proposals/{proposalId}`.
- Compare mapping against DAO DAO proposal 630 output to avoid degraded analysis inputs.
- Map only reliable fields and leave the rest empty instead of guessing.

### Tasks
1. Accept Mintscan proposal URLs in URL validation.
2. Add a Mintscan fetch fast-path in `fetcher.js`.
3. Normalize Mintscan proposal JSON into the existing extracted contract.
4. Reuse or extend option inference so yes/no/abstain/no-with-veto proposals stay legible.
5. Add stable report filename logic for Mintscan URLs.
6. Run focused checks against Injective 630 and confirm the output is sane.

## Definition of done

This plan is complete when:
- Telegram result messages better communicate that the page is the verification surface
- report pages have stable anchors for key sections
- users get cleaner and more actionable failure messages
- completed jobs support lightweight feedback capture
- Telegram output remains compact and readable
- current queue/status/detail behavior is preserved or improved, not degraded
