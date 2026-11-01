#!/usr/bin/env node
// Headless bots for the Tokenworks engine (game/sim.js). Each level is played the naive way and
// the intended way, N runs each. A level is balanced when naive loses and intended wins.
//
//   node sim/arcade-bots.js [runs=3]
'use strict';
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'game', 'sim.js'));
const RUNS = +(process.argv[2] || 3);

// A dispatcher policy: given S, fire waiting capsules into machines. react = seconds a bot takes
// to notice a capsule (a human-ish delay so the bots don't out-play people).
function dispatcher(pick, react = 0.6) {
  return S => {
    for (const r of S.queue.slice()) {
      if (r.phase !== 'lane' || S.t - r.t0 < react) continue;
      const m = pick(S, r);
      if (m != null) Sim.place(S, r.id, m);
    }
  };
}
const random = dispatcher((S, r) => Math.floor(Math.random() * S.machines.length));
const roundRobin = (() => { let i = 0; return dispatcher((S, r) => (i++) % S.machines.length); })();
// Intended for level 3: same colour → the machine already warm for it; else the emptier machine.
const affinity = dispatcher((S, r) => {
  const free = m => m.rails - m.run.length - m.pending.length;
  if (r.shared) {
    const warm = S.machines.filter(m => Sim.isWarm(S, m, r.family) && free(m) > 0);
    if (warm.length) return warm[0].id;
    const cold = S.machines.filter(m => !Object.keys(m.warm).some(f => Sim.isWarm(S, m, +f)) && free(m) > 0);
    if (cold.length) return cold[0].id;
  }
  const best = S.machines.slice().sort((a, b) => free(b) - free(a))[0];
  return free(best) > 0 ? best.id : null;
});

function run(levelIdx, label, setup, policy, tick) {
  const out = [];
  for (let n = 0; n < RUNS; n++) {
    const S = Sim.create(levelIdx);
    setup && setup(S);
    let lastPolicy = -1;
    while (!S.over) {
      Sim.step(S, 0.02);
      S.fx.length = 0;
      if (S.t - lastPolicy >= 0.25) { lastPolicy = S.t; policy(S); tick && tick(S); }
      if (S.L.endless && S.t > 240) break;
    }
    const slo = Math.round(Sim.sloPct(S) * 100);
    out.push((S.L.endless ? 'score=' + S.score + ' t=' + S.t.toFixed(0) : (S.win ? 'WIN' + Sim.stars(S) : 'lose'))
      + ' del=' + S.delivered + ' slo=' + slo + '% to=' + S.timeouts + ' bnc=' + S.bounces + ' pre=' + S.preempted
      + (S.why ? ' (' + S.why.slice(0, 26) + ')' : ''));
  }
  console.log(('L' + Sim.LEVELS[levelIdx].id + ' ' + label).padEnd(30), out.join(' | '));
}

module.exports = { dispatcher, random, roundRobin, affinity, run };
if (require.main !== module) return;
console.log('arcade bots ·', RUNS, 'runs each\n');
run(0, 'naive: keep 2 rails', null, random);
run(0, 'intended: 8 rails', S => Sim.setRails(S, 0, 8), random);
run(1, 'naive: stay static', null, random);
run(1, 'intended: continuous@8s', null, random, S => { if (S.modeUnlocked && S.machines[0].mode === 'static') Sim.setMode(S, 0, 'continuous'); });
run(2, 'naive: random routing', null, random);
run(2, 'naive: round robin', null, roundRobin);
run(2, 'intended: colour affinity', null, affinity);
run(2, 'intended: affinity, 12 rails', S => { Sim.setRails(S, 0, 12); Sim.setRails(S, 1, 12); }, affinity);
run(3, 'endless: affinity 12 rails', S => { Sim.setRails(S, 0, 12); Sim.setRails(S, 1, 12); }, affinity);
