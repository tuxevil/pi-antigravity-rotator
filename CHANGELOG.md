# Changelog

## [Unreleased]

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
