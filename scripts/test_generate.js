import fs from "node:fs";

async function main() {
    const CLIENT_ID = atob("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");
    const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
    const accounts = JSON.parse(fs.readFileSync("/root/.pi-antigravity-rotator/accounts.json", "utf8")).accounts;
    const account = accounts[0];

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: account.refreshToken,
            grant_type: "refresh_token"
        })
    });
    const tokenData = await tokenRes.json();

    const body = {
        project: account.projectId,
        model: "claude-sonnet-4-6",
        requestType: "agent",
        request: {
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
            generationConfig: {}
        }
    };

    const res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
            "User-Agent": "curl/8.5.0"
        },
        body: JSON.stringify(body)
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
}
main().catch(console.error);
