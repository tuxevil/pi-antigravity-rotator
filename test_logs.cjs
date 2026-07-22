const { execSync } = require('child_process');
const logs = execSync('journalctl -u pi-antigravity-rotator.service --since "2 days ago" | grep -iE "exhausted|threshold|429|403|quota|flag"').toString();
const flash429 = logs.match(/flash.*429/gi) || [];
const pro429 = logs.match(/pro.*429/gi) || [];
console.log(`Flash 429s: ${flash429.length}`);
console.log(`Pro 429s: ${pro429.length}`);
