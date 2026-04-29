import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB, high enough for normal agent payloads.

export class PayloadTooLargeError extends Error {
	constructor(readonly limitBytes: number) {
		super(`Request body exceeds ${limitBytes} bytes`);
		this.name = "PayloadTooLargeError";
	}
}

export function getMaxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_ROTATOR_MAX_BODY_BYTES;
	if (!raw) return DEFAULT_MAX_BODY_BYTES;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Read the full request body while enforcing a configurable size limit.
 */
export function readLimitedBody(req: IncomingMessage, limitBytes = getMaxBodyBytes()): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const contentLength = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(contentLength) && contentLength > limitBytes) {
			reject(new PayloadTooLargeError(limitBytes));
			return;
		}

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			totalBytes += chunk.length;
			if (totalBytes > limitBytes) {
				rejected = true;
				reject(new PayloadTooLargeError(limitBytes));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks));
		});
		req.on("error", (err) => {
			if (!rejected) reject(err);
		});
	});
}
