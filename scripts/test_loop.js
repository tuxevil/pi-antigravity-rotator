import fs from "fs";

async function main() {
    const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID;
    const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET;
    if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET before running this script.");
    const accounts = JSON.parse(fs.readFileSync("/root/.pi-antigravity-rotator/accounts.json", "utf8")).accounts;

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        console.log(`Testing account ${i}: ${account.email} / ${account.projectId}`);
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
        if (!tokenData.access_token) {
            console.log("  Failed to get token");
            continue;
        }

        const body = {
            project: account.projectId,
            model: "gemini-3-flash",
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
                "User-Agent": "antigravity/1.107.0 darwin/arm64"
            },
            body: JSON.stringify(body)
        });
        console.log("  Status:", res.status);
    }
}
main().catch(console.error);
