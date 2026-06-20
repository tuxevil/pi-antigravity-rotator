import { ResponsesStore, type StoredResponseEntry } from "../responses-store.js";

export const thoughtSignatureCache = new Map<string, string>();
const THOUGHT_SIGNATURE_CACHE_MAX = 500;
export const responsesStore = new ResponsesStore();

export function makeCompatId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function getStoredResponse(id: string): StoredResponseEntry | null {
	return responsesStore.get(id);
}

export function setStoredResponse(id: string, entry: StoredResponseEntry): void {
	responsesStore.set(id, entry);
}

export function resetResponsesStoreForTests(): void {
	responsesStore.clear();
}

export async function loadResponsesStore(): Promise<void> {
	await responsesStore.load();
}

export async function flushResponsesStore(): Promise<void> {
	await responsesStore.flush();
}

export function flushResponsesStoreSync(): void {
	responsesStore.flushSync();
}

export function cacheThoughtSignature(callId: string, signature: string): void {
	if (thoughtSignatureCache.size >= THOUGHT_SIGNATURE_CACHE_MAX) {
		// Evict the oldest entry
		const firstKey = thoughtSignatureCache.keys().next().value;
		if (firstKey !== undefined) thoughtSignatureCache.delete(firstKey);
	}
	thoughtSignatureCache.set(callId, signature);
}
