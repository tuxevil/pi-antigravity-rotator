import { AccountStore } from "../src/account-store.js";
import { AccountRotator } from "../src/rotator.js";
import { QUOTA_API_URL, QUOTA_USER_AGENT } from "../src/types.js";

async function main() {
    const store = new AccountStore("/root/.pi-antigravity-rotator");
    await store.load();
    const rotator = new AccountRotator(store);
    
    const account = rotator.getAccountByEmail(store.getConfig().accounts[0].email);
    if (!account) throw new Error("No account");
    
    await rotator.ensureValidToken(account);
    console.log("Token valid");
    
    const res = await fetch(QUOTA_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${account.accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": QUOTA_USER_AGENT
        },
        body: JSON.stringify({ project: account.config.projectId })
    });
    
    console.log(res.status);
    const text = await res.text();
    import("fs").then(fs => fs.writeFileSync("models.json", text));
    console.log("Wrote to models.json");
}

main().catch(console.error);
