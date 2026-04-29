# Telemetry Receiver

Minimal HTTP server that receives anonymous telemetry events from pi-antigravity-rotator instances and stores them as JSONL files (one per day).

**Zero dependencies** — runs on Node.js 18+ with native `http`/`fs`.

## Deploy to your VPS

```bash
# Copy this directory to your VPS
scp -r tools/telemetry-receiver/ user@your-vps:/opt/telemetry-receiver/

# On the VPS:
cd /opt/telemetry-receiver
export PORT=3800
export DATA_DIR=/var/lib/rotator-telemetry
export STATS_TOKEN=$(openssl rand -hex 32)
node receiver.js
```

### With systemd

```ini
# /etc/systemd/system/rotator-telemetry.service
[Unit]
Description=Pi Rotator Telemetry Receiver
After=network.target

[Service]
Type=simple
User=telemetry
WorkingDirectory=/opt/telemetry-receiver
ExecStart=/usr/bin/node receiver.js
Restart=always
RestartSec=5
Environment=PORT=3800
Environment=DATA_DIR=/var/lib/rotator-telemetry
Environment=STATS_TOKEN=your-secret-token-here

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rotator-telemetry
```

### With nginx reverse proxy (HTTPS)

```nginx
server {
    listen 443 ssl;
    server_name telemetry.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/telemetry.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/telemetry.yourdomain.com/privkey.pem;

    location /v1/ {
        proxy_pass http://127.0.0.1:3800;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/events` | none | Receive telemetry payload |
| `GET` | `/v1/stats` | `Bearer STATS_TOKEN` | Aggregate statistics |
| `GET` | `/v1/health` | none | Health check |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3800` | Listen port |
| `DATA_DIR` | `./data` | Directory for JSONL files |
| `STATS_TOKEN` | *(empty)* | Bearer token for `/v1/stats` (required to enable stats) |

## Data Format

Each JSONL line:

```json
{
  "event": "boot",
  "installId": "a1b2c3d4-...",
  "version": "1.7.0",
  "nodeVersion": "v22.12.0",
  "os": "linux",
  "arch": "x64",
  "ts": "2026-04-29T12:00:00.000Z",
  "receivedAt": "2026-04-29T12:00:01.123Z",
  "accountCount": 5,
  "modelsUsed": ["gemini-3-flash", "claude-opus-4-6-thinking"],
  "totalRequests": 1234,
  "uptimeSeconds": 86400,
  "routingHealthState": "healthy",
  "flaggedCount": 0,
  "disabledCount": 0,
  "proCount": 3,
  "freeCount": 2,
  "featuresUsed": { "dashboard": true, "proAdvisor": false, "freshWindowToggle": true, "hostedLogin": false }
}
```

## Query stats

```bash
curl -H "Authorization: Bearer YOUR_STATS_TOKEN" https://telemetry.yourdomain.com/v1/stats | jq .
```

## Security

- **No PII is stored**: no emails, tokens, IPs, project IDs
- Email-pattern detection in validation: payloads containing `@` email patterns are rejected
- Payloads capped at 4KB
- Rate limited: 12 req/min per IP
- Stats endpoint requires Bearer token
