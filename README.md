# Pi Antigravity Rotator

Multi-account rotation proxy for Google Antigravity. Distributes API usage across multiple Google accounts with per-model routing, real-time quota tracking, automatic token management, and infringement detection.

## Features

- **Per-model routing** -- Each model (Gemini Pro, Flash, Claude) routes to its own active account independently. Multiple agents using different models won't interfere with each other.
- **Real-time quota monitoring** -- Polls Google's quota API every 5 minutes to track remaining usage per model per account
- **Per-model timer tracking** -- Timer priority (fresh/7d/5h) is evaluated per model using each model's actual `resetTime` from the quota API, not a per-account estimate
- **Smart rotation** -- Rotates only the specific model whose quota dropped, leaving other models on their current accounts
- **Infringement detection** -- On 403 with infringement/abuse/suspension keywords, the account is immediately flagged and excluded from routing
- **Automatic failover** -- On 429 rate limits, instantly switches the affected model to the next available account
- **Concurrency guardrails** -- Limits each account to one in-flight request by default to avoid bursty pressure
- **Protective pause** -- Pauses all routing for several hours after serious ToS/abuse-style flags so the rest of the pool is not burned
- **Token auto-refresh** -- Tokens are refreshed automatically before expiry; no manual management
- **Endpoint cascade** -- Tries daily, autopush, and prod API endpoints for resilience
- **Web dashboard** -- Real-time view of model routing table, per-account quota bars with per-model timers, and flagged account alerts
- **State persistence** -- Survives restarts; routing assignments, cooldowns, and flags are saved to disk

## Quick Start

### Option A: Install from npm

```bash
npm install -g pi-antigravity-rotator

# Add your first account
pi-antigravity-rotator login

# Start the proxy
pi-antigravity-rotator start
```

### Option B: Clone from source

```bash
git clone https://github.com/tuxevil/pi-antigravity-rotator.git
cd pi-antigravity-rotator
npm install

# Add your first account
npm run login

# Start the proxy
npm start
```

## Adding Accounts

Run `npm run login` once per Google account:

1. A Google OAuth URL is printed to the terminal -- open it in your browser
2. Complete the sign-in and grant permissions
3. The browser redirects to a `localhost` URL that won't load -- this is expected
4. Copy the **full URL** from the browser's address bar and paste it into the terminal

The tool automatically:

- Creates or updates `accounts.json` with the account credentials
- Configures `~/.pi/agent/models.json` to point `google-antigravity` at the proxy
- Configures `~/.pi/agent/auth.json` with proxy-managed credentials

Re-running with the same email updates the existing entry.

## Hosted Login Page

This fork can also host a family-facing login page so people can connect their own account without copying a `localhost` URL by hand.

Public routes:

- `GET /login` -- landing page for account linking
- `GET /auth/antigravity/start` -- starts the Google OAuth flow
- `GET /auth/antigravity/callback` -- receives the OAuth callback and adds the account to the running rotator

Required environment variables for hosted mode:

```bash
export ANTIGRAVITY_CLIENT_ID="your-oauth-client-id"
export ANTIGRAVITY_CLIENT_SECRET="your-oauth-client-secret"
export ANTIGRAVITY_REDIRECT_URI="https://your-domain.example.com/auth/antigravity/callback"
```

Notes:

- The redirect URI must be registered on the OAuth client, or Google will reject the flow.
- The hosted page does not modify `~/.pi/agent/*`; it only adds the account to the rotator config.
- If those env vars are not set, `/login` still loads but explains that hosted OAuth is not configured yet.
- Refresh token handling during normal runtime uses the same configured client ID and secret, so the hosted sign-in and later token refreshes stay aligned.

## Dashboard

After starting the proxy, open `http://localhost:51200/dashboard` or `http://<your-server-ip>:51200/dashboard` from any machine on the same network (the proxy binds to `0.0.0.0`).

The dashboard shows:

- **Model Routing table** -- Which account each model (Gemini Pro, Flash, Claude) is currently routed to
- **Account cards** sorted by total quota (highest first), flagged/disabled last:
  - Status badge: `active`, `ready`, `cooldown`, `flagged`, `disabled`, or `error`
  - Model badges: which models this account is currently serving
  - Per-model quota bars with timer type (`fresh`/`7d`/`5h`) and reset countdown
  - Request counts, last used time, token status
  - Error messages for flagged/errored accounts
  - Re-enable button for disabled accounts

![Dashboard](dashboard.png)

## How It Works

### Proxying

```
Pi Agent 1 (Gemini Pro)  --->  localhost:51200  --->  Account A
Pi Agent 2 (Claude)      --->  localhost:51200  --->  Account C
Pi Agent 3 (Flash)       --->  localhost:51200  --->  Account A
                               (this proxy)          (per-model routing)
```

1. Pi sends a request to `localhost:51200` with a model name in the body
2. The proxy resolves the model to a quota key (e.g., `gemini-3.1-pro`)
3. The best available account for that specific model is selected
4. The `Authorization` header and `project` field are swapped with real credentials
5. The request is forwarded (trying daily, autopush, then prod endpoints)
6. The SSE response streams back to pi transparently

### Per-Model Account Selection

Each model maintains its own active account. When the proxy needs to rotate a model, it picks the next account using a priority system:

| Priority | Badge | Condition | Rationale |
|----------|-------|-----------|-----------|
| 1 (first) | `fresh` | No active timer for this model | Start the 7-day clock ASAP so it resets sooner |
| 2 | `7d` | 7-day timer running for this model | Already ticking, keep using it |
| 3 (last) | `5h` | 5-hour timer running for this model | Short-lived; wasted if not fully consumed |

Within the same priority tier, the account with the most remaining quota for that model wins.

### Rotation Triggers

Three mechanisms trigger rotation, scoped to the specific model:

1. **Quota-based** (primary) -- Polls the Google quota API every 5 minutes. When a model's remaining quota drops by `rotateOnQuotaDrop` percentage points (default: 20%), that model rotates to the next account. Other models stay on their current accounts.

2. **Request-count** (fallback) -- After `requestsPerRotation` requests (default: 5), all models on that account rotate. Safety net for when quota data isn't available yet.

3. **429 failover** (reactive) -- On rate limit or 5xx, the account is marked exhausted with a cooldown and the affected model immediately switches.

### Account Protection

The proxy detects blocked/suspended accounts at three levels:

1. **Quota API check** (on startup + every poll) -- If the quota API returns `403 PERMISSION_DENIED` with "violation of Terms of Service", the account is immediately flagged.

2. **API 401** (on request) -- If the prod endpoint rejects the token with `401 UNAUTHENTICATED`, the account is flagged.

3. **API 403** (on request) -- If the response body contains infringement keywords (`infring`, `suspend`, `abus`, `terminat`, `violat`, `banned`, `policy`, `forbidden`), the account is flagged.

Flagged accounts are **immediately excluded** from all model routing. The dashboard shows a red `FLAGGED` badge with the error message and quarantine guidance. Flagged accounts are intentionally kept out of rotation until the provider explicitly restores access.

### Cooldown Management

- Cooldowns are capped at **30 minutes** max
- Stale cooldowns from previous sessions are capped on startup
- The dashboard shows why routing is waiting, how long until the next retry window, and which accounts are cooling down
- Quota-based rotation only triggers if a healthy account is available; the proxy won't rotate away from a working account if there's no better alternative

### Error Handling

- **429** (rate limit) -- account is marked exhausted with cooldown, rotates to next
- **503** (no capacity) -- returned directly to the agent when all healthy accounts are cooling down, busy, flagged, or disabled
- **5xx** (other server errors) -- account error counter incremented, rotates to next

### Dashboard Visibility

The dashboard is intended to replace day-to-day `journalctl` digging for normal operations. The top status panel shows:

- The current routing state (`healthy`, `cooldown_wait`, `busy`, `paused`, `stopped`)
- The exact stop or wait reason
- The next retry window when cooldowns are active
- Protective pause remaining time and the provider signal that triggered it
- Pool counts for available, ready, active, cooldown, busy, flagged, disabled, and error accounts
- An `Attention Needed` section summarizing flagged, cooling, disabled, and error accounts
- A recent event feed with the latest rotator/proxy incidents that led to the current state

## Configuration

Config files (`accounts.json`, `state.json`) are stored in `~/.pi-antigravity-rotator/` by default. Override with:

```bash
# Environment variable
export PI_ROTATOR_DIR=/path/to/config

# Or CLI flag
pi-antigravity-rotator start --config-dir /path/to/config
```

`accounts.json` is created automatically by the login command:

```json
{
  "proxyPort": 51200,
  "requestsPerRotation": 5,
  "rotateOnQuotaDrop": 20,
  "quotaPollIntervalMs": 300000,
  "accounts": [
    {
      "email": "user@gmail.com",
      "refreshToken": "1//...",
      "projectId": "project-abc123",
      "label": "user"
    }
  ]
}
```

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `proxyPort` | `51200` | Port the proxy listens on |
| `requestsPerRotation` | `5` | Max requests before rotating (fallback trigger) |
| `rotateOnQuotaDrop` | `20` | Rotate when a model's quota drops this many %. Set to `0` to disable |
| `quotaPollIntervalMs` | `300000` | Quota poll interval in ms (5 minutes) |

### Account Fields

| Field | Description |
|-------|-------------|
| `email` | Google account email (auto-filled by login) |
| `refreshToken` | OAuth refresh token (auto-filled by login) |
| `projectId` | Cloud project ID (auto-discovered during login) |
| `label` | Display name on the dashboard (auto-filled, defaults to email username) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Web dashboard |
| `GET` | `/login` | Hosted account-link landing page |
| `GET` | `/api/status` | JSON status: accounts, quotas, model routing, flags |
| `POST` | `/api/enable/<email>` | Re-enable a disabled account after its underlying issue is fixed |
| `POST` | `/v1internal:streamGenerateContent` | Proxy endpoint (used by pi) |

## Running as a Service

```bash
# Using nohup
nohup npm start > rotator.log 2>&1 &

# Or with systemd (create /etc/systemd/system/pi-antigravity-rotator.service)
[Unit]
Description=Pi Antigravity Rotator
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/pi-antigravity-rotator
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

**Account shows `flagged` status**
Google detected potential abuse. Review the error message on the dashboard. After resolving with Google, click Re-enable or `POST /api/enable/<email>`.

**Account keeps getting disabled after 5 errors**
Check the error message. Common causes: revoked OAuth consent, expired refresh token (re-run `npm run login`), or Google account suspension.

**Quota bars not showing**
Quota data appears after the first poll cycle (up to 5 minutes). Ensure accounts have valid tokens.

**All accounts exhausted**
The proxy now returns `503` and waits for cooldown or manual recovery. It does not reuse cooling-down accounts.

**Multiple agents on different models**
This is fully supported. Each model routes independently. Agent 1 using Gemini Pro and Agent 2 using Claude will each have their own active account and won't interfere with each other's rotation.
