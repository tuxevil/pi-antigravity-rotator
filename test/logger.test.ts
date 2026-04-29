import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	Logger,
	parseLogLevel,
	redactSensitive,
	shouldLog,
} from "../src/logger.js";

describe("logger", () => {
	it("parses known log levels and defaults to info", () => {
		assert.equal(parseLogLevel("debug"), "debug");
		assert.equal(parseLogLevel("info"), "info");
		assert.equal(parseLogLevel("warn"), "warn");
		assert.equal(parseLogLevel("error"), "error");
		assert.equal(parseLogLevel("silent"), "silent");
		assert.equal(parseLogLevel("nope"), "info");
		assert.equal(parseLogLevel(undefined), "info");
	});

	it("filters messages by configured level", () => {
		assert.equal(shouldLog("debug", "info"), false);
		assert.equal(shouldLog("info", "info"), true);
		assert.equal(shouldLog("warn", "info"), true);
		assert.equal(shouldLog("error", "warn"), true);
		assert.equal(shouldLog("info", "warn"), false);
		assert.equal(shouldLog("error", "silent"), false);
	});

	it("redacts bearer tokens and OAuth-like secrets", () => {
		const input = 'Authorization: Bearer abc.def refreshToken="1//secret" access_token=ya29.secret client_secret="shh"';
		const output = redactSensitive(input);
		assert.doesNotMatch(output, /abc\.def/);
		assert.doesNotMatch(output, /1\/\/secret/);
		assert.doesNotMatch(output, /ya29\.secret/);
		assert.doesNotMatch(output, /shh/);
		assert.match(output, /REDACTED/);
	});

	it("writes scoped lines with timestamp and redaction", () => {
		const lines: string[] = [];
		const logger = new Logger({
			level: "debug",
			now: () => new Date("2026-04-29T07:00:00.000Z"),
			writer: (line) => lines.push(line),
		});
		logger.child("test").info("hello Bearer secret-token");
		assert.deepEqual(lines, ["[07:00:00] [test] hello Bearer [REDACTED]"]);
	});

	it("does not write below configured level", () => {
		const lines: string[] = [];
		const logger = new Logger({ level: "warn", writer: (line) => lines.push(line) });
		logger.child("test").info("hidden");
		logger.child("test").warn("visible");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /visible/);
	});
});
