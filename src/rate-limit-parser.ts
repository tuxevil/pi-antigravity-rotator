export type RateLimitReason = "rate-limit" | "quota-exhausted" | "model-capacity" | "server-error" | "unknown";

function parseDurationToMs(errorText: string): number | null {
	const durationMatch = errorText.match(/(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (!durationMatch) return null;
	const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
	const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
	const seconds = parseFloat(durationMatch[3]);
	if (!Number.isFinite(seconds)) return null;
	return Math.ceil(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

export function classifyRateLimitReason(errorText: string, status?: number): RateLimitReason {
	if (status === 503 || status === 529) return "model-capacity";
	if (status === 500) return "server-error";

	const lower = errorText.toLowerCase();
	if (
		lower.includes("quota_exhausted") ||
		lower.includes("quotaresetdelay") ||
		lower.includes("quotaresettimestamp") ||
		lower.includes("resource_exhausted") ||
		lower.includes("resource exhausted") ||
		lower.includes("daily limit") ||
		lower.includes("quota exceeded")
	) {
		return "quota-exhausted";
	}
	if (
		lower.includes("model_capacity_exhausted") ||
		lower.includes("capacity_exhausted") ||
		lower.includes("currently overloaded") ||
		lower.includes("service temporarily unavailable")
	) {
		return "model-capacity";
	}
	if (
		lower.includes("rate_limit_exceeded") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("throttl")
	) {
		return "rate-limit";
	}
	if (
		lower.includes("internal server error") ||
		lower.includes("server error") ||
		lower.includes("bad gateway") ||
		lower.includes("gateway timeout")
	) {
		return "server-error";
	}
	return "unknown";
}

export function parseRetryAfterMs(errorText: string, headers: Headers): number {
	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000 + 1000);
		const retryDate = new Date(retryAfter);
		if (!Number.isNaN(retryDate.getTime())) {
			const delta = retryDate.getTime() - Date.now();
			if (delta > 0) return Math.ceil(delta + 1000);
		}
	}

	const resetHeader = headers.get("x-ratelimit-reset");
	if (resetHeader) {
		const resetTs = Number(resetHeader);
		if (Number.isFinite(resetTs) && resetTs > 0) {
			const delta = resetTs * 1000 - Date.now();
			if (delta > 0) return Math.ceil(delta + 1000);
		}
	}

	const resetAfter = headers.get("x-ratelimit-reset-after");
	if (resetAfter) {
		const seconds = Number(resetAfter);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000 + 1000);
	}

	const quotaDelayMatch = errorText.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i);
	if (quotaDelayMatch) {
		const value = parseFloat(quotaDelayMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const ms = quotaDelayMatch[2].toLowerCase() === "s" ? value * 1000 : value;
			return Math.ceil(ms + 1000);
		}
	}

	const quotaTimestampMatch = errorText.match(/quotaResetTimeStamp[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
	if (quotaTimestampMatch) {
		const resetTime = new Date(quotaTimestampMatch[1]).getTime();
		if (!Number.isNaN(resetTime)) {
			const delta = resetTime - Date.now();
			if (delta > 0) return Math.ceil(delta + 1000);
		}
	}

	const retryDelayMatch = errorText.match(/(?:retry[-_]?after[-_]?ms|retryDelay|Please retry in)[:\s"]+([0-9.]+)(ms|s)/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	const naturalRetryMatch = errorText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|secs|seconds|s\b)/i);
	if (naturalRetryMatch?.[1]) {
		const seconds = Number(naturalRetryMatch[1]);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000 + 1000);
	}

	const resetAfterMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (resetAfterMatch) {
		const duration = parseDurationToMs(resetAfterMatch[0]);
		if (duration && duration > 0) return Math.ceil(duration + 1000);
	}

	const duration = parseDurationToMs(errorText);
	if (duration && duration > 0) return Math.ceil(duration + 1000);

	return 60_000;
}
