async function testDirect(label, body) {
	const r = await fetch("http://localhost:51200/v1internal:streamGenerateContent?alt=sse", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	const text = await r.text();
	const short = text.length > 300 ? text.slice(0, 300) + "..." : text;
	console.log(`[${label}] status=${r.status} ${short}`);
}

async function testCompat(label, body) {
	const r = await fetch("http://localhost:51200/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	const text = await r.text();
	console.log(`[${label}] status=${r.status} ${text.slice(0, 300)}`);
}

// Simulate what Cline sends: model + system prompt + user message
await testCompat("high/compat-with-system", {
	model: "gemini-3.1-pro-high",
	messages: [
		{ role: "system", content: "You are a helpful assistant." },
		{ role: "user", content: "hi" }
	]
});

// No system
await testCompat("high/compat-no-system", {
	model: "gemini-3.1-pro-high",
	messages: [{ role: "user", content: "hi" }]
});

// Low for comparison
await testCompat("low/compat-with-system", {
	model: "gemini-3.1-pro-low",
	messages: [
		{ role: "system", content: "You are a helpful assistant." },
		{ role: "user", content: "hi" }
	]
});
