# Changelog

## [1.12.3] - 2026-05-18

### Fixed
- **Gemini 3.1 Pro High Deprecation (`400 Invalid Argument`)**: Google Cloud Code Assist deprecated the internal string `"gemini-3.1-pro-high"` and replaced it with `"gemini-pro-agent"`. The proxy now automatically maps `"gemini-3.1-pro-high"` to `"gemini-pro-agent"` under the hood when constructing the upstream payload, preventing `400` validation errors while allowing clients to continue using the `-high` alias.
- **Missing `thought_signature` on Tool Calls (`400 Invalid Argument`)**: Gemini thinking models strictly require a cryptographic Base64 `thought_signature` for all `functionCall` history parts, which the proxy normally caches in RAM. To prevent API rejection on cache misses (e.g. after a proxy restart or when using synthetic tool IDs), the proxy now gracefully collapses the orphaned tool exchange into a neutral user summary (`[Context: The assistant used tools...]`). This preserves the conversation context without triggering the `400` error or teaching the model bad tool-calling formats.

## [1.12.2] - 2026-05-18

### Fixed
- **Gemini Flash/Pro regression (`INVALID_ARGUMENT`)**: The `id` field added to `functionCall` and `functionResponse` history parts for Claude multi-turn support was also being sent to Gemini native models, which reject it. The field is now only included when the model is Claude (`/^claude-/i`).

## [1.12.1] - 2026-05-18

### Fixed
- **Claude tool schema compatibility (JSON Schema Draft 2020-12)**: When routing requests to Claude models (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`) through Gemini's API, a new `sanitizeClaudeViaGeminiSchema` function is used instead of the Gemini-native sanitizer. It only removes fields that Gemini's outer API layer rejects (e.g. `$ref`, `$defs`, `if/then/else`) and converts `const` → `enum`, while preserving valid Draft 2020-12 keywords (`minimum`, `maximum`, `pattern`, `minLength`, `title`, `default`, etc.) that Claude requires.
- **Claude `anyOf [{type,const}]` → flat `enum` collapse**: Schemas with `anyOf` items of the form `[{"type":"string","const":"fact"},{"type":"string","const":"lesson"}]` are now correctly collapsed into `{"type":"string","enum":["fact","lesson"]}`. Previously this produced a redundant `anyOf` with single-element enums that Claude rejected as invalid.
- **Claude multi-turn tool call IDs (`tool_use.id: Field required`)**: When replaying tool-call history for Claude models, the OpenAI tool call `id` (e.g. `call_xxx`) is now included in the Gemini `functionCall.id` field, and the `tool_call_id` from tool response messages is included in the Gemini `functionResponse.id` field. Gemini passes these through to Claude as `tool_use.id` / `tool_use_id`, fixing the "Field required" error on multi-turn agentic conversations.

## [1.12.0] - 2026-05-17


### Added
- **Native Reasoning/Thinking Support**: Interleaved thinking blocks from Gemini 3.1 Pro, Gemini 3 Flash, and Claude models are now properly exposed to OpenAI and Anthropic compatible clients as `reasoning_content` and `thinking_delta` chunks.
- **Model & Project Circuit Breaker Reset**: Added manual reset buttons on the dashboard for all circuit breakers, allowing operators to bypass the cooldown period when desired.
- **Circuit Breaker Visibility**: Added model-level and project-level circuit breaker state (active flags and remaining cooldowns) to the `/api/status` endpoint and the dashboard.

### Fixed
- **Gemini 3 Thinking Levels**: Fixed an issue where Gemini 3 models failed to return reasoning blocks without a defined `reasoning_effort` flag by automatically inferring the necessary `thinkingLevel` from the model alias (`-high` or `-low`).

## [1.11.0] - 2026-05-17

### Added
- **Universal Agent Support (Pi, Hermes, OpenWebUI, etc.) via OpenAI-compatible provider**: This package is no longer exclusive to the Pi agent. With full tool calling support now implemented, the rotator can be seamlessly consumed by *any* agent using an OpenAI-compatible provider profile. Point the provider base URL to `http://localhost:51200/v1/` and set any non-empty string as the API key. All Antigravity models (`gemini-3-flash`, `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`) are available through `GET /v1/models`.
- **Full tool/function calling support for compatibility adapters**: Safely maps standard OpenAI function definitions into Gemini's format, allowing agents to fully utilize tools.
- **XML-based tool call parsing**: Processes XML `<model_context>` artifacts from Gemini responses and formats them as standard OpenAI tool calls.
- **`userAgent: "antigravity"` in request body**: Added the required `userAgent` field to all forwarded payloads so the Antigravity endpoint treats them as first-party agent traffic.

### Fixed
- **Gemini schema sanitization**: Converts `anyOf` with `const` patterns in JSON schemas into Gemini-compatible `enum` arrays. Excludes `exclusiveMinimum` and `exclusiveMaximum` keywords to prevent Gemini 400 Bad Request errors.
- **Multi-turn tool call artifacts**: In multi-turn chat history, previous tool calls and results are now flattened to text to prevent 400 Bad Request rejection from Gemini.
- **Daily endpoint prioritization**: Added `daily-cloudcode-pa.googleapis.com` as the primary endpoint with `cloudcode-pa.googleapis.com` as fallback. The daily endpoint accepts Antigravity payloads without rate-limiting them as RESOURCE_EXHAUSTED — matching CLIProxyAPI's approach from the same fix.
- **`modelBreakers` not exposed in `/api/status`**: Model-level circuit breakers were persisted inside the `safety` sub-object of `state.json` but not surfaced in the API status response, making them invisible to operators when debugging "All accounts disabled" errors.

## [1.10.1] - 2026-04-30

### Fixed
- **Telemetry Flag Validation**: The telemetry receiver now validates `flag` payloads separately from heartbeat payloads, so `quota API 403` flags are written to `YYYY-MM-DD-flags.jsonl` and counted in the dashboard.
- **Flag Analysis Clarity**: Dashboard flag stats now show both raw `Flag Events` and deduped `Unique Flag Incidents`.

## [1.10.0] - 2026-04-30

### Added
- **OpenAI-compatible adapter**: Added `GET /v1/models` and non-streaming/compat-streaming `POST /v1/chat/completions` so OpenAI-style clients can use the rotator.
- **Anthropic-compatible adapter**: Added non-streaming/compat-streaming `POST /v1/messages` so Anthropic-style clients can use the rotator.
- **Image input for adapters**: Added base64 image support for OpenAI data URLs and Anthropic base64 image sources.
- **Model-wide 429 circuit breaker**: If multiple unique accounts hit provider `429` for the same quota model in a short window, routing for that model pauses globally to avoid burning the pool.
- **Local request-safety notes**: Added ignored local docs under `docs/request-safety/` for incident analysis and agent retry policy.

### Changed
- **Retry semantics for exhausted capacity**: Temporary no-capacity states now return `429` with `Retry-After`/`retryAfterMs`; terminal no-capacity states return `503` with `retryable:false`.
- **Quota polling policy**: Quota API `401/403` still flags the affected account, but no longer triggers global protective pause. Polling remains diagnostic so operators can see blast radius.
- **429 containment**: Provider `429` responses stop the current request and feed circuit breakers instead of exposing more accounts to retry storms.
- **Dashboard status header**: Dashboard now shows the running rotator version in the header.

### Fixed
- **Quota poll cascade visibility**: Quota polling can now continue discovering account state instead of being blocked by nuclear pause.
- **Client retry storm risk**: Rotator responses now provide explicit retry timing to downstream agents so they can back off instead of retrying rapidly.

### Limitations
- Compatibility adapter streaming currently buffers the upstream Antigravity stream and emits a final SSE delta; token-by-token passthrough is not implemented yet.
- Tool/function calling through compatibility adapters is explicitly rejected with `400` until a safe mapper is implemented.

## [1.9.3] - 2026-04-29

### Added
- **Admin Broadcast Notifications**: The dashboard now supports operator-controlled broadcast notifications. A new `notification-poller` checks the telemetry server every 30 minutes for active announcements, allowing operators to push critical alerts (like required re-enrollments or bug notices) to all connected clients.
- **Admin Notification UI**: The telemetry receiver now includes a full dashboard at `/notifications` to create, edit, delete, and preview broadcast messages with version-targeting capabilities.

### Changed
- **Telemetry Heartbeat**: Reduced the telemetry heartbeat interval from 6 hours to 1 hour for more timely metrics reporting.

## [1.9.2] - 2026-04-29

### Fixed
- **Project Discovery Without Shared Fallback**: Login now fails if Google does not return a companion project ID. No more shared `rising-fact-p41fc` fallback.
- **Activation Hint**: Login/discovery errors now tell you to open the account in Antigravity IDE and send one message first.
- **Activation Docs**: README now documents the first-use activation rule for new accounts.

## [1.9.1] - 2026-04-29

### Fixed
- **429 Account-Safety Backoff**: All provider-side `429` responses now stop the current request instead of immediately retrying another account. This prevents cascade-burning the full pool when Google rate-limits a shared project/request bucket. `RESOURCE_EXHAUSTED` gets a 30-minute cooldown; other 429s use parsed `Retry-After`/retry-delay.
- **Stream Idle Crash Safety**: Stream idle timeout now closes cleanly without emitting an unhandled stream error that could crash-loop systemd.

### Added
- **Project Circuit Breaker**: If multiple accounts sharing a `projectId` hit provider `429` for the same quota model inside a rolling window, routing pauses that `projectId`/model instead of burning sibling accounts.
- **Daily Safety Budgets**: Per-account and per-`projectId` daily upstream attempt counters now trigger slow-mode jitter and hard stops until the next UTC day.
- **Project Concurrency Guard**: Added `maxConcurrentRequestsPerProjectModel` to prevent simultaneous calls through multiple accounts backed by the same provider project bucket.
- **Large Context Warning**: Requests above 1 MiB now log a warning because huge contexts increase rate-limit and flag pressure.

## [1.9.0] - 2026-04-29

### Added
- **Version Check & Auto-Update**: The dashboard now checks the npm registry every 30 minutes for new releases. When a newer version is available, a gradient banner appears at the top with the current and latest version, a link to the GitHub changelog, and a one-click "Update Now" button. The update runs `npm install -g pi-antigravity-rotator@latest` (auto-detects global vs local installs). After updating, a green "Restart required" notice is shown. The banner can be dismissed per-version (stored in `localStorage`). Version checks fail silently when offline.
- **Self-Update API**: New `POST /api/self-update` endpoint (admin-only) that triggers the npm update from the dashboard.

## [1.8.6] - 2026-04-29

### Fixed
- **4h/8h/12h/1d charts empty for non-UTC timezones**: `mergeBucketsBy` normalized bucket periods to local time, then `padBuckets` re-applied `getLocalKey` treating those local-time strings as UTC — double-converting them and shifting all data outside the visible window. Fixed by passing the same `keyFn` to both `mergeBucketsBy` and `padBuckets`, so the fill loop uses the exact same key format as the data map.

## [1.8.5] - 2026-04-29

### Fixed
- **4h / 8h / 12h views empty**: These views only pulled from `minutes` buckets. Minutes older than ~2h are rolled into `hours` and removed, leaving those views blank. Fixed by including `hours` as a data source alongside `minutes` for all sub-day views.

## [1.8.4] - 2026-04-29

### Changed
- **Dashboard Savings by View**: The "Savings: $X" figure in the token usage chart now reflects only the visible time window (1h / 2h / 4h / 8h / 12h / 1d / 7d / 1m) instead of all-time totals. Per-model savings in the legend also update accordingly. Pricing table (`MODEL_PRICING_CLIENT`) is kept in sync with the server-side `MODEL_PRICING` in `types.ts`.

## [1.8.3] - 2026-04-29

### Fixed
- **Token Usage Deduplication (Critical)**: `getTokenUsage()` now correctly excludes minute buckets that have already been rolled up into hour buckets, and hour buckets rolled into day buckets, etc. Previously the hierarchical rollup structure caused all-time totals to be correct only in edge cases. Fixed by filtering each bucket level against the next level up before summing. Exposed `tokensByModel` directly on `TokenUsageData` for clean access in telemetry payload.

## [1.8.2] - 2026-04-29

### Fixed
- **Token Usage Overcounting**: `getTokenUsage()` was summing `minutes + hours + days + months` buckets, which are hierarchical rollups of the same data — causing every token to be counted ~4×. Now reads only the raw `minutes` buckets (source of truth). Telemetry payload corrected accordingly. Historical JSONL data on the receiver was inflated; divide by ~4 for real estimates.
- **Telemetry Dashboard Filters**: Added server-side filtering to `/v1/stats` by `installId`, `version`, `os`, `model`, `from`, `to` query params.
- **Telemetry Web Dashboard**: Added interactive filter bar with auto-populated dropdowns for all filter dimensions. Active filter indicator shows current scope. Auto-refresh respects active filters.
- **Telemetry Endpoint**: Updated to `http://telemetry.dragont.ec:3800/v1/events` (port explicit until reverse proxy is configured).

## [1.8.0] - 2026-04-29

### Added
- **Anonymous Telemetry**: Opt-out telemetry to help understand real-world usage and, crucially, to improve the anti-flag algorithm that protects your accounts. Collects pool metrics, error patterns, and flag triggers without capturing any PII or emails.
- **Telemetry Receiver**: Included a standalone Node.js server (`tools/telemetry-receiver/`) for deploying your own instance to collect telemetry securely via JSONL files.
- **Server-Side Savings Calculation**: The receiver now computes estimated USD savings directly from raw per-model token usage reports, ensuring pricing updates don't require client updates.
- **Star Reminder**: A one-time, non-intrusive terminal prompt shown after 24 hours of successful use, encouraging a GitHub star.

## [1.7.0] - 2026-04-29

### Security
- **API Protection**: Added `PI_ROTATOR_ADMIN_TOKEN` environment variable to optionally secure the web dashboard and `/api/*` endpoints. If not set, it retains local open access.
- **Payload Limits**: Added `PI_ROTATOR_MAX_BODY_BYTES` to protect the proxy from memory exhaustion via oversized payloads (defaults to 25 MiB).
- **Dashboard Hardening**: Implemented strict HTML escaping across all dynamic fields in the dashboard to prevent XSS.
- **Log Redaction**: Centralized logging now automatically redacts sensitive tokens (Bearer, OAuth, refresh/access tokens) before outputting to the console.

### Added
- **Automated Checks**: Integrated a test suite (`node:test`) and typechecking (`tsc --noEmit`) to prevent regressions. Added `npm run check`.
- **Config Validation**: Runtime validation for the initial config load and proxy request bodies.
- **Resilience**: Added automated retries with exponential backoff for non-streaming internal requests (Quota, OAuth, Token Refresh).

### Changed
- **Telemetry UI**: Refreshed the token usage chart colors to function as a visual "price heat map" (Opus in Red, Pro High in Blue, Pro Low in Light Blue, etc.).
- **Logging**: Added `PI_ROTATOR_LOG_LEVEL` (debug, info, warn, error, silent) for fine-grained logging control.

## [1.6.0] - 2026-04-29

### Added
- **Dual-Window Tracking**: Advanced tracking for both Free and Pro quota windows simultaneously.

## [1.5.0] - 2026-04-28

### Added
- **Pro Family Advisor**: A new smart assistant in the dashboard that scans your account pool and alerts you if there are routing imbalances or underutilized accounts, giving actionable steps to fix them.
- **Advanced Telemetry & Statistics**:
  - Estimated API Savings ($USD) to track how much money the tool saves you.
  - Latency tracking (p50/p95) per model to detect degraded accounts.
  - Quota Forecast grid predicting when each model will exhaust its quota based on current burn rate.
  - Searchable Request Log directly in the dashboard.
  - 60-day historical usage Heatmap.
  - Data export to CSV and JSON formats.
- **Creator Support**: Added a Ko-fi donation modal and header button to support the maintainer.

## [1.4.24] - 2026-04-28

## [1.4.21] - 2026-04-28

### Changed
- **Dual-Window Architecture**: Completely rewrote the dual-window tracker to use immutable, permanent anchors. Anchors are never deleted, only refreshed when their physical date expires.
- **Dual-Window Logic**: A timer is classified strictly by matching its reset date against the permanent Pro or Free anchors. New anchors are assigned to Pro ONLY if a genuine 5h timer is present, otherwise they default to Free.
- **Manual Anchor Override**: Added a UI button in the dashboard to manually swap Pro and Free anchors for a model, giving users absolute control to correct the state if Google's API behavior causes a misclassification.

## [1.4.11] - 2026-04-28

### Fixed
- **Dual-Window Recharging Logic**: The dashboard now correctly distinguishes between expired 5h timers (which grant +40% quota) and expired 7d timers (which grant 100% quota) when visually projecting available capacity.

## [1.4.10] - 2026-04-28

### Changed
- **Dual-Window Display**: The dashboard now automatically assumes 100% quota and displays "ready" in green for dual-window timers whose reset dates have already passed, eliminating the need to manually compute past reset timestamps.

## [1.4.8] - 2026-04-28

### Fixed
- **Dual-Window Cross Contamination**: Fixed an edge case where switching an account back to Free tier would mistakenly classify its new Free 7d timer as a Pro 7d cooldown due to a loose time tolerance and overly aggressive cross-model correlation.
- Reduced dual-window reset time matching tolerance from 1 hour to 5 minutes to prevent identical fallback timer assignments.

## [1.4.7] - 2026-04-28

### Added
- **Dual-Window Dashboard UI**: Added a dedicated visual section to each account card in the dashboard showing the exact Pro vs Free quota and reset timers side-by-side.

## [1.4.6] - 2026-04-28

### Added
- **Dual-Window Quota Tracking**: Pro Family Advisor now simultaneously tracks both Free and Pro quota windows for the same account. It correctly identifies whether a 7-day timer is a Free tier reset or a Pro tier cooldown by correlating reset times.
- **Cross-Model Pro Correlation**: If any model on an account shows a 5h (Pro) timer, the rotator now intelligently infers that all other models on that account are also currently Pro, even if they are in their 7d cooldown phase.

## [1.4.5] - 2026-04-28

### Added
- **Extended Token Views**: Added `2h`, `4h`, `8h`, and `12h` options to the Token Usage chart. The backend now retains up to 12 hours of minute-level resolution for accurate high-fidelity zooming.

### Changed
- **Activity Heatmap Scaling**: Expanded the heatmap to cover the last 60 days. The grid is now responsive, taking up the full width of the screen without distorting cell proportions, and the Y-axis now orders hours naturally from 00 to 23.
- **Timezone Alignment**: X-axis labels on the Token Usage chart and the Heatmap now correctly reflect the browser's local time instead of UTC.

## [1.4.1] - 2026-04-28

### Added
- **Export Data**: Added `CSV` and `JSON` export buttons to the Token Usage panel on the dashboard to easily download token metrics for external reporting.

## [1.4.0] - 2026-04-28

### Added
- **Savings Estimation**: Dashboard now calculates and displays estimated USD savings based on tracked token usage compared to paid API pricing.
- **Latency Tracking**: Proxy measures Time-to-First-Byte (TTFB) and Total duration per request. Dashboard displays p50/p95 latency stats by model.
- **Quota Forecast**: Dashboard predicts when each model's quota will run out based on real-time requests/hour burn rate.
- **Live Dashboard (SSE)**: Dashboard now updates in real-time via Server-Sent Events, removing the need for polling or manual refreshes.
- **Live Request Log**: Searchable, real-time mini-log in the dashboard showing the last 200 requests (Account, Model, Status, TTFB, Total duration, Tokens).
- **Activity Heatmap**: GitHub-style contribution grid displaying request intensity per hour across the last 7 days.
- **Enhanced Logging**: Added explicit `START` and `END` proxy logs with unique request IDs for unambiguous tracing of 503s and 429s.

### Changed
- Configurable **Antigravity Version**: Extracted hardcoded `QUOTA_USER_AGENT` into an environment variable to prevent "This version of Antigravity is no longer supported" API errors. Now uses `1.107.0` by default.
- Per-model cooldown granularity: Accounts can now serve fallback models (e.g. Gemini) even if their primary model (e.g. Claude) is exhausted.
- **Token Tracking Architecture**: Refactored token usage into a tiered time-series (minutes/hours/days/months) with rolling sliding windows to avoid data drops at calendar boundaries.

### Fixed
- Fixed in-flight request leak where accounts could get stuck in a "busy" state indefinitely due to deprecated `req.aborted` handlers in Node 24.
- Fixed rate-limit logic bypassing model-specific cooldown checks after a 429 was hit.


## [1.3.9] - 2026-04-27

### Fixed
- Fixed `ERR_MODULE_NOT_FOUND` crash on `pi-antigravity-rotator login` (and all other CLI commands) when installed globally via npm or Volta. The binary entry point was resolving `src/cli.ts` relative to `bin/` instead of the package root, causing Node to look for `bin/src/cli.ts` which does not exist in any install layout. Changed import path from `./src/cli.ts` to `../src/cli.ts`.

## [1.3.8] - 2026-04-26

### Fixed
- Persist per-model request-count rotation counters across restarts so configured request thresholds continue to work after service reloads.
- Keep serving from the current healthy account when request-count rotation reaches its threshold but no replacement account is available, avoiding unnecessary `503` responses while usable quota remains.

## [1.3.7] - 2026-04-25

### Fixed
- Release in-flight account reservations when a streaming response closes early, the client disconnects, or the upstream stream goes idle, preventing accounts from getting stuck as busy indefinitely.

## [1.3.6] - 2026-04-24

### Fixed
- Treat Node `fetch failed` transport errors as transient upstream/network failures instead of account health errors, avoiding false account disables during stalled requests.

## [1.3.5] - 2026-04-24

### Fixed
- Make request-count rotation deterministic by counting per-model account assignments before the next request is forwarded, instead of rotating only after a successful response completes.

## [1.3.4] - 2026-04-24

### Fixed
- Rotate fairly among accounts that tie on model timer priority and remaining quota instead of repeatedly selecting the first matching candidate.

## [1.3.3] - 2026-04-23

### Added
- Hosted Antigravity login flow so operators can complete Google account linking from a browser and feed the callback URL back into the rotator workflow.
- Global fresh-window operator control plus per-account override so dormant quota windows can be blocked pool-wide and selectively re-enabled account by account.
- Header modal launchers for Attention Needed and Pro Family Advisor to keep operator actions available without taking permanent dashboard space.

### Changed
- Reworked the dashboard layout to prioritize the account grid above the fold: request totals moved into the header, bulky summary widgets were removed, and Recent Events now sits at the bottom.
- Simplified the header by moving the PII visibility toggle next to the title and removing the inline model-routing pills.
- Tightened the routing health strip with denser pills, single-line counters, and clearer spacing between major dashboard sections.

## [1.3.2] - 2026-04-23

### Added
- Routing health panel in the dashboard with current state, stop reason, retry window, and pool blocker counts.
- Attention Needed summary panel for flagged, cooling, disabled, and error accounts.
- Recent Events feed showing the latest rotator and proxy incidents that led to the current state.
- In-memory event buffer exposed through the status API for dashboard diagnostics.
- Conservative concurrency guardrail to cap each account to one in-flight request by default.
- Protective pause after serious provider ToS/abuse-style flags to stop the rest of the pool from being burned.

### Changed
- Dashboard now focuses on operator visibility so the service can be monitored without relying on `journalctl`.
- Request-count rotation is now only used when quota data is still unknown, reducing unnecessary account churn.
- Flagged accounts remain quarantined until the provider explicitly restores access.

### Fixed
- Fixed the exhausted fallback path so cooled-down accounts are no longer selected again when all accounts are exhausted.
- Fixed proxy retry behavior so it returns `503` immediately when no healthy replacement account exists instead of continuing to hammer the pool.
- Fixed quota polling so flagged accounts are no longer re-polled every cycle after a provider `403`.
- Fixed bursty same-account pressure by reserving accounts during selection and request handling.

## [1.3.1] - 2026-04-22

### Changed
- Prioritize Pro 5h accounts in rotation. Accounts with active 5h timers are now drained first to maximize the +40% recharge benefit when the timer expires. Previously they were saved for last, wasting quota.

## [1.3.0] - 2026-04-22

### Added
- Pro Family Sharing Advisor: dashboard panel suggests when to add/remove accounts from Pro family sharing.
- Pro/Free/Family Manager badges on account cards (auto-detected from 5h/7d timer type).
- `familyManager` config flag for the account that owns the family plan.
- `proSlots` config option for max simultaneous Pro accounts (default 6).
- Advisor prioritizes accounts by longest reset time when suggesting Pro upgrades.
- Only G3Pro and Claude quotas considered for remove-pro decisions (Flash ignored).


## [1.2.0] - 2026-04-22

### Added
- PII masking mode for dashboard (`?mask` URL param or toggle button). Masks emails and labels for screen recordings.
- Contextual help hints for flagged accounts (verification instructions, Google Account Recovery link).
- Model-aware quota rotation: accounts with 0% quota for the requested model are skipped instead of wasting requests.

### Fixed
- Fixed `ReadableStream is locked` crash by using `Response.text()` and `Readable.fromWeb()` instead of raw ReadableStream API.
- Fixed `ERR_HTTP_HEADERS_SENT` crash when retrying after response headers were already sent.
- Fixed 403 fallthrough bug: non-flagging 403 responses consumed the body then fell through to streaming, causing locked stream errors.
- Accounts needing verification (`Verify your account`) are now flagged immediately instead of retried.
- Dashboard URL routing now handles query parameters correctly.

## [1.1.0] - 2026-04-22

### Changed
- Use prod endpoint only (`cloudcode-pa.googleapis.com`). Removed daily/autopush endpoints that caused multi-minute hangs.
- 503 errors (no capacity) are now returned directly to the agent for its own retry/backoff instead of burning through all accounts.
- Quota-based rotation only triggers if a healthy account is available. The proxy won't rotate away from a working account if there's no better alternative.
- Dashboard accounts are sorted by total quota (highest first), flagged/disabled last.
- Config files now default to `~/.pi-antigravity-rotator/` (overridable via `PI_ROTATOR_DIR` env or `--config-dir` flag).

### Added
- `POST /api/reset-cooldowns` endpoint to clear all cooldowns at once.
- CLI entry point with `start`, `login`, and `status` commands.
- 30-minute max cooldown cap on all exhaustions (prevents multi-day cooldowns).
- Stale cooldowns from `state.json` are capped to 30 minutes on startup.
- Case-insensitive authorization header handling (fixes duplicate header bug with pi agent).
- MIT License.

### Fixed
- Fixed duplicate `Authorization` header causing 401 on all accounts. Pi sends lowercase `authorization`; the proxy was keeping both the original and the new one.
- Fixed infinite retry loop when all accounts are exhausted or 503 (no capacity).
- Fixed quota rotation moving away from the only working account when no alternatives are available.

## [1.0.0] - 2026-04-22

### Added
- Initial release.
- Per-model routing (Gemini Pro, Flash, Claude).
- Quota-based rotation with configurable drop threshold.
- Request-count-based rotation (fallback).
- 429 failover with automatic cooldown.
- Account protection: quota API 403, API 401, API 403 keyword detection.
- Real-time dashboard with account cards, quota bars, and model routing table.
- OAuth login helper with automatic pi agent configuration.
- State persistence across restarts.
