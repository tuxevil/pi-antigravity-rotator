import http from "node:http";

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
        console.log("----- INCOMING REQUEST -----");
        console.log("URL:", req.url);
        console.log("Headers:", JSON.stringify(req.headers, null, 2));
        console.log("Body:", body);
        console.log("----------------------------");
        
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            error: {
                code: 404,
                message: "Requested entity was not found. (MOCK)",
                status: "NOT_FOUND"
            }
        }));
    });
});

server.listen(51201, () => {
    console.log("Mock Google API listening on port 51201");
});
