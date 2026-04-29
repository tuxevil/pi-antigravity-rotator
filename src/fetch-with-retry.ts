export interface FetchWithRetryOptions extends RequestInit {
	retries?: number;
	timeoutMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	retryStatuses?: number[];
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504] as const;

export function isRetryableStatus(status: number, retryStatuses: readonly number[] = DEFAULT_RETRY_STATUSES): boolean {
	return retryStatuses.includes(status);
}

export function isRetryableFetchError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	return error instanceof TypeError;
}

export function calculateBackoffMs(
	attempt: number,
	baseDelayMs = 250,
	maxDelayMs = 5_000,
	random = Math.random,
): number {
	const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
	const jitter = exponential * 0.2 * random();
	return Math.min(maxDelayMs, Math.round(exponential + jitter));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs: number | undefined, inputSignal: AbortSignal | null | undefined): AbortSignal | undefined {
	if (!timeoutMs || timeoutMs <= 0) return inputSignal ?? undefined;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!inputSignal) return timeoutSignal;
	return AbortSignal.any([inputSignal, timeoutSignal]);
}

/**
 * Fetch wrapper for non-streaming calls. Retries only transport failures and explicit retryable statuses.
 * Do not use for streaming responses: retrying streams can duplicate upstream work.
 */
export async function fetchWithRetry(input: RequestInfo | URL, options: FetchWithRetryOptions = {}): Promise<Response> {
	const {
		retries = 2,
		timeoutMs = 10_000,
		baseDelayMs = 250,
		maxDelayMs = 5_000,
		retryStatuses = [...DEFAULT_RETRY_STATUSES],
		fetchImpl = fetch,
		sleepImpl = sleep,
		...init
	} = options;

	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetchImpl(input, {
				...init,
				signal: createTimeoutSignal(timeoutMs, init.signal),
			});

			if (!isRetryableStatus(response.status, retryStatuses) || attempt === retries) {
				return response;
			}

			await response.body?.cancel().catch(() => undefined);
		} catch (err) {
			lastError = err;
			if (!isRetryableFetchError(err) || attempt === retries) {
				throw err;
			}
		}

		await sleepImpl(calculateBackoffMs(attempt, baseDelayMs, maxDelayMs));
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "fetch failed"));
}
