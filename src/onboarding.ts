import type { IncomingMessage, ServerResponse } from "node:http";
import { addAccountToConfig } from "./account-store.js";
import { PayloadTooLargeError, readLimitedBody } from "./body-limit.js";
import {
  buildAuthUrl,
  discoverProject,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  getOAuthClientConfig,
  getUserEmail,
  isHostedOAuthConfigured,
} from "./oauth.js";
import type { AccountRotator } from "./rotator.js";

interface PendingSession {
  verifier: string;
  createdAt: number;
}

const pendingSessions = new Map<string, PendingSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CLI_LOGIN_BODY_BYTES = 64 * 1024;

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prunePendingSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [state, session] of pendingSessions.entries()) {
    if (session.createdAt < cutoff) {
      pendingSessions.delete(state);
    }
  }
}

// Background reaper. Without this, a long-lived proxy that never sees
// /auth/antigravity/start or /callback would accumulate stale sessions
// (each is a 96-byte PKCE verifier + timestamp). The interval is unref'd
// so it does not block process exit.
let pruneTimer: ReturnType<typeof setInterval> | null = null;
function startPendingSessionReaper(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(
    () => prunePendingSessions(),
    SESSION_PRUNE_INTERVAL_MS,
  );
  if (pruneTimer.unref) pruneTimer.unref();
}
export function stopPendingSessionReaper(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
startPendingSessionReaper();

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
  :root {
    --bg: #f4efe6;
    --ink: #1f2a1f;
    --muted: #5b6659;
    --card: rgba(255,255,255,0.8);
    --line: rgba(31,42,31,0.12);
    --accent: #1e6b52;
    --accent-2: #d99058;
    --warn: #9a4b3f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: 'Space Grotesk', system-ui, sans-serif;
    color: var(--ink);
    background:
      radial-gradient(circle at top left, rgba(217,144,88,0.28), transparent 32%),
      radial-gradient(circle at bottom right, rgba(30,107,82,0.22), transparent 28%),
      linear-gradient(160deg, #f7f1e8, #efe5d6 52%, #e9ddcb);
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    width: min(760px, 100%);
    background: var(--card);
    backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: 24px;
    padding: 28px;
    box-shadow: 0 20px 80px rgba(31, 42, 31, 0.08);
  }
  h1 {
    margin: 0 0 10px;
    font-size: clamp(32px, 6vw, 56px);
    line-height: 0.96;
    letter-spacing: -0.04em;
  }
  p, li {
    font-size: 16px;
    line-height: 1.6;
    color: var(--muted);
  }
  .mono {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: var(--ink);
    background: rgba(31,42,31,0.05);
    border: 1px solid rgba(31,42,31,0.08);
    border-radius: 12px;
    padding: 12px 14px;
    overflow-wrap: anywhere;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 18px;
    padding: 14px 20px;
    border-radius: 999px;
    background: var(--accent);
    color: white;
    text-decoration: none;
    font-weight: 700;
    box-shadow: 0 12px 30px rgba(30,107,82,0.22);
  }
  .cta:hover { background: #185843; }
  .note {
    margin-top: 18px;
    padding: 14px 16px;
    border-left: 4px solid var(--accent-2);
    background: rgba(217,144,88,0.12);
    border-radius: 12px;
  }
  .error {
    border-left-color: var(--warn);
    background: rgba(154,75,63,0.12);
  }
  ul {
    padding-left: 18px;
    margin: 16px 0 0;
  }
</style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
</body>
</html>`;
}

export function serveLoginLanding(res: ServerResponse): void {
  const hostedReady = isHostedOAuthConfigured();
  const oauth = hostedReady ? getOAuthClientConfig() : null;
  const message = hostedReady
    ? `<p>This page starts the Antigravity sign-in flow and returns here automatically so the account can be added to this rotator.</p>
<p class="mono">Configured callback: ${escapeHtml(oauth?.redirectUri)}</p>
<div class="note">Signing in here grants this server a refresh token for the selected Google account. That allows the rotator to keep using that account until access is revoked.</div>
<a class="cta" href="/auth/antigravity/start">Continue With Google</a>`
    : `<p>This server is not yet configured for hosted OAuth.</p>
<p class="mono">Set ANTIGRAVITY_REDIRECT_URI, and usually ANTIGRAVITY_CLIENT_ID plus ANTIGRAVITY_CLIENT_SECRET, to a public callback URL registered with the OAuth client.</p>
<div class="note error">The current redirect is still loopback-only, so the transparent public callback cannot complete yet.</div>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    renderPage("Antigravity Login", `<h1>Connect Your Account</h1>${message}`),
  );
}

export function startHostedLogin(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!isHostedOAuthConfigured()) {
    res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Hosted OAuth Not Configured",
        "<h1>Hosted Login Isn’t Ready</h1><p>This server still uses a loopback redirect URI. Configure a public redirect before sharing this page.</p>",
      ),
    );
    return;
  }

  prunePendingSessions();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  pendingSessions.set(state, { verifier, createdAt: Date.now() });

  const authUrl = buildAuthUrl(state, challenge);
  res.writeHead(302, { Location: authUrl });
  res.end();
}

// ── Web-based CLI login (/login-cli) ──────────────────────────────────────────
// Replicates the CLI login flow in the browser: shows the Google OAuth URL,
// user signs in and pastes the redirect URL back, server exchanges the code.

interface CliLoginSession {
  verifier: string;
  challenge: string;
  oauthState: string;
  authUrl: string;
  createdAt: number;
}

const cliLoginSessions = new Map<string, CliLoginSession>();

function pruneCliSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of cliLoginSessions.entries()) {
    if (session.createdAt < cutoff) {
      cliLoginSessions.delete(id);
    }
  }
}

export function serveCliLogin(res: ServerResponse): void {
  pruneCliSessions();
  const { verifier, challenge } = generatePkce();
  const oauthState = generateState();
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(oauthState, challenge);
  } catch (err) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "OAuth Not Configured",
        `<h1>OAuth Login Isn’t Ready</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`,
      ),
    );
    return;
  }
  const sessionId = generateState();
  cliLoginSessions.set(sessionId, {
    verifier,
    challenge,
    oauthState,
    authUrl,
    createdAt: Date.now(),
  });

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    renderPage(
      "Add Account",
      `<h1>Add Account</h1>
<p>This page works like the CLI login. Follow the steps below to add a Google account to the rotator.</p>

<h3 style="margin:24px 0 8px;font-size:18px;">Step 1 &mdash; Sign in with Google</h3>
<p>Click the button below to open the Google sign-in page in a new tab:</p>
<a class="cta" href="${escapeHtml(authUrl)}" target="_blank" rel="noopener" style="font-size:16px;">
  Sign in with Google &nearr;
</a>

<h3 style="margin:24px 0 8px;font-size:18px;">Step 2 &mdash; Paste the redirect URL</h3>
<p>After signing in, Google will redirect to <code>localhost</code> (which will fail — that's expected). Copy the <strong>full URL</strong> from your browser's address bar and paste it here:</p>
<form id="pasteForm" style="margin-top:12px;">
  <input type="hidden" name="session" value="${escapeHtml(sessionId)}" />
  <textarea name="redirectUrl" rows="4" placeholder="Paste the redirect URL here (starts with http://localhost:51121/oauth-callback?...)" style="
    width:100%;font-family:'IBM Plex Mono',monospace;font-size:13px;
    padding:12px 14px;border-radius:12px;border:1px solid rgba(31,42,31,0.15);
    background:rgba(31,42,31,0.03);resize:vertical;
  "></textarea>
  <button type="submit" class="cta" style="cursor:pointer;border:none;font-family:inherit;font-size:16px;margin-top:12px;">
    Connect Account
  </button>
</form>
<div id="result" style="margin-top:18px;"></div>

<script>
document.getElementById('pasteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const resultDiv = document.getElementById('result');
  const redirectUrl = form.redirectUrl.value.trim();
  const session = form.session.value;
  if (!redirectUrl) { resultDiv.innerHTML = '<div class="note error">Please paste the redirect URL.</div>'; return; }
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  resultDiv.innerHTML = '<div class="note">Exchanging code for tokens...</div>';
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const res = await fetch('/api/cli-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rotator-Admin-Token': token } : {}) },
      body: JSON.stringify({ session, redirectUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      resultDiv.innerHTML = '<div class="note" style="border-left-color:var(--accent);background:rgba(30,107,82,0.12);">' +
        '<strong id="loginResultEmail"></strong> ' + (data.isNew ? 'added' : 'updated') + ' successfully.<br>' +
        'Project: <span id="loginResultProject" class="mono" style="padding:2px 6px;"></span>' +
        '</div>';
      document.getElementById('loginResultEmail').textContent = data.email || '';
      document.getElementById('loginResultProject').textContent = data.projectId || '';
    } else {
      var errorDiv = document.createElement('div');
      errorDiv.className = 'note error';
      errorDiv.textContent = data.error || 'Unknown error';
      resultDiv.innerHTML = '';
      resultDiv.appendChild(errorDiv);
    }
  } catch (err) {
    var errDiv = document.createElement('div');
    errDiv.className = 'note error';
    errDiv.textContent = 'Request failed: ' + err.message;
    resultDiv.innerHTML = '';
    resultDiv.appendChild(errDiv);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Account';
  }
});
</script>
`,
    ),
  );
}

export async function handleCliLoginApi(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  let body: { session?: string; redirectUrl?: string };
  try {
    const raw = await readLimitedBody(req, MAX_CLI_LOGIN_BODY_BYTES);
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be an object");
    }
    body = parsed as { session?: string; redirectUrl?: string };
  } catch (err) {
    res.writeHead(err instanceof PayloadTooLargeError ? 413 : 400, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
    return;
  }

  const { session: sessionId, redirectUrl } = body;
  if (
    typeof sessionId !== "string" ||
    typeof redirectUrl !== "string" ||
    sessionId.length === 0 ||
    redirectUrl.length === 0 ||
    sessionId.length > 256 ||
    redirectUrl.length > 8 * 1024
  ) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, error: "Missing session or redirectUrl" }),
    );
    return;
  }

  pruneCliSessions();
  const session = cliLoginSessions.get(sessionId);
  if (!session) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Session expired or invalid. Reload the page and try again.",
      }),
    );
    return;
  }

  // Parse the redirect URL to extract code
  let code: string | undefined;
  let state: string | null;
  try {
    const url = new URL(redirectUrl.trim());
    code = url.searchParams.get("code") ?? undefined;
    state = url.searchParams.get("state");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error:
          "Could not parse the URL. Make sure you pasted the full redirect URL.",
      }),
    );
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "No authorization code found in the URL.",
      }),
    );
    return;
  }
  if (state !== session.oauthState) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "State mismatch - reload the login page and try again.",
      }),
    );
    return;
  }

  cliLoginSessions.delete(sessionId);

  try {
    const tokenData = await exchangeAuthorizationCode(code, session.verifier);
    const email = await getUserEmail(tokenData.accessToken);
    const project = await discoverProject(tokenData.accessToken);
    const label = email ? email.split("@")[0] : "Account";
    const entry = {
      email: email || "unknown@gmail.com",
      refreshToken: tokenData.refreshToken,
      projectId: project.projectId,
      projectSource: project.source,
      label,
    };

    const { isNew } = addAccountToConfig(entry);
    rotator.addOrUpdateAccount(entry);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        email: entry.email,
        isNew,
        projectId: project.projectId,
      }),
    );
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Unable to complete login. Please try again.",
      }),
    );
  }
}

export async function handleHostedCallback(
  req: IncomingMessage,
  res: ServerResponse,
  rotator: AccountRotator,
): Promise<void> {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const error = requestUrl.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Sign-In Cancelled",
        `<h1>Sign-In Cancelled</h1><p>Google returned: ${escapeHtml(error)}</p>`,
      ),
    );
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Missing Parameters",
        "<h1>Missing Parameters</h1><p>The callback did not include a valid code and state.</p>",
      ),
    );
    return;
  }

  prunePendingSessions();
  const session = pendingSessions.get(state);
  if (!session) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Session Expired",
        "<h1>Session Expired</h1><p>This sign-in session is no longer valid. Start again from the login page.</p>",
      ),
    );
    return;
  }
  pendingSessions.delete(state);

  try {
    const tokenData = await exchangeAuthorizationCode(code, session.verifier);
    const email = await getUserEmail(tokenData.accessToken);
    const project = await discoverProject(tokenData.accessToken);
    const label = email ? email.split("@")[0] : "Account";
    const entry = {
      email: email || "unknown@gmail.com",
      refreshToken: tokenData.refreshToken,
      projectId: project.projectId,
      projectSource: project.source,
      label,
    };

    const { isNew } = addAccountToConfig(entry);
    rotator.addOrUpdateAccount(entry);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Account Connected",
        `<h1>Account Connected</h1>
<p><strong>${escapeHtml(entry.email)}</strong> was ${isNew ? "added" : "updated"} successfully.</p>
<p>Project: <span class="mono">${escapeHtml(project.projectId)}</span> via ${escapeHtml(project.source)}.</p>
<p>The rotator can start using this account immediately.</p>
<div class="note">If you ever want to stop sharing access, revoke this app's access from the Google account security settings.</div>`,
      ),
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Sign-In Failed",
        `<h1>Sign-In Failed</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`,
      ),
    );
  }
}
