import { openAIToAntigravityBody } from "./src/compat.ts";

const input = {
	model: "gemini-3.1-pro-high",
	messages: [
		{ role: "system", content: "You are a helpful assistant." },
		{ role: "user", content: "hi" }
	]
};

const body = openAIToAntigravityBody(input);
console.log(JSON.stringify(body, null, 2));
