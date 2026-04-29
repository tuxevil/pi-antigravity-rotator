import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
	DEFAULT_MAX_BODY_BYTES,
	PayloadTooLargeError,
	getMaxBodyBytes,
	readLimitedBody,
} from "../src/body-limit.js";

function requestStream(headers: IncomingMessage["headers"] = {}): IncomingMessage & PassThrough {
	const stream = new PassThrough() as IncomingMessage & PassThrough;
	stream.headers = headers;
	return stream;
}

describe("body limit helpers", () => {
	it("uses 25 MiB default body limit", () => {
		assert.equal(DEFAULT_MAX_BODY_BYTES, 25 * 1024 * 1024);
		assert.equal(getMaxBodyBytes({}), DEFAULT_MAX_BODY_BYTES);
	});

	it("parses positive integer env override", () => {
		assert.equal(getMaxBodyBytes({ PI_ROTATOR_MAX_BODY_BYTES: "1024" }), 1024);
		assert.equal(getMaxBodyBytes({ PI_ROTATOR_MAX_BODY_BYTES: "5.9" }), 5);
	});

	it("falls back to default for invalid env override", () => {
		assert.equal(getMaxBodyBytes({ PI_ROTATOR_MAX_BODY_BYTES: "0" }), DEFAULT_MAX_BODY_BYTES);
		assert.equal(getMaxBodyBytes({ PI_ROTATOR_MAX_BODY_BYTES: "nope" }), DEFAULT_MAX_BODY_BYTES);
	});

	it("reads body within limit", async () => {
		const req = requestStream();
		const promise = readLimitedBody(req, 10);
		req.end("hello");
		assert.equal((await promise).toString("utf-8"), "hello");
	});

	it("rejects immediately when content-length exceeds limit", async () => {
		const req = requestStream({ "content-length": "11" });
		await assert.rejects(readLimitedBody(req, 10), PayloadTooLargeError);
	});

	it("rejects streamed body when accumulated bytes exceed limit", async () => {
		const req = requestStream();
		const promise = readLimitedBody(req, 4);
		req.write("he");
		req.write("llo");
		await assert.rejects(promise, PayloadTooLargeError);
	});
});
