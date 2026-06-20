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

await testDirect("high/as-gemini-pro-agent", {
  "project": "test",
  "model": "gemini-pro-agent",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "text": "hi"
          }
        ]
      }
    ],
    "generationConfig": {
      "thinkingConfig": {
        "includeThoughts": true,
        "thinkingBudget": 10001
      }
    }
  }
});
