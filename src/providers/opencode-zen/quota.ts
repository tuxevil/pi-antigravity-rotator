// OpenCode Zen quota polling.

import { fetchWithRetry } from "../../fetch-with-retry.js";
import type { AccountRuntime, ModelQuota } from "../../types.js";
import type { QuotaFetchContext } from "../adapter.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { OPENCODE_ZEN_MODELS_URL } from "./catalog.js";
import { getOpenCodeZenApiKey, OPENCODE_ZEN_PROVIDER_ID } from "./credentials.js";
import { sortQuotaPools } from "../registry.js";

export async function fetchOpenCodeZenQuota(
  account: AccountRuntime,
  ctx: QuotaFetchContext,
): Promise<void> {
  const apiKey = getOpenCodeZenApiKey(account.config);
  if (!apiKey) return;

  try {
    const response = await fetchWithRetry(OPENCODE_ZEN_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeoutMs: 8000,
      dispatcher: getAccountProxyDispatcher(account, OPENCODE_ZEN_PROVIDER_ID),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text().catch(() => "");
        ctx.log(`${account.config.email}: OpenCode Zen API returned ${response.status}, flagging account`);
        ctx.reportQuotaPollFlag(account, response.status, errorText);
        ctx.markFlagged(
          account,
          `OpenCode Zen API ${response.status}: ${errorText}`,
          { triggerProtectivePause: false },
        );
      }
      return;
    }

    const oldQuota = account.quota || [];
    const otherProviders = oldQuota.filter(
      (q) => (q as { providerId?: string }).providerId &&
        (q as { providerId?: string }).providerId !== OPENCODE_ZEN_PROVIDER_ID,
    );

    const freshQuota: ModelQuota = {
      modelKey: OPENCODE_ZEN_PROVIDER_ID,
      displayName: "OpenCode",
      providerId: OPENCODE_ZEN_PROVIDER_ID,
      percentRemaining: 100,
      resetTime: null,
      timerType: "fresh",
    };

    account.quota = sortQuotaPools([...otherProviders, freshQuota]);
    account.lastQuotaPoll = Date.now();

    account.lastPollByProvider ??= {};
    account.lastPollByProvider[OPENCODE_ZEN_PROVIDER_ID] =
      `[${freshQuota.modelKey}: ${freshQuota.timerType} ${freshQuota.percentRemaining}%]`;
  } catch {
    // Swallow network errors; retain prior quota state
  }
}
