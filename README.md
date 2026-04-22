# Pi Antigravity Rotator

Multi-account rotation proxy for Google Antigravity. Distributes API usage across multiple Google accounts with per-model routing, real-time quota tracking, automatic token management, and infringement detection.

## Features

- **Per-model routing** -- Each model (Gemini Pro, Flash, Claude) routes to its own active account independently. Multiple agents using different models won't interfere with each other.
- **Real-time quota monitoring** -- Polls Google's quota API every 5 minutes to track remaining usage per model per account
- **Per-model timer tracking** -- Timer priority (fresh/7d/5h) is evaluated per model using each model's actual `resetTime` from the quota API, not a per-account estimate
- **Smart rotation** -- Rotates only the specific model whose quota dropped, leaving other models on their current accounts
- **Infringement detection** -- On 403 with infringement/abuse/suspension keywords, the account is immediately flagged and excluded from routing
- **Automatic failover** -- On 429 rate limits, instantly switches the affected model to the next available account
- **Token auto-refresh** -- Tokens are refreshed automatically before expiry; no manual management
- **Endpoint cascade** -- Tries daily, autopush, and prod API endpoints for resilience
- **Web dashboard** -- Real-time view of model routing table, per-account quota bars with per-model timers, and flagged account alerts
- **State persistence** -- Survives restarts; routing assignments, cooldowns, and flags are saved to disk

## Quick Start

```bash
# Clone the repository
git clone https://github.com/tuxevil/pi-antigravity-rotator.git
cd pi-antigravity-rotator

# Install dependencies
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

## Dashboard

After starting the proxy, open `http://localhost:51200/dashboard`.

The dashboard shows:

- **Model Routing table** -- Which account each model (Gemini Pro, Flash, Claude) is currently routed to
- **Account cards** with:
  - Status badge: `active`, `ready`, `cooldown`, `flagged`, `disabled`, or `error`
  - Model badges: which models this account is currently serving
  - Per-model quota bars with timer type (`fresh`/`7d`/`5h`) shown next to each bar
  - Request counts, last used time, token status
  - Error messages for flagged/errored accounts
  - Re-enable button for flagged or disabled accounts

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

1. **Quota API check** (on startup + every poll) -- If the quota API returns `403 PERMISSION_DENIED` with "violation of Terms of Service", the account is immediately flagged. This catches suspended accounts before any request is wasted.

2. **API endpoint 401** (on request) -- If all 3 endpoints (daily, autopush, prod) reject the token with `401 UNAUTHENTICATED`, the account is flagged. The proxy cascades through all endpoints before giving up.

3. **API endpoint 403** (on request) -- If the response body contains infringement keywords (`infring`, `suspend`, `abus`, `terminat`, `violat`, `banned`, `policy`, `forbidden`), the account is flagged.

Flagged accounts are **immediately excluded** from all model routing. The dashboard shows a red `FLAGGED` badge with the error message. Use the Re-enable button or `POST /api/enable/<email>` to clear the flag after resolving the issue with Google.

### Endpoint Cascade

The proxy tries three Google API endpoints in order for each request:

1. `daily-cloudcode-pa.sandbox.googleapis.com`
2. `autopush-cloudcode-pa.sandbox.googleapis.com`
3. `cloudcode-pa.googleapis.com` (prod)

On `401`, `403`, or `404`, it cascades to the next endpoint. Only the final endpoint's response is used for flagging decisions.

## Configuration

All configuration is in `accounts.json`, created automatically by `npm run login`:

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
| `GET` | `/api/status` | JSON status: accounts, quotas, model routing, flags |
| `POST` | `/api/enable/<email>` | Clear flagged/disabled state and re-enable an account |
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
The proxy uses the account with the shortest remaining cooldown. Add more accounts or increase `requestsPerRotation`.

**Multiple agents on different models**
This is fully supported. Each model routes independently. Agent 1 using Gemini Pro and Agent 2 using Claude will each have their own active account and won't interfere with each other's rotation.
