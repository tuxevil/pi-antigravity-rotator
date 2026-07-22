const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('flags')).sort();

let latest = {};

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.installId === '6ebfe1d1-547c-4a68-9ea3-dfd29116e52e') {
         if (!latest.ts || ev.ts > latest.ts) {
            latest = ev;
         }
      }
    } catch(e) {}
  }
}

const flashHigh = latest.tokensByModel['gemini-3.5-flash-high'];
console.log(`Requests: ${flashHigh.requests.toLocaleString()}`);
console.log(`Avg Input/Req: ${(flashHigh.input / flashHigh.requests).toLocaleString()}`);
console.log(`Avg Output/Req: ${(flashHigh.output / flashHigh.requests).toLocaleString()}`);

const firstEv = files[0];
console.log("Found in 40 days worth of data");
