const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('flags')).sort();

let matches = {};

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.accountCount === 21) {
        if (!matches[ev.installId]) {
          matches[ev.installId] = { maxInput: 0, maxOutput: 0, maxReqs: 0, models: new Set() };
        }
        for (const [m, t] of Object.entries(ev.tokensByModel || {})) {
          matches[ev.installId].models.add(m);
          if (m.includes('gemini-3.1-pro')) {
             matches[ev.installId].maxInput = Math.max(matches[ev.installId].maxInput, t.input);
             matches[ev.installId].maxOutput = Math.max(matches[ev.installId].maxOutput, t.output);
             matches[ev.installId].maxReqs = Math.max(matches[ev.installId].maxReqs, t.requests);
          }
        }
      }
    } catch(e) {}
  }
}

for (const [id, data] of Object.entries(matches)) {
  console.log(`Install: ${id}`);
  console.log(`  Models: ${Array.from(data.models).join(', ')}`);
  console.log(`  Pro Input Tokens: ${data.maxInput.toLocaleString()}`);
  console.log(`  Pro Output Tokens: ${data.maxOutput.toLocaleString()}`);
  console.log(`  Pro Requests: ${data.maxReqs.toLocaleString()}`);
}
