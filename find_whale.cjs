const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('flags'));

const whales = new Set();

for (let i = files.length - 1; i >= 0; i--) {
  const file = files[i];
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.tokensByModel && ev.tokensByModel['gemini-3.5-flash']) {
        const input = ev.tokensByModel['gemini-3.5-flash'].input;
        if (input > 1000000000) { // > 15 billion
          whales.add(ev.installId);
        }
      }
    } catch(e) {}
  }
}

console.log("Found Whale IDs:", Array.from(whales));
