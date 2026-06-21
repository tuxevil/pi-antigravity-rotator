// Persistent in-memory store for OpenAI Responses API (Codex) chain state.
//
// The store maps `response_id` to the conversation state needed to continue
// a previous turn via `previous_response_id`. It is persisted via the
// settings repository (PostgreSQL or disk files) so a rotator restart does
// not break active Codex sessions.
//
// Writes are debounced to avoid excessive persistence calls under load.
// The store is also flushed synchronously on SIGTERM (see index.ts) to
// minimise data loss.

import {
  getCachedResponsesStore,
  setCachedResponsesStore,
} from "./db-store.js";

export interface StoredResponseEntry {
  response: Record<string, unknown>;
  inputItems: Array<Record<string, unknown>>;
  conversationMessages: Array<Record<string, unknown>>;
  // Maps call_id -> function name. Serialized as plain object on disk
  // because Map cannot be JSON.stringified directly. Convert to Map at use sites.
  callIdToName: Record<string, string>;
  expiresAt: number;
}

export interface PersistedResponsesStore {
  version: 1;
  entries: Array<[string, StoredResponseEntry]>;
}

const FLUSH_DEBOUNCE_MS = 1_500;
const MAX_ENTRIES = 500;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;

function now(): number {
  return Date.now();
}

/**
 * Persistent in-memory store for OpenAI Responses API (Codex) chain state.
 *
 * Maps `response_id` to the conversation state needed to continue a previous
 * turn via `previous_response_id`. Persisted via the settings repository.
 * Writes are debounced to 1.5s and coalesced if a flush is already in flight.
 * Stale entries (older than the 6h TTL) and entries over the 500-entry cap
 * are pruned automatically.
 */
export class ResponsesStore {
  private cache = new Map<string, StoredResponseEntry>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private pendingFlush = false;
  private dirty = false;

  /**
   * Load the persisted store from the repository. Missing or corrupt data
   * is treated as an empty store. Stale entries (older than TTL) are pruned.
   */
  async load(): Promise<void> {
    const dbStore = getCachedResponsesStore();
    if (!dbStore || dbStore.version !== 1 || !Array.isArray(dbStore.entries)) {
      return;
    }
    const cutoff = now() - ENTRY_TTL_MS;
    for (const [id, entry] of dbStore.entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.expiresAt !== "number" || entry.expiresAt < cutoff)
        continue;
      this.cache.set(id, entry);
    }
  }

  get(id: string): StoredResponseEntry | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      this.cache.delete(id);
      this.scheduleFlush();
      return null;
    }
    return entry;
  }

  set(id: string, entry: StoredResponseEntry): void {
    this.cache.set(id, entry);
    this.pruneIfNeeded();
    this.scheduleFlush();
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id);
    if (existed) this.scheduleFlush();
    return existed;
  }

  clear(): void {
    this.cache.clear();
    this.scheduleFlush();
  }

  size(): number {
    return this.cache.size;
  }

  private pruneIfNeeded(): void {
    const cutoff = now() - ENTRY_TTL_MS;
    for (const [id, entry] of this.cache.entries()) {
      if (entry.expiresAt <= cutoff) this.cache.delete(id);
    }
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Flush pending writes to the repository. Safe to call multiple times
   * concurrently; callers will see the same in-flight promise.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.pendingFlush = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        if (!this.dirty) return;
        const data: PersistedResponsesStore = {
          version: 1,
          entries: Array.from(this.cache.entries()),
        };
        setCachedResponsesStore(data);
        this.dirty = false;
      } catch {
        // Best effort — will retry on next schedule.
      } finally {
        this.flushing = null;
        if (this.pendingFlush) {
          this.pendingFlush = false;
          void this.flush();
        }
      }
    })();
    return this.flushing;
  }

  /**
   * Synchronous flush for use in shutdown handlers.
   */
  flushSync(): void {
    if (!this.dirty) return;
    try {
      const data: PersistedResponsesStore = {
        version: 1,
        entries: Array.from(this.cache.entries()),
      };
      setCachedResponsesStore(data);
      this.dirty = false;
    } catch {
      // Best effort
    }
  }
}
