const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('flags')).sort();

const MODEL_PRICING = {
	"claude-opus-4-6-thinking": { inputPer1M: 5.00,  outputPer1M: 25.00 },
	"claude-sonnet-4-6":        { inputPer1M: 3.00,  outputPer1M: 15.00 },
	"gemini-3.1-pro":           { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-low":       { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-high":      { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3-flash":           { inputPer1M: 0.50,  outputPer1M: 3.00 },
	"gemini-3.5-flash":         { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-low":     { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-high":    { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.6-flash":         { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-high":    { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-low":     { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-tiered":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gpt-oss-120b-medium":      { inputPer1M: 2.00,  outputPer1M: 10.00 },
};

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

let totalInUsd = 0;
let totalOutUsd = 0;
for (const [model, t] of Object.entries(latest.tokensByModel || {})) {
  const price = MODEL_PRICING[model];
  if (price) {
     const inUsd = (t.input / 1000000) * price.inputPer1M;
     const outUsd = (t.output / 1000000) * price.outputPer1M;
     console.log(`Model: ${model}`);
     console.log(`  Input: $${inUsd.toFixed(2)} (${t.input.toLocaleString()} tokens)`);
     console.log(`  Output: $${outUsd.toFixed(2)} (${t.output.toLocaleString()} tokens)`);
     totalInUsd += inUsd;
     totalOutUsd += outUsd;
  }
}

console.log(`\nGRAND TOTAL INPUT USD: $${totalInUsd.toFixed(2)}`);
console.log(`GRAND TOTAL OUTPUT USD: $${totalOutUsd.toFixed(2)}`);
