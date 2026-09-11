// OpenCode Zen provider model catalog and endpoint constants.

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

export const OPENCODE_ZEN_FREE_MODELS = [
  "deepseek-v4-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "mimo-v2.5-free",
  "hy3-free",
  "muse-spark-1.3-contributor-free",
  "ling-3.0-flash-fin-free",
] as const;

export type OpenCodeZenModel = (typeof OPENCODE_ZEN_FREE_MODELS)[number];

export interface OpenCodeZenModelSpec {
  id: string;
  contextWindow: number;
  free: boolean;
}

// TODO: replace placeholders with per-model official context windows once
// OpenCode publishes specs at https://opencode.ai/zen or /docs/models. Until
// then all curated `*-free` models advertise a conservative 128K window
// (validated by the upstream Providers Anomaly team in their "reliable
// optimized models for coding agents" announcement, which stated tested-
// consistent windows without enumerating per-model values).
const OPENCODE_ZEN_DEFAULT_CONTEXT_WINDOW = 128_000;

export const OPENCODE_ZEN_CATALOG: OpenCodeZenModelSpec[] = OPENCODE_ZEN_FREE_MODELS.map(
  (id) => ({
    id,
    contextWindow: OPENCODE_ZEN_DEFAULT_CONTEXT_WINDOW,
    free: true,
  }),
);

export function getOpenCodeZenContextWindow(_model: string): number {
  return OPENCODE_ZEN_DEFAULT_CONTEXT_WINDOW;
}

const OPENCODE_ZEN_MODEL_SET = new Set<string>(OPENCODE_ZEN_FREE_MODELS);

export function isOpenCodeZenModel(model: string): boolean {
  if (!model) return false;
  if (OPENCODE_ZEN_MODEL_SET.has(model)) return true;
  return model.endsWith("-free");
}
