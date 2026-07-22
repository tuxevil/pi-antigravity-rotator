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

const installs = {};

// Parse all heartbeats
for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      const id = ev.installId;
      if (!installs[id]) {
        installs[id] = { firstSeen: ev.ts, lastSeen: ev.ts, events: [] };
      }
      if (ev.ts > installs[id].lastSeen) installs[id].lastSeen = ev.ts;
      if (ev.ts < installs[id].firstSeen) installs[id].firstSeen = ev.ts;
      installs[id].latest = ev; // keeping the most recent heartbeat
    } catch(e) {}
  }
}

// Calculate stats for each install
for (const [id, data] of Object.entries(installs)) {
  const ev = data.latest;
  data.accountCount = ev.accountCount;
  data.totalRequests = ev.totalRequests || 0;
  
  let inUsd = 0, outUsd = 0;
  let inTokens = 0, outTokens = 0;
  let modelReqs = 0;

  for (const [m, t] of Object.entries(ev.tokensByModel || {})) {
    const price = MODEL_PRICING[m];
    if (price) {
      inUsd += (t.input / 1000000) * price.inputPer1M;
      outUsd += (t.output / 1000000) * price.outputPer1M;
    }
    inTokens += t.input;
    outTokens += t.output;
    modelReqs += t.requests;
  }
  data.savings = inUsd + outUsd;
  data.inTokens = inTokens;
  data.outTokens = outTokens;
  data.modelReqs = modelReqs; // Using this as it strictly correlates with token data
  data.activeDays = Math.max(1, (new Date(data.lastSeen) - new Date(data.firstSeen)) / (1000 * 60 * 60 * 24));
}

let you = null;
let whale = installs['6ebfe1d1-547c-4a68-9ea3-dfd29116e52e'];
let others = { count: 0, savings: 0, reqs: 0, inTokens: 0, outTokens: 0, accounts: 0, activeDaysSum: 0 };

for (const [id, data] of Object.entries(installs)) {
  if (data.accountCount === 33 && !you) {
    you = data; // Assuming you are the primary one with 33 accounts
  } else if (id !== '6ebfe1d1-547c-4a68-9ea3-dfd29116e52e') {
    others.count++;
    others.savings += data.savings;
    others.reqs += data.modelReqs;
    others.inTokens += data.inTokens;
    others.outTokens += data.outTokens;
    others.accounts += data.accountCount;
    others.activeDaysSum += data.activeDays;
  }
}

console.log("=== YOU (33 Accounts) ===");
if (you) {
  console.log(`Savings: $${you.savings.toFixed(2)}`);
  console.log(`Input Tokens: ${(you.inTokens / 1000000).toFixed(1)}M | Output Tokens: ${(you.outTokens / 1000000).toFixed(1)}M`);
  console.log(`Requests: ${you.modelReqs.toLocaleString()} (${(you.modelReqs / you.activeDays).toFixed(0)} / day)`);
  console.log(`Avg Input per Request: ${you.modelReqs > 0 ? Math.round(you.inTokens / you.modelReqs).toLocaleString() : 0}`);
  console.log(`Active Days: ${you.activeDays.toFixed(1)}`);
} else {
  console.log("Not found.");
}

console.log("\n=== THE WHALE (21 Accounts) ===");
console.log(`Savings: $${whale.savings.toFixed(2)}`);
console.log(`Input Tokens: ${(whale.inTokens / 1000000).toFixed(1)}M | Output Tokens: ${(whale.outTokens / 1000000).toFixed(1)}M`);
console.log(`Requests: ${whale.modelReqs.toLocaleString()} (${(whale.modelReqs / whale.activeDays).toFixed(0)} / day)`);
console.log(`Avg Input per Request: ${whale.modelReqs > 0 ? Math.round(whale.inTokens / whale.modelReqs).toLocaleString() : 0}`);
console.log(`Active Days: ${whale.activeDays.toFixed(1)}`);

console.log("\n=== THE REST OF THE ECOSYSTEM (Average per User) ===");
if (others.count > 0) {
  console.log(`Total other installs: ${others.count}`);
  console.log(`Avg Accounts per install: ${(others.accounts / others.count).toFixed(1)}`);
  console.log(`Avg Savings per install: $${(others.savings / others.count).toFixed(2)}`);
  
  const avgReqs = others.reqs / others.count;
  const avgIn = others.inTokens / others.count;
  
  console.log(`Avg Input Tokens per install: ${(avgIn / 1000000).toFixed(1)}M`);
  console.log(`Avg Requests per install: ${Math.round(avgReqs).toLocaleString()}`);
  console.log(`Avg Input per Request: ${avgReqs > 0 ? Math.round(avgIn / avgReqs).toLocaleString() : 0}`);
  console.log(`Avg Active Days: ${(others.activeDaysSum / others.count).toFixed(1)}`);
}

