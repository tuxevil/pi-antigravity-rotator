const OpenAI = require("openai");
const openai = new OpenAI({ baseURL: "http://127.0.0.1:51200/v1/", apiKey: "antigravity" });
openai.chat.completions.create({ 
  model: "gemini-3-flash", 
  messages: [
    {role: "user", content: "hola"},
    {role: "assistant", content: "¡Hola! Soy Antigravity."},
    {role: "user", content: "estas?"}
  ], 
  stream: true 
})
  .then(async stream => { for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || ""); console.log(); })
  .catch(console.error);
