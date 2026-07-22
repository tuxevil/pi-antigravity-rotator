const fs = require('fs');
const path = require('path');

const dir = process.env.HOME + '/rotator-telemetry';
const allFiles = fs.readdirSync(dir).sort();
const eventFiles = allFiles.filter(f => f.endsWith('.jsonl') && !f.includes('flags'));
const flagFiles = allFiles.filter(f => f.endsWith('-flags.jsonl'));

const TARGET_ID = '6ebfe1d1-547c-4a68-9ea3-dfd29116e52e';

const timeline = [];
const flagEvents = [];

for (const file of eventFiles) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.installId === TARGET_ID && ev.event === 'heartbeat') {
        timeline.push(ev);
      }
    } catch(e) {}
  }
}

for (const file of flagFiles) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.installId === TARGET_ID && ev.event === 'flag') {
        flagEvents.push(ev.flag);
      }
    } catch(e) {}
  }
}

console.log(`Analyzing data for ${TARGET_ID}`);
console.log(`Found ${timeline.length} heartbeats and ${flagEvents.length} flag events.`);

// Sort by timestamp
timeline.sort((a, b) => new Date(a.ts) - new Date(b.ts));

if (timeline.length === 0) {
  console.log("No heartbeat data.");
  process.exit(0);
}

const first = timeline[0];
const last = timeline[timeline.length - 1];

console.log(`\n--- SUMMARY ---`);
console.log(`First seen: ${first.ts}`);
console.log(`Last seen:  ${last.ts}`);
console.log(`Account configuration: ${last.accountCount} total (${last.freeCount} free, ${last.proCount} pro)`);
console.log(`Models used: ${last.modelsUsed.join(', ')}`);
console.log(`Uptime reported: ${Math.round(last.uptimeSeconds / 3600)} hours`);
console.log(`Total Requests (cumulative): ${last.totalRequests}`);

const geminiFlash = last.tokensByModel && last.tokensByModel['gemini-3.5-flash'];
if (geminiFlash) {
  console.log(`\n--- GEMINI-3.5-FLASH STATS ---`);
  console.log(`Total Input Tokens: ${geminiFlash.input.toLocaleString()}`);
  console.log(`Total Output Tokens: ${geminiFlash.output.toLocaleString()}`);
  console.log(`Total Requests: ${geminiFlash.requests.toLocaleString()}`);
  if (geminiFlash.requests > 0) {
    console.log(`Average Input per Request: ${Math.round(geminiFlash.input / geminiFlash.requests).toLocaleString()}`);
    console.log(`Average Output per Request: ${Math.round(geminiFlash.output / geminiFlash.requests).toLocaleString()}`);
  }
}

console.log(`\n--- FLAG EVENTS ---`);
console.log(`Total flags recorded: ${flagEvents.length}`);
const flagCounts = {};
flagEvents.forEach(f => {
  const key = `${f.flagHttpStatus} - ${f.model} (${f.timerType})`;
  flagCounts[key] = (flagCounts[key] || 0) + 1;
});
for (const [k, v] of Object.entries(flagCounts)) {
  console.log(`  ${k}: ${v} times`);
}

// Check activity gaps (is it a human or a bot?)
const gaps = [];
for (let i = 1; i < timeline.length; i++) {
  const t1 = new Date(timeline[i-1].ts).getTime();
  const t2 = new Date(timeline[i].ts).getTime();
  const diffHours = (t2 - t1) / (1000 * 60 * 60);
  if (diffHours > 2) {
    gaps.push(diffHours);
  }
}

console.log(`\n--- BEHAVIOR ANALYSIS ---`);
console.log(`Found ${gaps.length} periods of inactivity > 2 hours.`);
if (gaps.length > 0) {
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`Average gap length: ${avgGap.toFixed(1)} hours`);
  if (gaps.length >= (timeline.length / 24) * 0.5) {
    console.log("Verdict: Likely a HUMAN using an interactive dev tool (sleeps/pauses).");
  } else {
    console.log("Verdict: Mixed/Automated usage with some downtime.");
  }
} else {
  console.log("Verdict: Likely an AUTOMATED PIPELINE / BOT (running 24/7 without pauses).");
}
