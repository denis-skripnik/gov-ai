# Week 11 MVP plan - Telegram bot around gov-ai

## Goal

Build a Week 11 dev-loop MVP that embeds Ambient into a real user-facing system without modifying the existing core analysis scripts. The MVP should add a Telegram bot and adapter layer around the current gov-ai workflow, returning short human-readable summaries and optional detailed web views.

## Constraints

- Do **not** rewrite or fundamentally alter `gov-ai.js`, `pageServer.js`, `analyzer.js`, `fetcher.js`, or `gov-ai-api.js`
- New code should **use** the existing analysis pipeline and reports it produces
- The bot must not expose raw JSON as the primary user output
- The bot should validate URLs before expensive analysis begins
- Payments are out of scope for MVP v1
- If auto-starting `pageServer.js` is unreliable, the bot must still work without it

## Scope

### In scope
- Telegram bot using grammY
- Queueing of user analysis requests
- URL validation for supported proposal sources before execution
- Launching existing gov-ai analysis as a child process
- Reading generated report JSON
- Rendering a short Telegram summary from report data
- Returning optional detailed page URL when page server is available
- Status updates: queued, running, completed, failed
- New isolated files/modules only

### Out of scope
- Refactoring the current gov-ai analysis engine
- Replacing report generation logic
- Web UI redesign
- Payments / Telegram Stars
- Multi-user billing / auth
- Background worker cluster or distributed queue

## Architectural approach

Keep the current stack in layers:

1. **Analysis engine layer**
   - existing `gov-ai.js`
   - existing `reports/` outputs

2. **Detail presentation layer**
   - existing `pageServer.js`
   - optional deep-link to a report page when available

3. **Adapter / orchestration layer**
   - new helper module to:
     - validate proposal URL
     - launch `gov-ai.js`
     - detect output report path
     - parse report JSON
     - build human-readable summary
     - expose execution status

4. **Telegram transport layer**
   - new grammY bot
   - receives links, enqueues jobs, sends status and final summaries

This preserves architectural separation:
- analysis stays in the existing CLI
- transport stays in the bot
- formatting stays in a new presentation helper

## Deliverables

### New files to add
- `bot.js` - Telegram bot entry point
- `bot/queue.js` - in-memory serial queue / job control
- `bot/url-validate.js` - supported-source and format validation
- `bot/run-analysis.js` - launch wrapper around `gov-ai.js`
- `bot/report-locator.js` - determine newest relevant report file
- `bot/summary.js` - convert report JSON into Telegram-friendly output
- `bot/page-link.js` - create page-server URL if available
- `bot/status-store.js` - lightweight job state store
- `week11-bot-mvp/plan.md` - this plan

### Optional support files
- `.env.example` additions for Telegram bot token and public base URL
- README addition later if implementation succeeds

## Detailed behavior

## Job persistence model

Jobs should be stored as **one file per job** rather than one shared mutable state blob.

Recommended storage shape:
- `jobs/<jobId>.json`

Minimum persisted fields:
- `jobId`
- `userId`
- `chatId`
- `inputUrl`
- `sourceType`
- `status`
- `createdAt`
- `startedAt`
- `finishedAt`
- `queuePosition`
- `reportPath`
- `summary`
- `error`

Why this is preferred for MVP:
- simpler recovery after restart
- easier debugging
- lower risk of corrupting all queue state with a single write
- easy filtering of jobs by user

### 1. Bot input flow
User sends a message with a proposal URL.

Bot behavior:
1. Extract URL from message
2. Validate URL
3. If invalid:
   - return clear error
   - do not enqueue
4. If valid:
   - create job id
   - persist initial job file
   - enqueue request
   - send queued confirmation with queue position

Primary user UX should be **inline-button driven**, not dependent on the user typing follow-up commands manually.

Buttons after enqueue:
- `Check status`
- `My jobs`

### 2. Supported URL validation
Validation before execution should check:
- valid URL syntax
- host belongs to supported platforms already handled by gov-ai extraction flow
- URL path shape matches known proposal routes
- reject unsupported or malformed URLs early

Return explicit reasons such as:
- unsupported domain
- malformed proposal path
- missing proposal identifier

### 3. Queue model
MVP queue should be simple and safe:
- default concurrency: 1
- FIFO order
- one active analysis at a time
- queue position visible to user at enqueue time
- every job status transition persisted to its own job file
- per-user active limit: maximum 2 jobs in `queued` or `running`

Statuses for MVP:
- `queued`
- `running`
- `completed`
- `failed`

If a user tries to submit a third in-progress request, reject it before execution with a clear English message.

Optional later:
- `cancelled`
- `interrupted`

This keeps the expensive workflow predictable and avoids overlapping long-running analyses in v1.

### 4. Execution model
For each queued job:
1. mark status `running`
2. send "analysis started" message to user
3. launch existing `gov-ai.js`
4. pass URL via `node gov-ai.js analyze <url>` or env-backed launch strategy if needed
5. wait for process completion
6. detect success / failure
7. locate the generated report file
8. parse report JSON
9. build user summary
10. send final Telegram reply automatically
11. mark job `completed` or `failed`

The user should not need to manually poll to receive the result. Status checks are a convenience layer, not the primary completion mechanism.

## Key implementation choice
Do not attempt to import and execute internals from `gov-ai.js` directly if that creates coupling.
Prefer child-process execution of the existing CLI because it preserves the current source of truth and avoids changing existing scripts.

## Report discovery strategy
Because `gov-ai.js` writes report files to `reports/`, the adapter should:
- capture start timestamp before launch
- after completion, scan `reports/`
- pick the newest report file created after the job start time
- optionally verify by matching report URL to the input URL

If no matching report is found, treat as failure.

## Summary format for Telegram
Primary output must be human-readable, not raw JSON.

### Short summary
Should include:
- proposal title
- source type
- recommended option
- confidence
- short summary
- 2-3 key changes
- top risks
- top unknowns
- warning if refusal handling or verification hooks triggered

Concrete preferred shape:
- Title
- Recommendation
- Confidence
- Key changes
- Risks
- Unknowns
- Warnings
- Detailed page link if available

### Optional detail line
If page server base URL is configured or detectable:
- include a single line with detailed page URL

### Failure summary
If analysis fails:
- explain whether failure came from validation, process failure, missing report, or parse error

## Proposed summary shape
Example shape only, not final wording:
- Title
- Recommendation: X
- Confidence: Y
- Summary: ...
- Key changes:
  - ...
  - ...
- Risks:
  - ...
- Unknowns:
  - ...
- Warnings:
  - refusal detected / mixed verification categories / strict routing etc.
- Detailed view: optional URL

## Telegram UX and callbacks

Inline buttons should be the primary UX layer.

Recommended callback actions:
- `check_status:<jobId>`
- `my_jobs`
- `open_details:<jobId>`
- `analyze_again`

Fallback slash commands may still exist:
- `/start`
- `/help`
- optional `/status <jobId>`
- optional `/my`

But the main interaction path should work through buttons.

## My jobs surface

MVP does not need a dedicated "My proposals" page.

Instead, provide a Telegram-native `My jobs` surface:
- button-driven
- lists recent user jobs
- shows short status rows such as:
  - `#41 queued`
  - `#40 running`
  - `#39 completed`
  - `#38 failed`
- each row or follow-up message should provide a status button

This gives users a practical personal history view without requiring a separate web UI for job management.

## Message flow

### On enqueue
Send:
- accepted URL
- detected source
- queue position
- job id

Buttons:
- `Check status`
- `My jobs`

### On start
Send:
- analysis started
- note that governance analysis may take a while

Buttons:
- `Check status`
- `My jobs`

### On completion
Send:
- short summary
- recommendation
- confidence
- warnings if present
- optional detailed page link

Buttons:
- `Open details`
- `My jobs`
- `Analyze another`

### On failure
Send:
- failed
- short reason

Buttons:
- `Check status`
- `My jobs`
- `Try another URL`

## Page server handling
Two acceptable MVP modes:

### Mode A - page server already running
- bot simply generates links using configured base URL

### Mode B - bot attempts to start page server
- only if safe and not already listening
- if startup fails, continue without detailed page links

Important rule:
The bot must still function if `pageServer.js` is not available.

## Environment/config additions
Expected new env vars:
- `TELEGRAM_BOT_TOKEN`
- `PAGE_SERVER_BASE_URL` optional
- `PAGE_SERVER_PORT` optional reuse
- `BOT_MAX_CONCURRENCY` optional, default 1
- `BOT_QUEUE_LIMIT` optional

Existing env vars already used by analysis remain unchanged.

## Validation / error strategy

### User-visible failures
- invalid URL
- unsupported source
- queue full
- analysis process failed
- report file missing after completion
- report parse failed

### Internal failures to handle safely
- child process exits non-zero
- malformed or incomplete report JSON
- page server unavailable
- duplicate simultaneous requests for same URL (optional later optimization, not required in MVP)

## Milestones

### Phase 1 - orchestration skeleton
- bot entrypoint
- queue
- status store
- URL validation
- child-process runner stub

### Phase 2 - gov-ai integration
- real process launch
- report discovery
- report loading
- error paths

### Phase 3 - presentation
- short summary formatter
- warning extraction from report fields
- optional detailed page URL

### Phase 4 - polish
- better status messages
- graceful page-server handling
- README update if desired

## Acceptance criteria

The MVP is done when:
- a user can send a supported proposal URL to the bot
- invalid URLs are rejected before running analysis
- valid URLs are queued and processed one at a time
- each request is persisted as its own job file
- the bot launches the existing gov-ai analysis without changing its internals
- the bot reads the generated report JSON
- the bot returns a concise human-readable result
- the bot automatically sends the result on completion
- users can inspect status through inline buttons
- users can open a `My jobs` list through inline buttons
- the bot optionally includes a detailed page link if available
- existing project scripts continue to work unchanged

## Risks
- `gov-ai.js` can be long-running, so Telegram UX needs clear status messaging
- report discovery by timestamp may be ambiguous if multiple manual analyses run at once
- page server may already be running or unavailable, so startup must be optional
- summary formatting must avoid dumping too much detail into Telegram

## Recommended implementation direction

Start with the smallest safe composition:
- validate URL
- enqueue
- run existing CLI
- read report
- send concise summary
- make page links optional

This is the cleanest Week 11 MVP because it shows Ambient inside a real workflow without forcing risky changes into the current analysis engine.
