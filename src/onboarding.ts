import type { IncomingMessage, ServerResponse } from "node:http";
import { addAccountToConfig } from "./account-store.js";
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
function stopPendingSessionReaper(): void {
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
<title>${title}</title>
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

export function serveLoginLanding(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const oauth = getOAuthClientConfig();
  const hostedReady = isHostedOAuthConfigured();

  // Preserve the admin token for sub-navigation links
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const adminToken = requestUrl.searchParams.get("token");
  const tokenQs = adminToken ? `?token=${encodeURIComponent(adminToken)}` : "";

  let message: string;
  if (hostedReady) {
    message = `<p>This page starts the Antigravity sign-in flow and returns here automatically so the account can be added to this rotator.</p>
<p class="mono">Configured callback: ${oauth.redirectUri}</p>
<div class="note">Signing in here grants this server a refresh token for the selected Google account. That allows the rotator to keep using that account until access is revoked.</div>
<a class="cta" href="/auth/antigravity/start${tokenQs}">Continue With Google</a>`;
  } else {
    message = `<p>This page starts the Antigravity sign-in flow. Because the redirect goes to <code>localhost</code>, you will need to paste the redirect URL back here after completing the Google sign-in.</p>
<div class="note">Signing in here grants this server a refresh token for the selected Google account. That allows the rotator to keep using that account until access is revoked.</div>
<a class="cta" href="/auth/antigravity/start${tokenQs}">Continue With Google</a>`;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    renderPage("Antigravity Login", `<h1>Connect Your Account</h1>${message}`),
  );
}

export function startHostedLogin(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  prunePendingSessions();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  pendingSessions.set(state, { verifier, createdAt: Date.now() });

  const authUrl = buildAuthUrl(state, challenge);
  res.writeHead(302, { Location: authUrl });
  res.end();
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
        `<h1>Sign-In Cancelled</h1><p>Google returned: ${error}</p>`,
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
<p><strong>${entry.email}</strong> was ${isNew ? "added" : "updated"} successfully.</p>
<p>Project: <span class="mono">${project.projectId}</span> via ${project.source}.</p>
<p>The rotator can start using this account immediately.</p>
<div class="note">If you ever want to stop sharing access, revoke this app's access from the Google account security settings.</div>`,
      ),
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderPage(
        "Sign-In Failed",
        `<h1>Sign-In Failed</h1><p>${err instanceof Error ? err.message : String(err)}</p>`,
      ),
    );
  }
}
