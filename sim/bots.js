#!/usr/bin/env node
// Headless level bots. Extracts the simulation (between the SIM START/END markers) from a
// game HTML file and plays every level the naive way and the intended way, N runs each.
// A level is balanced when the naive bot loses and the intended bot wins.
//
//   node sim/bots.js prototypes/token-kitchen.html [runs=3]
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'prototypes', 'token-kitchen.html');
const RUNS = +(process.argv[3] || 3);
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/\/\/ ---- SIM START ----[\s\S]*?\/\/ ---- SIM END ----/);
if (!m) { console.error('no SIM START/END markers in', file); process.exit(2); }

// Evaluate the sim in this scope so the bots below can reach its globals.
// eslint-disable-next-line no-eval
eval(m[0] + `
// ---- bots ----
function run(li, setup, policy, label) {
  const out = [];
  for (let n = 0; n < RUNS; n++) {
    startLevel(LEVELS[li]); S.speed = 1; setup && setup(); let last = -1;
    while (!S.over) { simStep(0.02); if (policy && S.t - last >= 0.5) { last = S.t; policy(); } }
    out.push((S.win ? 'WIN' + starsFor() : 'lose') + ' t=' + S.t.toFixed(0) + ' srv=' + S.served
      + ' hap=' + Math.round(happyPct() * 100) + ' ang=' + S.angry + (S.L.rent ? ' prof=' + Math.round(profit()) : '')
      + (S.why ? ' (' + S.why.slice(0, 24) + ')' : ''));
  }
  console.log(('L' + (li + 1) + ' ' + label).padEnd(28), out.join(' | '));
}
const burners = v => () => { for (const k of S.kitchens) k.burners = v; };
function fleet(type, head) {
  return () => {
    const rush = S.events.find(e => e.type === 'rush' && S.t >= e.at - 16 && S.t < e.at + e.dur);
    const look = Math.max(S.rate, S.L.rate(S.t + 15) * (rush ? rush.mult : 1));
    const capAll = capacity(true), ups = S.kitchens.filter(k => k.state === 'up');
    if (capAll < look * head && serving().length < S.L.lots) addKitchen(type, 48);
    else if (capAll > look * head * 2.2 && ups.length > 1) closeKitchen(ups.sort((a, b) => a.run.length - b.run.length)[0]);
  };
}
console.log('bots on', path.basename(file), '·', RUNS, 'runs each\\n');
run(0, null, null, 'naive: 1 burner');
run(0, burners(8), null, 'intended: 8 burners');
run(1, null, null, 'naive: static batching');
run(1, null, () => { if (S.t > 8) S.static = false; }, 'intended: continuous');
run(2, null, null, 'naive: no spec decode');
run(2, () => { S.spec = true; }, null, 'intended: spec decode');
run(3, null, null, 'naive: nothing');
run(3, () => { S.prefix = true; }, null, 'intended: prefix cache');
run(4, null, null, 'naive: nothing');
run(4, () => { for (let i = 0; i < 5; i++) addKitchen('L4', 48, true); }, null, 'naive: 6 kitchens all day');
run(4, null, fleet('L4', 1.3), 'intended: scale to demand');
run(5, null, null, 'naive: nothing');
run(5, null, fleet('L4', 1.4), 'intended: scale to demand');
`);
