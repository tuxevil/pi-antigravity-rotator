// Persistent in-memory store for OpenAI Responses API (Codex) chain state.
//
// The store maps `response_id` to the conversation state needed to continue
// a previous turn via `previous_response_id`. It is persisted to disk so a
// rotator restart does not break active Codex sessions.
//
// Writes are debounced to avoid fsync storms under load. The store is also
// flushed synchronously on SIGTERM (see index.ts) to minimise data loss.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface StoredResponseEntry {
	response: Record<string, unknown>;
	inputItems: Array<Record<string, unknown>>;
	conversationMessages: Array<Record<string, unknown>>;
	// Maps call_id -> function name. Serialized as plain object on disk
	// because Map cannot be JSON.stringified directly. Convert to Map at use sites.
	callIdToName: Record<string, string>;
	expiresAt: number;
}

interface PersistedStore {
	version: 1;
	entries: Array<[string, StoredResponseEntry]>;
}

const FLUSH_DEBOUNCE_MS = 1_500;
const MAX_ENTRIES = 500;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;

function getStorePath(): string {
	return join(process.env.PI_ROTATOR_DIR ?? join(homedir(), ".pi-antigravity-rotator"), "responses.json");
}

function now(): number {
	return Date.now();
}

export class ResponsesStore {
	private cache = new Map<string, StoredResponseEntry>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushing: Promise<void> | null = null;
	private pendingFlush = false;
	private readonly path: string;
	private dirty = false;

	constructor(path: string = getStorePath()) {
		this.path = path;
	}

	/**
	 * Load the persisted store from disk. Missing or corrupt files are treated
	 * as an empty store. Stale entries (older than TTL) are pruned.
	 */
	async load(): Promise<void> {
		if (!existsSync(this.path)) return;
		try {
			const raw = readFileSync(this.path, "utf-8");
			const parsed = JSON.parse(raw) as PersistedStore;
			if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
			const cutoff = now() - ENTRY_TTL_MS;
			for (const [id, entry] of parsed.entries) {
				if (!entry || typeof entry !== "object") continue;
				if (typeof entry.expiresAt !== "number" || entry.expiresAt < cutoff) continue;
				this.cache.set(id, entry);
			}
		} catch {
			// Corrupt store — start fresh; rename old file aside for inspection.
			try {
				const backup = `${this.path}.corrupt-${now()}.bak`;
				await fs.rename(this.path, backup).catch(() => undefined);
			} catch {
				// ignore
			}
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
	 * Flush pending writes to disk. Safe to call multiple times concurrently;
	 * callers will see the same in-flight promise.
	 */
	async flush(): Promise<void> {
		if (this.flushing) {
			this.pendingFlush = true;
			return this.flushing;
		}
		this.flushing = (async () => {
			try {
				if (!this.dirty) return;
				const data: PersistedStore = {
					version: 1,
					entries: Array.from(this.cache.entries()),
				};
				const dir = join(this.path, "..");
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				const tmp = `${this.path}.tmp`;
				writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
				await fs.rename(tmp, this.path);
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
	 * Synchronous flush for use in shutdown handlers. Falls back to no-op on
	 * platforms where sync fs is not available; the next start will read what
	 * made it to disk.
	 */
	flushSync(): void {
		if (!this.dirty) return;
		try {
			const data: PersistedStore = {
				version: 1,
				entries: Array.from(this.cache.entries()),
			};
			const dir = join(this.path, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const tmp = `${this.path}.tmp`;
			writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
			renameSync(tmp, this.path);
			this.dirty = false;
		} catch {
			// Best effort
		}
	}
}
