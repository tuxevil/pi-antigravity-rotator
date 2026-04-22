# Pi Antigravity Rotator

Reverse proxy that manages multiple Google Antigravity accounts and rotates between them to distribute quota usage.

## Setup

### 1. Install

```bash
cd tools/antigravity-rotator
npm install
```

### 2. Add accounts

Login with each Google account (run once per account):

```bash
npm run login
```

This opens a browser for Google OAuth. After login, it prints the credentials to add to `accounts.json`.

Copy `accounts.example.json` to `accounts.json` and paste in the credentials:

```bash
cp accounts.example.json accounts.json
```

### 3. Configure pi

Add to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "google-antigravity": {
      "baseUrl": "http://localhost:51200"
    }
  }
}
```

Add a dummy credential to `~/.pi/agent/auth.json` (create if it doesn't exist):

```json
{
  "google-antigravity": {
    "type": "oauth",
    "refresh": "proxy-managed",
    "access": "proxy-managed",
    "expires": 32503680000000,
    "projectId": "proxy-managed"
  }
}
```

### 4. Start the proxy

```bash
npm start
```

### 5. Open the dashboard

Visit `http://localhost:51200/dashboard` to monitor account status.

## Configuration

`accounts.json` fields:

| Field | Description |
|-------|-------------|
| `proxyPort` | Proxy listen port (default: 51200) |
| `requestsPerRotation` | Requests per account before rotating (default: 5) |
| `rotateOnQuotaDrop` | Rotate when any model's quota drops this many percentage points (default: 20). Set to 0 to disable quota-based rotation. |
| `quotaPollIntervalMs` | How often to poll Google's quota API in milliseconds (default: 300000 / 5min) |
| `accounts[].email` | Google account email |
| `accounts[].refreshToken` | OAuth refresh token (from `npm run login`) |
| `accounts[].projectId` | Cloud project ID (auto-discovered during login) |
| `accounts[].label` | Display name for dashboard |
| `accounts[].type` | `"pro"` or `"free"` (affects quota timer tracking) |

## Quota Timer Tracking

- **Pro accounts**: 5-hour short timer + 7-day long timer, 40% recharge on long timer
- **Free accounts**: 7-day timer only, 100% usage

The proxy tracks these timers per account and displays them on the dashboard.

## How It Works

1. Pi sends requests to `localhost:51200` instead of the real Antigravity endpoint
2. The proxy picks the current active account from the pool
3. It swaps the `Authorization` header and `project` field with real credentials
4. The request is forwarded to the real endpoint (with cascade: daily -> autopush -> prod)
5. The SSE response is streamed back transparently to pi
6. After N requests (configurable), the proxy rotates to the next account
7. On 429 (rate limit), the proxy marks the account as exhausted and immediately fails over to the next one

## API

- `GET /dashboard` - Web dashboard
- `GET /api/status` - JSON status of all accounts
- `POST /api/enable/<email>` - Re-enable a disabled account
