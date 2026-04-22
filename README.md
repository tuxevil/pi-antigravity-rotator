# Pi Antigravity Rotator

Multi-account rotation proxy for Google Antigravity. Distributes API usage across multiple Google accounts using real-time quota tracking, automatic token management, and intelligent account selection to maximize uptime and minimize the risk of account flags.

## Features

- **Real-time quota monitoring** -- Polls Google's internal quota API every 5 minutes to track actual remaining usage per model (Gemini Pro, Flash, Claude)
- **Smart rotation** -- Rotates accounts when quota drops by a configurable threshold (default: 20%)
- **Timer-aware selection** -- Prioritizes accounts with fresh 7-day timers over short-lived 5-hour timers to optimize recharge cycles
- **Automatic failover** -- On 429 rate limits, instantly switches to the next available account
- **Token auto-refresh** -- Refresh tokens are exchanged for access tokens automatically; no manual token management
- **Endpoint cascade** -- Tries daily, autopush, and prod API endpoints for resilience
- **Web dashboard** -- Real-time view of all accounts, quota bars, timers, and rotation state
- **State persistence** -- Survives restarts; account stats and cooldowns are saved to disk

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

Run `npm run login` once per Google account. The process is:

1. A Google OAuth URL is printed to the terminal -- open it in your browser
2. Complete the sign-in and grant permissions
3. The browser redirects to a `localhost` URL that won't load -- this is expected
4. Copy the **full URL** from the browser's address bar and paste it into the terminal

That's it. The tool handles everything else:

- Creates or updates `accounts.json` with the account credentials
- Configures `~/.pi/agent/models.json` to point `google-antigravity` at the proxy
- Configures `~/.pi/agent/auth.json` with proxy-managed credentials

To add more accounts, run `npm run login` again. Re-running with the same email updates the existing entry instead of creating a duplicate.

## Dashboard

After starting the proxy, open `http://localhost:51200/dashboard` in your browser.

Each account card shows:

- **Status badge** -- `active`, `ready`, `cooldown`, `disabled`, or `error`
- **Timer badge** -- `fresh` (no active timers), `7d` (on 7-day timer), or `5h` (on 5-hour timer)
- **Quota bars** -- Per-model remaining percentage (green > 60%, yellow > 30%, red below)
- **Request counts** -- Requests since last rotation and total lifetime
- **Timer countdowns** -- Remaining time on 5-hour and 7-day recharge cycles
- **Token status** -- Whether the OAuth access token is currently valid

Disabled accounts can be re-enabled directly from the dashboard.

## How It Works

### Proxying

```
Pi  -->  localhost:51200  -->  Google Antigravity API
         (this proxy)         (daily / autopush / prod)
```

1. Pi sends requests to `localhost:51200` instead of the real Antigravity endpoint
2. The proxy selects the best available account from the pool
3. The `Authorization` header and `project` field in the request body are replaced with real credentials
4. The request is forwarded to the Google API (trying daily, autopush, then prod endpoints)
5. The SSE response streams back to pi transparently

### Account Selection

When the proxy needs to rotate, it picks the next account using a priority system:

| Priority | Badge | Condition | Rationale |
|----------|-------|-----------|-----------|
| 1 (first) | `fresh` | No active timers | Start the 7-day clock ASAP so it resets sooner |
| 2 | `7d` | 7-day timer running | Already ticking, keep using it |
| 3 (last) | `5h` | 5-hour timer running | Short-lived pool; wasted if not fully consumed |

Within the same priority tier, the account with the most remaining quota wins.

### Rotation Triggers

Three mechanisms trigger account rotation, from proactive to reactive:

1. **Quota-based** (primary) -- The proxy polls the Google quota API every 5 minutes. When any model's remaining quota drops by `rotateOnQuotaDrop` percentage points (default: 20%) since the account became active, it rotates to the next account. This gives each account breathing room between uses.

2. **Request-count** (fallback) -- After `requestsPerRotation` requests (default: 5), the proxy rotates. This acts as a safety net when quota data isn't available yet.

3. **429 failover** (reactive) -- If Google returns a 429 or 5xx error, the account is marked as exhausted with a cooldown period and the proxy immediately switches to the next available account.

## Configuration

All configuration is in `accounts.json`, which is created automatically by `npm run login`. You can also edit it manually:

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
| `rotateOnQuotaDrop` | `20` | Rotate when quota drops this many %. Set to `0` to disable quota-based rotation |
| `quotaPollIntervalMs` | `300000` | Quota poll interval in ms (5 minutes) |

### Account Fields

| Field | Description |
|-------|-------------|
| `email` | Google account email (auto-filled by login) |
| `refreshToken` | OAuth refresh token (auto-filled by login) |
| `projectId` | Cloud project ID (auto-discovered during login) |
| `label` | Display name shown in the dashboard (auto-filled, defaults to email username) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Web dashboard UI |
| `GET` | `/api/status` | JSON status of all accounts, quota, and timers |
| `POST` | `/api/enable/<email>` | Re-enable a disabled account |
| `POST` | `/v1internal:streamGenerateContent` | Proxy endpoint (used by pi) |

## Running as a Service

To keep the proxy running in the background:

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

**Account keeps getting disabled after 5 errors**
Check the error message in the dashboard. Common causes: revoked OAuth consent, expired refresh token (re-run `npm run login` for that account), or Google account suspension.

**Quota bars not showing**
Quota data appears after the first poll cycle (up to 5 minutes after startup). Ensure the accounts have valid tokens -- check the Token status on the dashboard.

**All accounts exhausted**
The proxy will use the account with the shortest remaining cooldown. Consider adding more accounts or increasing `requestsPerRotation`.
