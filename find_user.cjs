const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('flags'));

let targetId = null;

for (let i = files.length - 1; i >= 0; i--) {
  const file = files[i];
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.accountCount === 21 && ev.modelsUsed && ev.modelsUsed.includes('gemini-3.5-flash')) {
        targetId = ev.installId;
        break;
      }
    } catch(e) {}
  }
  if (targetId) break;
}

console.log("Found ID:", targetId);
