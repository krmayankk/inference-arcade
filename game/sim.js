// Tokenworks simulation engine. Pure JS, no DOM: runs in the browser (window.Sim) and in node
// (sim/bots.js). The renderer only reads state and drains S.fx; the player's actions come in
// through place(), shed(), setRails() and setMode().
//
// One machine is one GPU serving Qwen2.5-Coder-7B. A decode step costs base + per × running
// sequences (+ prefill of newly admitted ones). The L4 numbers are measured on the gpu-inference
// cluster (28.8 tok/s single stream → 34.7 ms base step); others are bandwidth-ratio estimates.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCK = 16;
  const GPU = {
    L4:   { name: 'NVIDIA L4 · 24 GB',   base: 0.0347, per: 0.00040, prefill: 5000,  kvTokens: 210000,  boot: 12, usd: 0.98, measured: true },
    A100: { name: 'NVIDIA A100 · 80 GB', base: 0.0100, per: 0.00008, prefill: 11000, kvTokens: 1100000, boot: 15, usd: 4.10 },
    H100: { name: 'NVIDIA H100 · 80 GB', base: 0.0050, per: 0.00004, prefill: 35000, kvTokens: 1100000, boot: 15, usd: 6.90 },
  };
  const COIN_PER_TOKEN = 0.02;
  const PREFIX_TTL = 25;          // seconds a family's prefix stays cached after its last use
  const BATCH_WINDOW = 1.5;       // static batching: seconds the batch stays open to collect sequences
  const FAMILY_NAMES = ['Blue', 'Rose', 'Lime', 'Gold'];

  const LEVELS = [
    {
      id: 1, name: 'First shift',
      brief: 'Capsules are requests. Catch one with the ship and fire it into a rail on the machine. ' +
             'Every turn of the wheel stamps one token onto every occupied rail. Two rails will not keep up: add rails and watch how little the wheel slows.',
      goalText: 'Deliver 25 replies before the clock runs out. 5 timeouts and the shift is over.',
      learn: 'Adding rails barely slows the wheel. One turn streams the whole model once, whether 1 or 8 rails ride it. That is batching, and it is why one GPU can serve many people.',
      machines: [{ type: 'L4', rails: 2 }], railsMax: 8, levers: ['rails'],
      patience: 6, slo: { ttft: 3 }, families: 1, shared: 0, sharedTokens: 0,
      prompt: [80, 400], out: [40, 160],
      rate: () => 0.85, events: [],
      goal: { deliver: 25, timeLimit: 100, maxTimeouts: 5 }, stars: [0.8, 0.95],
    },
    {
      id: 2, name: 'Batch lock',
      brief: 'This machine runs old-school batches: once the wheel starts a batch, the rails are locked until every sequence in it finishes. ' +
             'Fire into a locked machine and the capsule bounces. Find the lever that fixes it.',
      goalText: 'Deliver 30 replies. 6 timeouts and the shift is over.',
      learn: 'Static batching holds every rail until the longest sequence finishes, so short replies leave rails idle. Continuous batching refills a rail the moment it frees up: same machine, far more replies.',
      machines: [{ type: 'L4', rails: 8, mode: 'static' }], railsMax: 8, levers: ['mode'], modeUnlockAt: 8,
      patience: 6, slo: { ttft: 3 }, families: 1, shared: 0, sharedTokens: 0,
      prompt: [80, 400], out: [30, 300],
      rate: () => 0.9, events: [],
      goal: { deliver: 30, timeLimit: 110, maxTimeouts: 6 }, stars: [0.75, 0.9],
    },
    {
      id: 3, name: 'Two machines',
      brief: 'Two machines, three colours. Capsules with a long ribbon carry a big shared prompt: the first of its colour makes the reader grind, ' +
             'the next ones of the same colour on the same machine are nearly free. Route by colour, and spread the load. A rush is coming.',
      goalText: 'Deliver 50 replies with at least 75% on time. 8 timeouts and the shift is over.',
      learn: 'Routing is a lever. Sending requests that share a prefix to the same GPU hits its prefix cache (no re-read, less memory). That is prefix-aware routing, the heart of modern inference routers.',
      machines: [{ type: 'L4', rails: 8 }, { type: 'L4', rails: 8 }], railsMax: 12, levers: ['rails'],
      patience: 5, slo: { ttft: 2.5 }, families: 3, shared: 0.8, sharedTokens: 16000,
      prompt: [60, 300], out: [40, 160],
      rate: t => 1.2, events: [{ kind: 'rush', at: 50, dur: 15, mult: 1.6, name: 'Rush hour' }],
      goal: { deliver: 50, timeLimit: 120, maxTimeouts: 8, sloMin: 0.75 }, stars: [0.82, 0.9],
    },
    {
      id: 0, name: 'Endless', endless: true,
      brief: 'Traffic climbs forever. How long can you keep the rails fed?',
      goalText: 'Score as much as you can. 8 timeouts ends the run.',
      learn: '',
      machines: [{ type: 'L4', rails: 8 }, { type: 'L4', rails: 8 }], railsMax: 12, levers: ['rails', 'mode'],
      patience: 5, slo: { ttft: 2.5 }, families: 3, shared: 0.5, sharedTokens: 6000,
      prompt: [60, 300], out: [40, 200],
      rate: t => 0.8 + t / 45, events: [],
      goal: { timeLimit: 1e9, maxTimeouts: 8 }, stars: [0, 0],
    },
  ];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const expo = rate => -Math.log(1 - Math.random()) / Math.max(0.05, rate);

  function create(levelIdx) {
    const L = LEVELS[levelIdx];
    const S = {
      L, levelIdx, t: 0, over: false, win: false, why: '',
      score: 0, coins: 0, goodput: 0, combo: 0, bestCombo: 0,
      delivered: 0, inSlo: 0, timeouts: 0, shed: 0, preempted: 0, bounces: 0,
      queue: [], machines: [], seq: 0, nextArr: 0.8, rate: 0, rush: null,
      events: L.events.map(e => Object.assign({ warned: false }, e)),
      fx: [], modeUnlocked: !L.levers.includes('mode') ? true : L.modeUnlockAt == null,
      acc: 0, recent: [],
    };
    L.machines.forEach((m, i) => S.machines.push(newMachine(S, i, m)));
    return S;
  }

  function newMachine(S, i, spec) {
    return {
      id: i, type: spec.type, rails: spec.rails, mode: spec.mode || 'continuous',
      run: [], pending: [], t: 0, stepT: 0, stepDur: GPU[spec.type].base, step: 0,
      batchOpenAt: null, warm: {}, kvFullAt: -99, last: null, tok: 0, tokRate: 0, bounces: 0,
    };
  }

  // ---------- requests ----------
  function spawn(S) {
    const L = S.L, id = ++S.seq;
    const family = Math.floor(Math.random() * L.families);
    const shared = Math.random() < L.shared;
    const own = Math.round(rnd(L.prompt[0], L.prompt[1]));
    S.queue.push({
      id, t0: S.t, family, shared, prompt: own + (shared ? L.sharedTokens : 0), own,
      out: Math.round(rnd(L.out[0], L.out[1])), gen: 0, tFirst: null, tDone: null,
      machine: null, phase: 'lane', bounced: 0, preempts: 0,
    });
    S.fx.push({ kind: 'spawn', id });
  }

  const capBlocks = m => Math.floor(GPU[m.type].kvTokens / BLOCK);
  const ownBlocks = (S, r, m) => Math.ceil(((r.shared && m.warm[r.family]) ? r.own : r.prompt) + r.gen) / BLOCK;
  function usedBlocks(S, m) {
    let u = 0;
    const fam = {};
    for (const r of m.run.concat(m.pending)) { u += ownBlocks(S, r, m); if (r.shared) fam[r.family] = 1; }
    for (const f in m.warm) if (m.warm[f] && (fam[f] || S.t - m.warm[f] < PREFIX_TTL)) u += Math.ceil(S.L.sharedTokens / BLOCK);
    return u;
  }
  const isWarm = (S, m, family) => !!m.warm[family] && S.t - m.warm[family] < PREFIX_TTL;

  // Player fires a capsule into a machine. Returns {ok} or {ok:false, reason}.
  function place(S, reqId, machineId) {
    if (S.over) return { ok: false, reason: 'over' };
    const r = S.queue.find(x => x.id === reqId && x.phase === 'lane');
    const m = S.machines[machineId];
    if (!r || !m) return { ok: false, reason: 'gone' };
    let reason = null;
    if (m.mode === 'static' && m.run.length) reason = 'locked';
    else if (m.run.length + m.pending.length >= m.rails) reason = 'rails';
    else if (usedBlocks(S, m) + ownBlocks(S, r, m) + (r.shared && !isWarm(S, m, r.family) ? Math.ceil(S.L.sharedTokens / BLOCK) : 0) > capBlocks(m)) reason = 'tank';
    if (reason) {
      r.bounced++; m.bounces++; S.bounces++;
      S.fx.push({ kind: 'bounce', id: r.id, machine: m.id, reason });
      return { ok: false, reason };
    }
    S.queue.splice(S.queue.indexOf(r), 1);
    r.phase = 'pending'; r.machine = m.id; r.tPlaced = S.t;
    m.pending.push(r);
    if (m.mode === 'static' && m.batchOpenAt == null) m.batchOpenAt = S.t;
    S.fx.push({ kind: 'placed', id: r.id, machine: m.id });
    return { ok: true };
  }

  // Zap: shed a waiting request. Costs no timeout, but halves the combo and earns nothing.
  function shed(S, reqId) {
    const i = S.queue.findIndex(x => x.id === reqId && x.phase === 'lane');
    if (i < 0) return false;
    const r = S.queue.splice(i, 1)[0];
    r.phase = 'shed'; S.shed++; S.combo = Math.floor(S.combo / 2);
    S.fx.push({ kind: 'shed', id: r.id });
    return true;
  }

  function setRails(S, machineId, n) {
    const m = S.machines[machineId];
    if (!m || !S.L.levers.includes('rails')) return false;
    m.rails = Math.max(1, Math.min(S.L.railsMax, n));
    S.fx.push({ kind: 'rails', machine: m.id, rails: m.rails });
    return true;
  }
  function setMode(S, machineId, mode) {
    const m = S.machines[machineId];
    if (!m || !S.L.levers.includes('mode') || !S.modeUnlocked) return false;
    m.mode = mode; if (mode === 'continuous') m.batchOpenAt = null;
    S.fx.push({ kind: 'mode', machine: m.id, mode });
    return true;
  }

  // ---------- the scheduler loop on one GPU ----------
  function machineStep(S, m) {
    const T = GPU[m.type];
    let prefillTok = 0, admitted = 0;
    const canAdmit = m.mode === 'continuous'
      || (m.run.length === 0 && m.pending.length && (m.pending.length >= m.rails || S.t - m.batchOpenAt >= BATCH_WINDOW));
    if (canAdmit) {
      while (m.pending.length && m.run.length < m.rails) {
        const r = m.pending.shift();
        const warm = r.shared && isWarm(S, m, r.family);
        prefillTok += (warm ? r.own : r.prompt);
        if (r.shared) m.warm[r.family] = S.t;
        r.phase = 'run'; r.cold = r.shared && !warm; m.run.push(r); admitted++;
        S.fx.push({ kind: 'admit', id: r.id, machine: m.id, cold: r.cold, prefill: (warm ? r.own : r.prompt) / T.prefill });
      }
      if (m.mode === 'static') m.batchOpenAt = null;
    }
    const n = m.run.length;
    if (!n) {
      m.t = S.t; m.stepT = S.t; m.stepDur = T.base; m.last = null;
      return;
    }
    const base = T.base, seq = T.per * n, pre = prefillTok / T.prefill;
    const dt = base + seq + pre;
    m.stepT = m.t; m.stepDur = dt; m.t += dt; m.step++;
    const last = { n, base, seq, pre, dt, admitted, prefillTok, finished: 0 };
    for (let i = n - 1; i >= 0; i--) {
      const r = m.run[i];
      if (r.tFirst === null) { r.tFirst = m.t; S.fx.push({ kind: 'first', id: r.id, machine: m.id, ttft: r.tFirst - r.t0 }); }
      r.gen++;
      if (r.gen >= r.out) { m.run.splice(i, 1); finish(S, r, m); last.finished++; }
    }
    m.tok += n; S.goodput += n;
    S.fx.push({ kind: 'tokens', machine: m.id, n, dt });
    // KV pressure: preempt the newest sequence back to the lane when blocks run out.
    while (usedBlocks(S, m) > capBlocks(m) && m.run.length > 1) {
      const r = m.run.pop();
      r.phase = 'lane'; r.machine = null; r.preempts++; r.gen = 0; r.tFirst = null; S.preempted++;
      S.queue.unshift(r);
      S.fx.push({ kind: 'preempt', id: r.id, machine: m.id });
    }
    m.last = last;
  }

  function finish(S, r, m) {
    r.phase = 'done'; r.tDone = m.t;
    const ttft = r.tFirst - r.t0, tpot = (m.t - r.tFirst) / Math.max(1, r.out - 1);
    const slo = S.L.slo;
    const ok = ttft <= slo.ttft && (!slo.tpot || tpot <= slo.tpot);
    S.delivered++;
    if (ok) { S.inSlo++; S.combo++; S.bestCombo = Math.max(S.bestCombo, S.combo); } else S.combo = 0;
    const mult = ok ? Math.min(3, 1 + 0.25 * Math.floor(S.combo / 5)) : 0.5;
    const coins = r.out * COIN_PER_TOKEN * mult;
    S.coins += coins; S.score += Math.round(r.out * mult * (ok ? 1 : 0.5));
    S.recent.push({ t: S.t, ok });
    S.fx.push({ kind: 'done', id: r.id, machine: m.id, ok, coins, mult, ttft, tpot, family: r.family });
  }

  // ---------- the world loop ----------
  function step(S, d) {
    if (S.over) return;
    S.t += d;
    const L = S.L;
    S.rush = null;
    for (const e of S.events) {
      if (e.kind !== 'rush') continue;
      if (!e.warned && S.t >= e.at - 15) { e.warned = true; S.fx.push({ kind: 'warn', event: e }); }
      if (S.t >= e.at && S.t < e.at + e.dur) S.rush = e;
    }
    S.rate = L.rate(S.t) * (S.rush ? S.rush.mult : 1);
    while (S.nextArr <= S.t) { spawn(S); S.nextArr += expo(S.rate); }
    for (let i = S.queue.length - 1; i >= 0; i--) {
      const r = S.queue[i];
      if (r.phase === 'lane' && S.t - r.t0 > L.patience) {
        S.queue.splice(i, 1); r.phase = 'timeout'; S.timeouts++; S.combo = 0;
        S.recent.push({ t: S.t, ok: false });
        S.fx.push({ kind: 'timeout', id: r.id });
      }
    }
    if (!S.modeUnlocked && (S.t >= L.modeUnlockAt || S.bounces >= 3)) { S.modeUnlocked = true; S.fx.push({ kind: 'unlock', lever: 'mode' }); }
    // Event-driven: always advance the machine whose clock is furthest behind.
    for (let guard = 0; guard < 20000; guard++) {
      let m = null;
      for (const x of S.machines) if (x.t < S.t && (!m || x.t < m.t)) m = x;
      if (!m) break;
      machineStep(S, m);
    }
    if ((S.acc += d) >= 0.5) {
      for (const m of S.machines) { m.tokRate = m.tok / S.acc; m.tok = 0; }
      S.acc = 0;
      S.recent = S.recent.filter(x => S.t - x.t <= 10);
    }
    checkEnd(S);
  }

  const sloPct = S => S.delivered + S.timeouts ? S.inSlo / (S.delivered + S.timeouts) : 1;
  function checkEnd(S) {
    const G = S.L.goal;
    if (S.timeouts > G.maxTimeouts) return end(S, false, 'Too many customers timed out.');
    if (G.deliver != null && S.delivered >= G.deliver) {
      if (G.sloMin != null && sloPct(S) < G.sloMin) return end(S, false, `Only ${Math.round(sloPct(S) * 100)}% were on time (needed ${Math.round(G.sloMin * 100)}%).`);
      return end(S, true);
    }
    if (S.t >= G.timeLimit) return end(S, false, "Time's up.");
  }
  function end(S, win, why) {
    if (S.over) return;
    S.over = true; S.win = win; S.why = why || '';
    S.fx.push({ kind: 'end', win });
  }
  function stars(S) {
    if (!S.win) return 0;
    const p = sloPct(S);
    return 1 + (p >= S.L.stars[0]) + (p >= S.L.stars[1]);
  }

  // Rough requests/s one machine sustains at its current rails (for coach and bots).
  function capacity(S, m) {
    const L = S.L, T = GPU[m.type];
    const out = (L.out[0] + L.out[1]) / 2, own = (L.prompt[0] + L.prompt[1]) / 2;
    const stepDur = T.base + T.per * m.rails;
    const per = out * stepDur / m.rails + own / T.prefill;
    return (m.mode === 'static' ? 0.55 : 1) / per;
  }

  // The state schema shared with replay and the live bridge (PLAN.md).
  function snapshot(S) {
    return {
      t: S.t, source: 'sim', load: { rps: S.rate },
      replicas: S.machines.map(m => ({
        id: `${m.type.toLowerCase()}-${m.id}`, gpu: m.type, phase: 'ready', max_num_seqs: m.rails,
        running: m.run.length, waiting: m.pending.length,
        kv_used_pct: usedBlocks(S, m) / capBlocks(m), kv_blocks_total: capBlocks(m),
        step_ms: m.stepDur * 1000, gen_tok_s: m.tokRate, usd_per_h: GPU[m.type].usd,
      })),
      requests: S.queue.map(r => ({ id: r.id, phase: 'queued', prompt_tokens: r.prompt, gen_tokens: 0, t0: r.t0 }))
        .concat(S.machines.flatMap(m => m.run.map(r => ({ id: r.id, phase: r.tFirst === null ? 'prefill' : 'decode', replica: m.id, prompt_tokens: r.prompt, gen_tokens: r.gen, t0: r.t0, t_first: r.tFirst })))),
    };
  }

  return { GPU, LEVELS, BLOCK, FAMILY_NAMES, PREFIX_TTL, BATCH_WINDOW, create, step, place, shed, setRails, setMode,
           capacity, stars, sloPct, snapshot, usedBlocks, capBlocks, isWarm };
});
