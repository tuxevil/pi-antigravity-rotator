import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	validateAccountConfigLengths,
	MAX_EMAIL_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_PROJECT_ID_LENGTH,
	MAX_REFRESH_TOKEN_LENGTH,
} from "../src/account-store.js";

function makeAccount(overrides: Record<string, string> = {}): {
	email: string;
	refreshToken: string;
	projectId: string;
	label?: string;
} {
	return {
		email: "valid@example.com",
		refreshToken: "1//rt",
		projectId: "proj-123",
		...overrides,
	};
}

describe("validateAccountConfigLengths (S11)", () => {
	it("accepts a normal account", () => {
		assert.doesNotThrow(() => validateAccountConfigLengths(makeAccount()));
	});

	it("rejects an email longer than 254 chars", () => {
		const longEmail = "a".repeat(MAX_EMAIL_LENGTH) + "@example.com";
		assert.throws(
			() => validateAccountConfigLengths(makeAccount({ email: longEmail })),
			/exceeds maximum length 254/,
		);
	});

	it("rejects a label longer than 100 chars", () => {
		const longLabel = "L".repeat(MAX_LABEL_LENGTH + 1);
		assert.throws(
			() => validateAccountConfigLengths(makeAccount({ label: longLabel })),
			/exceeds maximum length 100/,
		);
	});

	it("rejects a projectId longer than 100 chars", () => {
		const longProject = "p".repeat(MAX_PROJECT_ID_LENGTH + 1);
		assert.throws(
			() => validateAccountConfigLengths(makeAccount({ projectId: longProject })),
			/exceeds maximum length 100/,
		);
	});

	it("rejects a refreshToken longer than 4096 chars", () => {
		const longToken = "1//" + "x".repeat(MAX_REFRESH_TOKEN_LENGTH);
		assert.throws(
			() => validateAccountConfigLengths(makeAccount({ refreshToken: longToken })),
			/exceeds maximum length 4096/,
		);
	});

	it("accepts fields exactly at the limit", () => {
		// "@example.com" is 12 chars, so we pad with 242 a's to reach 254 total.
		const emailAtLimit = "a".repeat(MAX_EMAIL_LENGTH - 12) + "@example.com";
		assert.equal(emailAtLimit.length, MAX_EMAIL_LENGTH);
		assert.doesNotThrow(() =>
			validateAccountConfigLengths(makeAccount({ email: emailAtLimit })),
		);
	});

	it("exposes the length constants as expected", () => {
		assert.equal(MAX_EMAIL_LENGTH, 254);
		assert.equal(MAX_LABEL_LENGTH, 100);
		assert.equal(MAX_PROJECT_ID_LENGTH, 100);
		assert.equal(MAX_REFRESH_TOKEN_LENGTH, 4096);
	});
});
