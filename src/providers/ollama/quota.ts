// Ollama Cloud quota polling: `GET /api/usage` → monthly pool.
//
// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.

import { fetchWithRetry } from "../../fetch-with-retry.js";
import { OLLAMA_USAGE_URL, OLLAMA_USER_AGENT } from "../../types.js";
import { getOllamaApiKey } from "./credentials.js";
import type { AccountRuntime, ModelQuota } from "../../types.js";
import type { QuotaFetchContext } from "../adapter.js";
import { recordUsagePoll } from "./quota-poll-store.js";
import {
  nextWeeklyResetMs,
  sessionWindowEndMs,
  SESSION_WINDOW_MS,
} from "./usage-windows.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { sortQuotaPools } from "../registry.js";
import { OLLAMA_QUOTA_POOL_KEY } from "../credential-helpers.js";

/**
 * Poll `GET /api/usage` for one account and store the parsed pool quotas.
 * Non-2xx responses flag the account (401/403) via the context callbacks;
 * network errors are swallowed (quota stays stale, rotation falls back to
 * request-count based rotation).
 */
export async function fetchProviderUsage(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  try {
    const response = await fetchWithRetry(OLLAMA_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getOllamaApiKey(account.config) ?? ""}`,
        "User-Agent": OLLAMA_USER_AGENT,
      },
      timeoutMs: 8000,
      dispatcher: getAccountProxyDispatcher(account, "ollama"),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text().catch(() => "");
        ctx.log(
          `${account.config.email}: usage API returned ${response.status}, flagging account`,
        );
        ctx.reportQuotaPollFlag(account, response.status, errorText);
        ctx.markFlagged(
          account,
          `Usage API ${response.status}: ${errorText}`,
          { triggerProtectivePause: false },
        );
      }
      return;
    }

    const data = (await response.json()) as OllamaUsageResponse;
    const oldQuota = account.quota || [];
    const fresh = extractUsagePools(data, oldQuota);
    // Drop the previous Ollama entries so the new ones fully replace
    // them; keep entries from OTHER providers (Antigravity) so multi-
    // provider accounts accumulate quotas across credentials.
    const otherProviders = (oldQuota || []).filter(
      (q) => (q as { providerId?: string }).providerId &&
        (q as { providerId?: string }).providerId !== "ollama",
    );
    fresh.forEach(
      (q) => ((q as { providerId?: string }).providerId = "ollama"),
    );
    account.quota = sortQuotaPools([...otherProviders, ...fresh]);
    account.lastQuotaPoll = Date.now();
    void recordUsagePoll(account.config.email, new Date().toISOString(), data);

    // Stash the provider-local poll log for the rotator to emit as a
    // single consolidated line per cycle.
    account.lastPollByProvider ??= {};
    account.lastPollByProvider["ollama"] = account.quota
      .filter(
        (q) => (q as { providerId?: string }).providerId === "ollama",
      )
      .map((q) => {
        const remain = q.resetTime
          ? Math.round(
              (new Date(q.resetTime).getTime() - Date.now()) / 60000,
            ) + "m"
          : "no_reset";
        const fraction =
          typeof q.usageRaw === "number" ? `@${q.usageRaw.toFixed(3)}` : "";
        return `[${q.modelKey}: ${q.timerType} ${q.percentRemaining}%${fraction} in ${remain}]`;
      })
      .join(" | ");
  } catch {
    // Network error, skip
  }
}

export interface OllamaUsageResponse {
  limits?: Record<
    string,
    | { usage?: number | string; models?: unknown[] }
    | undefined
  >;
}

/**
 * Parse `GET /api/usage` into Ollama quota pools.
 *
 * Current Ollama Cloud responses expose one account-wide `monthly` pool. The
 * legacy session/weekly parser remains as a fallback for older responses so
 * an upgrade does not make an account temporarily unroutable.
 */
export function extractUsagePools(
  data: OllamaUsageResponse,
  oldQuota: ModelQuota[],
): ModelQuota[] {
  const quotas: ModelQuota[] = [];
  const now = Date.now();
  const limits = data?.limits;
  if (!limits || typeof limits !== "object") return quotas;

  const monthly = limits[OLLAMA_QUOTA_POOL_KEY];
  if (monthly && typeof monthly === "object") {
    const usageFraction =
      typeof monthly.usage === "number"
        ? monthly.usage
        : typeof monthly.usage === "string"
          ? parseFloat(monthly.usage)
          : NaN;
    if (Number.isFinite(usageFraction)) {
      quotas.push({
        modelKey: OLLAMA_QUOTA_POOL_KEY,
        displayName: "Monthly",
        percentRemaining: Math.max(
          0,
          Math.min(100, Math.round((1 - usageFraction) * 100)),
        ),
        usageRaw: usageFraction,
        resetTime: null,
        timerType: "monthly",
      });
      return quotas;
    }
  }

  for (const pool of ["session", "weekly"] as const) {
    const info = limits[pool];
    if (!info || typeof info !== "object") continue;

    const usageFraction =
      typeof info.usage === "number"
        ? info.usage
        : typeof info.usage === "string"
          ? parseFloat(info.usage)
          : NaN;
    if (!Number.isFinite(usageFraction)) continue;

    const percentRemaining = Math.max(
      0,
      Math.min(100, Math.round((1 - usageFraction) * 100)),
    );

    if (pool === "weekly") {
      quotas.push({
        modelKey: "weekly",
        displayName: "Weekly",
        percentRemaining,
        usageRaw: usageFraction,
        resetTime: new Date(nextWeeklyResetMs(now)).toISOString(),
        timerType: "7d",
      });
      continue;
    }

    // session: active only while usage > 0. Anchor the window at the
    // first observation of usage (or a detected reset) and keep that
    // anchor while the window is still valid.
    const running = usageFraction > 0;
    const old = oldQuota.find((q) => q.modelKey === "session");
    let windowStart: number | null = null;
    if (running) {
      const oldUsed =
        old && old.percentRemaining >= 0
          ? 1 - old.percentRemaining / 100
          : NaN;
      const resetDetected =
        Number.isFinite(oldUsed) && usageFraction < oldUsed - 0.01;
      const oldAnchor = old?.resetTime
        ? new Date(old.resetTime).getTime() - SESSION_WINDOW_MS
        : NaN;
      if (
        resetDetected ||
        !Number.isFinite(oldAnchor) ||
        now >= oldAnchor + SESSION_WINDOW_MS
      ) {
        windowStart = now;
      } else {
        windowStart = oldAnchor;
      }
    }

    quotas.push({
      modelKey: "session",
      displayName: "Session",
      percentRemaining,
      usageRaw: usageFraction,
      resetTime:
        windowStart !== null
          ? new Date(sessionWindowEndMs(windowStart)).toISOString()
          : null,
      timerType: windowStart !== null ? "5h" : "fresh",
    });
  }

  return quotas;
}
