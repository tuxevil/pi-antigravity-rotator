import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverProject } from "../src/oauth.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("oauth project discovery", () => {
	it("returns discovered project id from Google", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ cloudaicompanionProject: { id: "proj-123" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await discoverProject("token");
		assert.equal(result.projectId, "proj-123");
		assert.equal(result.source, "google");
		assert.ok(result.endpoint.includes("cloudcode-pa"));
		assert.equal(calls, 1);
	});

	it("fails instead of falling back to a shared project id", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

		await assert.rejects(
			discoverProject("token"),
			/Could not discover Cloud Code companion project ID from Google/,
		);
	});
});
