# Changelog

## [Unreleased]

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
