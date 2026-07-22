const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('-flags.jsonl')).sort();

let totalFlags = 0;
let whaleFlags = 0;

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const fl = JSON.parse(line);
      totalFlags++;
      if (fl.installId === '6ebfe1d1-547c-4a68-9ea3-dfd29116e52e') {
         whaleFlags++;
      }
    } catch(e) {}
  }
}
console.log(`Total Flags in DB: ${totalFlags}`);
console.log(`Whale Flags: ${whaleFlags}`);
