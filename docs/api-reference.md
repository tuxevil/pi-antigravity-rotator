# API Reference

## Authentication

**Dashboard and admin routes** (`/dashboard`, `/api/*`) require one of:
- `Authorization: Bearer <token>`
- `X-Rotator-Admin-Token: <token>`
- `?token=<token>` (URL parameter, for browser dashboard access)

The admin token is auto-generated on first run and saved to `.admin-token`. Override with `TUXEVIL_ROTATOR_ADMIN_TOKEN`.

**Proxy routes** (`/v1/*`, `/v1internal:*`) run in open mode by default. Once at least one Virtual Key is created in PostgreSQL, all proxy routes require a valid `rk-...` key. See [Virtual Keys](virtual-keys.md).

---

## Dashboard Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard` | Main accounts dashboard |
| `GET` | `/dashboard/keys` | Virtual Keys management UI |
| `GET` | `/dashboard/logs` | Spend Logs & audit inspector |
| `GET` | `/login` | Web-based account OAuth linking page |

---

## Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | JSON status: accounts, quotas, model routing, flags |
| `GET` | `/api/events` | SSE stream of real-time rotator events |
| `POST` | `/api/enable/<email>` | Re-enable a disabled account |
| `POST` | `/api/settings/fresh-window-starts/on` | Allow opening new `idle`/fresh windows globally |
| `POST` | `/api/settings/fresh-window-starts/off` | Block opening new `idle`/fresh windows globally |
| `POST` | `/api/account-fresh-window-starts/<email>/on` | Allow one account to override the global fresh-window block |
| `POST` | `/api/account-fresh-window-starts/<email>/off` | Return one account to the global fresh-window policy |
| `POST` | `/api/self-update` | Trigger npm self-update to latest version |

### Virtual Key Management (requires PostgreSQL)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/keys` | List all virtual keys |
| `POST` | `/api/keys/generate` | Generate a new virtual key |
| `GET` | `/api/keys/<hash>` | Retrieve details for a virtual key |
| `PUT` | `/api/keys/<hash>` | Update alias, models, or blocked state |
| `DELETE` | `/api/keys/<hash>` | Delete a virtual key |

### Spend Logging (requires PostgreSQL)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/spend/logs` | Query spend logs with filters and pagination |
| `GET` | `/api/spend/summary` | Aggregated daily spend summary |
| `GET` | `/api/spend/by-key` | Spend breakdown by virtual key |

---

## Proxy Routes

### OpenAI-Compatible

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models. Each entry includes an `owned_by` field marking its provider (`google-antigravity`, `ollama`, or `openai-codex`). |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (for Codex-style agents; persisted Codex Responses survive restarts via `<configDir>/responses.json`) |
| `GET` | `/v1/responses/<id>` | Retrieve a stored Responses result |
| `DELETE` | `/v1/responses/<id>` | Delete a stored Responses result |
| `POST` | `/v1/responses/<id>/cancel` | Cancel an in-progress Responses result |
| `GET` | `/v1/responses/<id>/input_items` | List stored input items for a Responses result |

### Anthropic-Compatible

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |

### Native Antigravity

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1internal:streamGenerateContent` | Native Antigravity proxy (used by Pi agent) |
| `POST` | `/v1internal:<code-assist-action>` | Allowlisted Code Assist passthrough: `loadCodeAssist`, `fetchAvailableModels`, `onboardUser`, `listExperiments`, `countTokens`, `retrieveUserQuota`, or `retrieveUserQuotaSummary` |

Code Assist operations are forwarded only by the Google Antigravity provider. Project-scoped
operations use the active account's configured `projectId`; the client cannot override it and
there is no shared-project fallback. Other `/v1internal:*` operations are rejected.

---

## Query Parameters

### `/api/spend/logs`

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | `YYYY-MM-DD` | Start date filter |
| `to` | `YYYY-MM-DD` | End date filter |
| `model` | string | Filter by model name |
| `key` | string | Filter by virtual key hash |
| `limit` | integer | Max results (default: 100) |
| `offset` | integer | Pagination offset |

### `/api/status`

Returns full JSON status including:
- Routing state and health
- All accounts with quota bars, timers, and status
- Per-model active account assignments
- Circuit breaker states
- Daily budget counters
- Token usage statistics
- Per-provider quota keys: Antigravity `claude` / `gemini`, Ollama `monthly`, Codex `openai-codex` (and `openai-codex-spark` when the endpoint exposes it)
