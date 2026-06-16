const http = require("http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => body += chunk.toString());
  req.on("end", () => {
    console.log(`\n\n[MITM] Incoming ${req.method} ${req.url}`);
    console.log(`[MITM] Body:`, body.substring(0, 500) + (body.length > 500 ? "..." : ""));
    const proxyReq = http.request({
      hostname: "127.0.0.1", port: 51200, path: req.url, method: req.method, headers: req.headers
    }, (proxyRes) => {
      console.log(`[MITM] Response status:`, proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.write(body);
    proxyReq.end();
  });
}).listen(51201, () => console.log("MITM listening on 51201"));
