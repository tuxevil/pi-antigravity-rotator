const http = require("http");
const req = http.request({
  hostname: "127.0.0.1", port: 51200, path: "/v1/chat/completions", method: "POST",
  headers: {"Content-Type": "application/json"}
}, (res) => {
  console.log("Status:", res.statusCode);
  res.on("data", c => process.stdout.write(c));
  res.on("end", () => console.log("\nDone"));
});
req.write(JSON.stringify({
  model: "gemini-1.5-pro", 
  messages: [{role: "user", content: "hola"}, {role: "assistant", content: "hola2"}, {role: "user", content: "estas?"}], 
  stream: true 
}));
req.end();
