// Tokenworks renderer and input. Reads Sim state, drains S.fx for effects, and turns pointer /
// keyboard / touch into Sim.place / Sim.shed / Sim.setRails / Sim.setMode.
//
// The verb: a cannon sits on the cliff at the end of the request lane. The most urgent capsule loads
// itself; the player aims at a rail (a horizontal track on a machine) and shoots. Hitting a track
// seats the request on it (Sim.place); a full or locked track bounces it back into the lane.
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FAMILY = [0x4cc3ff, 0xff7ab8, 0xa6e35a, 0xffcf5a];
  const C = { panel: 0x13213a, panel2: 0x182a48, line: 0x2a4470, fg: 0xe3ecff, muted: 0x8ea3c9, accent: 0xff9a5c, gold: 0xffd166, good: 0x4ade80, bad: 0xff6b6b, cool: 0x6cc4ff };
  const ROWS = 7, MAX_ANGLE = 80 * Math.PI / 180, SHOT_SPEED = 1100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let S = null, levelIdx = 0, eng = false, paused = false, readyT = 0, slow = false;
  try { slow = localStorage.getItem('tokenworks-slow') === '1'; } catch (e) {}
  let best = {};
  try { best = JSON.parse(localStorage.getItem('tokenworks-best') || '{}'); } catch (e) {}

  // ---------- PIXI ----------
  const host = $('#stage');
  // Keep every Graphics on the batched path (above 100 points PixiJS 7 switches to per-object direct
  // rendering; many small Graphics batch faster and it avoided blank frames in headless renders).
  PIXI.GraphicsGeometry.BATCHABLE_SIZE = 4096;
  const app = new PIXI.Application({ resizeTo: host, backgroundAlpha: 0, antialias: true, resolution: Math.min(2, devicePixelRatio || 1), autoDensity: true });
  host.appendChild(app.view);
  app.stage.eventMode = 'static';
  const world = new PIXI.Container();            // shaken on explosions
  app.stage.addChild(world);
  const L = { bg: new PIXI.Graphics(), lane: new PIXI.Container(), machines: new PIXI.Container(), aim: new PIXI.Graphics(), capsules: new PIXI.Container(), fx: new PIXI.Container(), cannon: new PIXI.Graphics(), text: new PIXI.Container() };
  for (const k of ['bg', 'lane', 'machines', 'aim', 'capsules', 'fx', 'cannon', 'text']) world.addChild(L[k]);
  const dotTex = (() => { const g = new PIXI.Graphics(); g.beginFill(0xffffff); g.drawCircle(0, 0, 3); g.endFill(); return app.renderer.generateTexture(g); })();
  const particles = new PIXI.ParticleContainer(2000, { position: true, alpha: true, scale: true, tint: true });
  L.fx.addChild(particles);
  // Pools. Nothing below is created or destroyed per event: destroying a PixiJS Text destroys its
  // texture, and a batch that still references it draws nothing for a frame.
  const tokens = [];                                // {sp, vx, vy, life, busy}
  const bursts = [];                                // {sp, vx, vy, life, t, busy}
  const floats = [];                                // {t, life, age, busy}
  const take = (pool, make, max) => { let o = pool.find(o => !o.busy); if (!o) { if (pool.length >= max) return null; o = make(); pool.push(o); } o.busy = true; return o; };

  const font = (size, weight = 800, fill = C.fg) => new PIXI.TextStyle({ fontFamily: 'Nunito, system-ui, sans-serif', fontSize: size, fontWeight: String(weight), fill });
  const mono = (size, fill = C.muted) => new PIXI.TextStyle({ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: size, fontWeight: '600', fill });

  // ---------- layout ----------
  const G = {};                                      // geometry, recomputed on resize
  const cannon = { x: 0, y: 0 };
  function layout() {
    const W = app.screen.width, H = app.screen.height;
    G.W = W; G.H = H;
    G.laneX0 = -24; G.laneX1 = W * 0.30; G.laneTop = 56; G.laneBot = H - 36;
    G.rows = Math.max(3, Math.min(ROWS, Math.floor((G.laneBot - G.laneTop) / 44)));
    cannon.x = G.laneX1 + 30; cannon.y = H / 2;
    G.mX = W * 0.50; G.mW = W - G.mX - 12;
    const n = S ? S.machines.length : 1, gap = 12;
    G.mH = Math.min(460, (H - 24 - gap * (n - 1)) / n);
    const block = n * G.mH + (n - 1) * gap;
    G.mY = i => (H - block) / 2 + i * (G.mH + gap);
    drawBg();
  }
  function drawBg() {
    const g = L.bg; g.clear();
    g.beginFill(0x0f1b30); g.drawRect(0, 0, G.W, G.H); g.endFill();
    g.lineStyle(1, C.line, 0.25);
    for (let x = 0; x < G.W; x += 24) { g.moveTo(x, 0); g.lineTo(x, G.H); }
    for (let y = 0; y < G.H; y += 24) { g.moveTo(0, y); g.lineTo(G.W, y); }
    // the lane: a conveyor band that ends at a cliff
    g.lineStyle(0); g.beginFill(C.panel, 0.55); g.drawRoundedRect(0, G.laneTop - 14, G.laneX1 + 10, G.laneBot - G.laneTop + 28, 14); g.endFill();
    g.lineStyle(3, C.bad, 0.55); g.moveTo(G.laneX1 + 6, G.laneTop - 8); g.lineTo(G.laneX1 + 6, G.laneBot + 8);
    // the cannon's platform on the cliff
    g.lineStyle(2, C.line, 0.9); g.beginFill(C.panel2); g.drawRoundedRect(cannon.x - 22, cannon.y - 34, 30, 68, 10); g.endFill();
  }
  app.renderer.on('resize', () => { layout(); rebuildMachines(); });

  // ---------- capsules ----------
  const vis = new Map();                             // req.id -> visual
  function reqById(id) {
    for (const r of S.queue) if (r.id === id) return r;
    for (const m of S.machines) for (const r of m.run.concat(m.pending)) if (r.id === id) return r;
    return null;
  }
  function ribbonLen(r) { return Math.min(72, 6 + r.prompt / 240); }
  function makeCapsule(r) {
    const c = new PIXI.Container();
    const ribbon = new PIXI.Graphics(); const body = new PIXI.Graphics(); const ring = new PIXI.Graphics();
    c.addChild(ribbon, ring, body);
    const col = FAMILY[r.family % FAMILY.length];
    ribbon.lineStyle(4, col, 0.5); ribbon.moveTo(-10, 0); ribbon.lineTo(-10 - ribbonLen(r), 0);
    if (r.shared) { ribbon.lineStyle(2, C.gold, 0.9); ribbon.moveTo(-14, -4); ribbon.lineTo(-10 - ribbonLen(r) * 0.75, -4); }
    body.beginFill(col); body.drawCircle(0, 0, 11); body.endFill();
    body.beginFill(0x0f1b30, 0.55); body.drawCircle(-3, -3, 3); body.endFill();
    // states: lane (drifting), loaded (in the cannon), shot (in flight), flying (tweening), gone
    const v = { id: r.id, c, ring, body, ribbon, row: r.id % G.rows, x: G.laneX0, y: 0, state: 'lane', tween: null, shot: null };
    v.y = G.laneTop + (v.row + 0.5) * ((G.laneBot - G.laneTop) / G.rows) + ((r.id * 7) % 9 - 4);
    c.x = v.x; c.y = v.y;
    L.capsules.addChild(c);
    vis.set(r.id, v);
    return v;
  }
  function removeCapsule(id) { const v = vis.get(id); if (!v) return; L.capsules.removeChild(v.c); v.c.destroy({ children: true }); vis.delete(id); if (loaded === id) loaded = null; }
  function laneX(r) { return G.laneX0 + (G.laneX1 - G.laneX0) * Math.min(1, (S.t - r.t0) / S.L.patience); }
  function drawRing(v, r) {
    const p = 1 - Math.min(1, (S.t - r.t0) / S.L.patience);
    const g = v.ring; g.clear();
    g.lineStyle(3, p > 0.5 ? C.good : p > 0.25 ? C.gold : C.bad, 0.95);
    g.arc(0, 0, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    if (r.bounced && S.t - (v.bounceT || -9) < 1.2) { g.lineStyle(2, C.bad, 0.8); g.drawCircle(0, 0, 19); }
  }
  function backToLane(v, r) {
    v.state = 'flying'; v.shot = null;
    v.tween = { x0: v.c.x, y0: v.c.y, x1: laneX(r), y1: v.y, t: 0, dur: 0.3, then: () => { v.state = 'lane'; } };
  }

  // ---------- machines ----------
  const mv = [];                                     // machine visuals
  function rebuildMachines() {
    L.machines.removeChildren().forEach(c => c.destroy({ children: true }));   // L.text holds the pooled floats: never destroyed
    mv.length = 0;
    if (!S) return;
    S.machines.forEach((m, i) => {
      const c = new PIXI.Container();
      const panel = new PIXI.Graphics(), wheel = new PIXI.Graphics(), rails = new PIXI.Graphics(), tank = new PIXI.Graphics(), reader = new PIXI.Graphics();
      const title = new PIXI.Text('', font(16)); const sub = new PIXI.Text('', mono(11)); const stat = new PIXI.Text('', mono(11)); const wheelLbl = new PIXI.Text('', mono(10)); const tankLbl = new PIXI.Text('', mono(10)); const railsLbl = new PIXI.Text('', mono(10));
      c.addChild(panel, reader, wheel, rails, tank, title, sub, stat, wheelLbl, tankLbl, railsLbl);
      L.machines.addChild(c);
      mv.push({ m, c, panel, wheel, rails, tank, reader, title, sub, stat, wheelLbl, tankLbl, railsLbl, railLbls: [], glow: 0, slot: new Map() });
    });
  }
  function machineGeom(i) {
    const x = G.mX, y = G.mY(i), w = G.mW, h = G.mH;
    const wr = Math.min(h * 0.28, 58, w * 0.14);
    const railsX = x + 32 + wr * 2 + 44;              // room for the "rail n" label left of each gate
    return { x, y, w, h, wheel: { x: x + 18 + wr, y: y + h / 2 + 6, r: wr }, railsX, railsY: y + 44, railsW: w - (railsX - x) - 14, railsH: h - 44 - 40, tankY: y + h - 24 };
  }
  // rail k of machine i is a horizontal track; requests ride it left to right as their reply is written
  function railGeom(i, k) {
    const g = machineGeom(i), n = Math.max(S.machines[i].rails, 1), rh = Math.min(44, g.railsH / n), top = g.railsY + (g.railsH - n * rh) / 2;
    return { y: top + (k + 0.5) * rh, x0: g.railsX + 10, x1: g.x + g.w - 18, rh, top, th: Math.min(14, rh * 0.55) };
  }
  function railAt(i, y) { const n = S.machines[i].rails, r0 = railGeom(i, 0); return clamp(Math.floor((y - r0.top) / r0.rh), 0, n - 1); }
  // Which rail a request sits on is a renderer choice (the sim only counts rails). Keep it stable.
  function syncSlots(M) {
    const m = M.m, seqs = m.run.concat(m.pending), present = new Set(seqs.map(r => r.id));
    for (const [id, k] of M.slot) if (!present.has(id) || k >= m.rails) M.slot.delete(id);
    for (const r of seqs) if (!M.slot.has(r.id)) assignSlot(M, r.id, 0);
  }
  function assignSlot(M, id, want) {
    const used = new Set(M.slot.values()), n = M.m.rails;
    let bk = -1, bd = 1e9;
    for (let k = 0; k < n; k++) if (!used.has(k) && Math.abs(k - want) < bd) { bd = Math.abs(k - want); bk = k; }
    if (bk < 0) bk = 0;
    M.slot.set(id, bk);
    return bk;
  }
  function drawMachine(i, dt) {
    const M = mv[i], m = M.m, g = machineGeom(i);
    syncSlots(M);
    const aimed = aim.hit && aim.hit.mi === i;
    M.panel.clear();
    M.panel.beginFill(C.panel); M.panel.lineStyle(aimed ? 3 : 2, aimed ? C.cool : C.line); M.panel.drawRoundedRect(g.x, g.y, g.w, g.h, 14); M.panel.endFill();
    if (m.mode === 'static' && m.run.length) { M.panel.lineStyle(2, C.bad, 0.5); M.panel.drawRoundedRect(g.x + 3, g.y + 3, g.w - 6, g.h - 6, 12); }
    M.title.x = g.x + 14; M.title.y = g.y + 8;
    M.sub.x = g.x + 14; M.sub.y = g.y + 30;
    const step = m.last ? m.last.dt : Sim.GPU[m.type].base;
    const labels = (M.lblAcc = (M.lblAcc || 0) + dt) > 0.1 || !M.lblInit;
    if (labels) {
      M.lblAcc = 0; M.lblInit = true;
      M.title.text = eng ? `${m.type} #${m.id}` : `Machine ${m.id + 1}`;
      M.sub.text = eng ? `${(step * 1000).toFixed(1)} ms/step · ${m.run.length}/${m.rails} seqs · ${m.mode}` : `${(step * 1000).toFixed(0)} ms per turn · ${m.run.length} of ${m.rails} rails busy · ${m.mode === 'static' ? 'batch lock' : 'keeps moving'}`;
      const subFill = m.mode === 'static' ? '#ff6b6b' : '#8ea3c9';
      if (M.subFill !== subFill) { M.subFill = subFill; M.sub.style.fill = subFill; }
      M.railsLbl.text = eng ? `max_num_seqs = ${m.rails}  (one track per sequence)` : `${m.rails} rails · each track carries one request`;
    }

    // wheel: rotates once per step. phase from the machine's own clock.
    const ph = m.run.length ? Math.min(1, (S.t - m.stepT) / Math.max(1e-3, m.stepDur)) : (S.t * 0.15) % 1;
    const wg = M.wheel; wg.clear();
    const busy = m.run.length > 0;
    M.glow = Math.max(0, M.glow - dt * 3);
    wg.beginFill(busy ? C.panel2 : C.panel, 1); wg.lineStyle(3, busy ? C.accent : C.line, 1); wg.drawCircle(g.wheel.x, g.wheel.y, g.wheel.r); wg.endFill();
    wg.lineStyle(2, busy ? C.accent : C.line, busy ? 0.9 : 0.5);
    for (let s = 0; s < 8; s++) {
      const a = ph * Math.PI * 2 + s * Math.PI / 4;
      wg.moveTo(g.wheel.x + Math.cos(a) * g.wheel.r * 0.25, g.wheel.y + Math.sin(a) * g.wheel.r * 0.25);
      wg.lineTo(g.wheel.x + Math.cos(a) * g.wheel.r * 0.92, g.wheel.y + Math.sin(a) * g.wheel.r * 0.92);
    }
    // the stamp: a bright arc at the top that pulses when a step completes
    if (M.glow > 0) { wg.lineStyle(5, C.gold, M.glow); wg.arc(g.wheel.x, g.wheel.y, g.wheel.r + 5, -Math.PI * 0.75, -Math.PI * 0.25); }
    // reader stall: a cool ring segment filling while prefill eats the step
    const rg = M.reader; rg.clear();
    const reading = m.last && m.last.pre > 0.01 && ph < m.last.pre / m.last.dt;
    if (reading) { rg.lineStyle(6, C.cool, 0.9); rg.arc(g.wheel.x, g.wheel.y, g.wheel.r + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (ph / (m.last.pre / m.last.dt))); }
    if (labels) {
      M.wheelLbl.text = reading ? (eng ? `prefill ${(m.last.pre * 1000).toFixed(0)} ms` : 'reading…') : (eng ? 'decode' : busy ? 'stamping' : 'idle');
      const wf = reading ? '#6cc4ff' : '#8ea3c9';
      if (M.wheelFill !== wf) { M.wheelFill = wf; M.wheelLbl.style.fill = wf; }
    }
    M.wheelLbl.x = g.wheel.x - M.wheelLbl.width / 2; M.wheelLbl.y = g.wheel.y + g.wheel.r + 12;

    // rails: horizontal tracks. A seated request rides from the gate (left) to the chute (right).
    const rl = M.rails; rl.clear();
    const bySlot = new Map(); for (const r of m.run.concat(m.pending)) bySlot.set(M.slot.get(r.id), r);
    const locked = m.mode === 'static' && m.run.length > 0;
    while (M.railLbls.length < m.rails) { const t = new PIXI.Text('', mono(10)); t.anchor.set(1, 0.5); M.c.addChild(t); M.railLbls.push(t); }
    for (let k = 0; k < M.railLbls.length; k++) {
      const t = M.railLbls[k]; t.visible = k < m.rails;
      if (t.visible) { const rk = railGeom(i, k); t.x = rk.x0 - 8; t.y = rk.y; if (labels || !t.text) t.text = (eng ? 'slot ' : 'rail ') + (k + 1); }
    }
    for (let k = 0; k < m.rails; k++) {
      const rk = railGeom(i, k), r = bySlot.get(k), hot = aimed && aim.hit.k === k;
      const rad = clamp(rk.th * 0.75, 5, 10);
      if (hot) { rl.lineStyle(rk.th + 6, C.cool, 0.22); rl.moveTo(rk.x0 - 4, rk.y); rl.lineTo(rk.x1 + 4, rk.y); }
      rl.lineStyle(rk.th, C.panel2, 1); rl.moveTo(rk.x0, rk.y); rl.lineTo(rk.x1, rk.y);
      rl.lineStyle(1, C.line, 0.9); rl.moveTo(rk.x0, rk.y); rl.lineTo(rk.x1, rk.y);
      if (r) {
        const col = FAMILY[r.family % FAMILY.length], pend = r.phase === 'pending';
        const prog = pend ? 0 : Math.min(1, r.gen / r.out);
        const cx = rk.x0 + 12 + (rk.x1 - rk.x0 - 26) * prog;
        if (prog > 0) { rl.lineStyle(rk.th - 2, col, 0.35); rl.moveTo(rk.x0 + 6, rk.y); rl.lineTo(cx, rk.y); }   // the reply written so far
        rl.lineStyle(0); rl.beginFill(col, pend ? 0.45 : 1); rl.drawCircle(cx, rk.y, rad); rl.endFill();
        if (r.cold && r.tFirst === null) { rl.lineStyle(2, C.cool, 0.9); rl.drawCircle(cx, rk.y, rad + 4); }
      } else {
        // empty track: an open gate, or a locked one
        if (locked) { rl.lineStyle(2, C.bad, 0.8); rl.moveTo(rk.x0 + 4, rk.y - rad * 0.7); rl.lineTo(rk.x0 + 4 + rad * 1.4, rk.y + rad * 0.7); rl.moveTo(rk.x0 + 4 + rad * 1.4, rk.y - rad * 0.7); rl.lineTo(rk.x0 + 4, rk.y + rad * 0.7); }
        else { rl.lineStyle(2, hot ? C.cool : C.good, hot ? 1 : 0.7); rl.drawCircle(rk.x0 + 10, rk.y, rad * 0.8); }
      }
    }
    // tank
    const tg = M.tank; tg.clear();
    const tx = g.x + 14, tw = g.w - 28, ty = g.tankY, th = 12;
    tg.beginFill(C.panel2); tg.drawRoundedRect(tx, ty, tw, th, 6); tg.endFill();
    const cap = Sim.capBlocks(m);
    let pos = 0;
    const paint = (blocks, col, alpha = 1) => { const w = tw * blocks / cap; tg.beginFill(col, alpha); tg.drawRect(tx + pos, ty + 1, Math.max(1, w), th - 2); tg.endFill(); pos += w; };
    for (const f in m.warm) if (Sim.isWarm(S, m, +f)) paint(Math.ceil(S.L.sharedTokens / Sim.BLOCK), C.gold, 0.9);
    for (const r of m.run.concat(m.pending)) paint(Math.ceil(((r.shared && m.warm[r.family]) ? r.own : r.prompt) / Sim.BLOCK + r.gen / Sim.BLOCK), FAMILY[r.family % FAMILY.length], r.phase === 'pending' ? 0.4 : 1);
    const used = Sim.usedBlocks(S, m) / cap;
    if (used > 0.9) { tg.lineStyle(2, C.bad); tg.drawRoundedRect(tx, ty, tw, th, 6); }
    if (labels) {
      M.tankLbl.text = (eng ? 'KV cache ' : 'tank ') + Math.round(used * 100) + '%';
      M.stat.text = eng ? `${Math.round(m.tokRate)} tok/s` : `${Math.round(m.tokRate)} tokens/s`;
    }
    M.tankLbl.x = tx; M.tankLbl.y = ty - 13;
    M.railsLbl.x = tx + tw - M.railsLbl.width; M.railsLbl.y = ty - 13;
    M.stat.x = g.x + g.w - M.stat.width - 14; M.stat.y = g.y + 8;
  }

  // ---------- cannon and aiming ----------
  let loaded = null;                                 // req id sitting in the cannon
  const aim = { angle: 0, hit: null, end: null, usePointer: false };
  const pointer = { x: 0, y: 0 };
  function computeAim() {
    if (aim.usePointer) aim.angle = clamp(Math.atan2(pointer.y - cannon.y, pointer.x - cannon.x), -MAX_ANGLE, MAX_ANGLE);
    const dx = Math.cos(aim.angle), dy = Math.sin(aim.angle);
    aim.hit = null; aim.end = null;
    let x = cannon.x, y = cannon.y;
    for (let s = 0; s < 600; s++) {
      x += dx * 5; y += dy * 5;
      const mi = machineAt(x, y);
      if (mi >= 0) { aim.hit = { mi, x, y, k: railAt(mi, y) }; return; }
      if (x > G.W || y < 0 || y > G.H) { aim.end = { x, y }; return; }
    }
    aim.end = { x, y };
  }
  function aimAtMachine(mi) {
    // auto-aim (keys 1/2, touch): the first open rail of the machine, or its middle
    const m = S.machines[mi]; if (!m) return false;
    const M = mv[mi], used = new Set(M.slot.values());
    let k = -1; for (let j = 0; j < m.rails; j++) if (!used.has(j)) { k = j; break; }
    const rk = railGeom(mi, k < 0 ? Math.floor(m.rails / 2) : k);
    aim.usePointer = false; aim.angle = clamp(Math.atan2(rk.y - cannon.y, rk.x0 - cannon.x), -MAX_ANGLE, MAX_ANGLE);
    computeAim();
    return true;
  }
  function muzzle() { return { x: cannon.x + Math.cos(aim.angle) * 26, y: cannon.y + Math.sin(aim.angle) * 26 }; }
  function drawCannon() {
    const g = L.cannon; g.clear();
    const mz = muzzle();
    g.lineStyle(12, C.fg, 1); g.moveTo(cannon.x, cannon.y); g.lineTo(mz.x, mz.y);
    g.lineStyle(0); g.beginFill(C.cool); g.drawCircle(cannon.x, cannon.y, 10); g.endFill();
    g.beginFill(0x0f1b30); g.drawCircle(cannon.x, cannon.y, 4); g.endFill();
    const a = L.aim; a.clear();
    if (!S || S.over) return;
    const end = aim.hit || aim.end; if (!end) return;
    // dashed aim line
    const dx = end.x - mz.x, dy = end.y - mz.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    a.lineStyle(2, aim.hit ? C.cool : C.bad, aim.hit ? 0.55 : 0.3);
    for (let d = 0; d < len; d += 16) { a.moveTo(mz.x + ux * d, mz.y + uy * d); a.lineTo(mz.x + ux * Math.min(len, d + 9), mz.y + uy * Math.min(len, d + 9)); }
    if (aim.hit) {
      const rk = railGeom(aim.hit.mi, aim.hit.k);
      a.lineStyle(2, C.cool, 0.9); a.drawCircle(rk.x0 + 10, rk.y, 12);
      a.moveTo(rk.x0 - 6, rk.y); a.lineTo(rk.x0 + 2, rk.y); a.moveTo(rk.x0 + 18, rk.y); a.lineTo(rk.x0 + 26, rk.y);
      a.moveTo(rk.x0 + 10, rk.y - 16); a.lineTo(rk.x0 + 10, rk.y - 8); a.moveTo(rk.x0 + 10, rk.y + 8); a.lineTo(rk.x0 + 10, rk.y + 16);
    }
  }

  // ---------- input ----------
  function capsuleAt(x, y) {
    let best = null, bd = 26;
    for (const v of vis.values()) { if (v.state !== 'lane') continue; const d = Math.hypot(v.c.x - x, v.c.y - y); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  function machineAt(x, y) { for (let i = 0; i < mv.length; i++) { const g = machineGeom(i); if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) return i; } return -1; }
  function aimedMachine() { return aim.hit ? aim.hit.mi : 0; }
  function load(v) {
    if (!v || v.id === loaded) return;
    if (loaded != null) { const o = vis.get(loaded); const r = o && reqById(o.id); if (o && r && o.state === 'loaded') backToLane(o, r); }
    loaded = v.id; v.state = 'loaded';
    const mz = muzzle();
    v.tween = { x0: v.c.x, y0: v.c.y, x1: mz.x, y1: mz.y, t: 0, dur: 0.14, then: null };
  }
  function autoLoad() {
    if (loaded != null) return;
    let best = null, bx = -1e9;                      // the most urgent capsule is the one nearest the cliff
    for (const v of vis.values()) if (v.state === 'lane' && v.c.x > bx) { bx = v.c.x; best = v; }
    if (best) load(best);
  }
  function fire() {
    if (loaded == null || !S || S.over || readyT > 0) return;
    const v = vis.get(loaded); if (!v) { loaded = null; return; }
    loaded = null;
    const mz = muzzle();
    v.state = 'shot'; v.tween = null; v.c.x = mz.x; v.c.y = mz.y;
    v.shot = { vx: Math.cos(aim.angle) * SHOT_SPEED, vy: Math.sin(aim.angle) * SHOT_SPEED };
    burst(mz.x, mz.y, C.cool, 5); shake(1.5);
  }
  function land(v, mi) {
    const r = reqById(v.id); if (!r) { removeCapsule(v.id); return; }
    const res = Sim.place(S, v.id, mi);
    const g = machineGeom(mi), M = mv[mi];
    if (res.ok) {
      const k = assignSlot(M, v.id, railAt(mi, v.c.y)), rk = railGeom(mi, k);
      v.state = 'flying'; v.shot = null;
      v.tween = { x0: v.c.x, y0: v.c.y, x1: rk.x0 + 10, y1: rk.y, t: 0, dur: 0.14, then: () => removeCapsule(v.id) };
      burst(rk.x0 + 10, rk.y, FAMILY[r.family % FAMILY.length], 7);
      floatText(eng ? `seq slot ${k + 1}` : `rail ${k + 1}`, rk.x0 + 30, rk.y - 14, C.cool, 11);
    } else if (res.reason === 'gone' || res.reason === 'over') { removeCapsule(v.id); }
    else {
      v.bounceT = S.t;
      floatText(res.reason === 'locked' ? (eng ? 'batch locked' : 'LOCKED') : res.reason === 'rails' ? (eng ? 'max_num_seqs' : 'RAILS FULL') : (eng ? 'KV full' : 'TANK FULL'), g.x - 10, v.c.y - 22, C.bad, 14);
      shake(4);
      backToLane(v, r);
    }
  }
  function miss(v) {
    const r = reqById(v.id); if (!r) { removeCapsule(v.id); return; }
    floatText('MISS', clamp(v.c.x, 40, G.W - 40), clamp(v.c.y, 20, G.H - 20), C.muted, 13);
    backToLane(v, r);
  }
  function zap() {
    if (loaded == null) return;
    const v = vis.get(loaded); if (!v) { loaded = null; return; }
    if (Sim.shed(S, v.id)) { burst(v.c.x, v.c.y, C.cool, 8); floatText(eng ? 'cancelled' : 'zapped', v.c.x, v.c.y - 20, C.cool, 12); removeCapsule(v.id); }
  }
  app.stage.on('pointermove', e => { pointer.x = e.global.x; pointer.y = e.global.y; aim.usePointer = true; });
  app.stage.on('pointerdown', e => {
    if (!S || S.over || paused) return;
    pointer.x = e.global.x; pointer.y = e.global.y; aim.usePointer = true; computeAim();
    if (e.button === 2) { zap(); return; }
    const v = capsuleAt(pointer.x, pointer.y);
    if (v) { load(v); return; }                      // pick a different capsule to load
    fire();
  });
  host.addEventListener('contextmenu', e => e.preventDefault());
  const keys = {};
  addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (!$('#overlay').hidden) return;
    // a focused HUD button would also take Space/Enter as a click (that is how the game used to pause itself)
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    if (k === 'p') { togglePause(); return; }
    if (k === 'x') { eng = !eng; relabel(); return; }
    if (!S || S.over) return;
    if (['w', 's', 'arrowup', 'arrowdown'].includes(k)) { keys[k] = true; aim.usePointer = false; e.preventDefault(); }
    if (k === ' ') { e.preventDefault(); fire(); }
    if (k === '1' || k === '2') { if (aimAtMachine(+k - 1)) fire(); }
    if (k === 'z') zap();
    if (k === '=' || k === '+') lever('rails', aimedMachine(), +1);
    if (k === '-' || k === '_') lever('rails', aimedMachine(), -1);
    if (k === 'c') lever('mode', aimedMachine());
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  // ---------- levers (HUD) ----------
  function lever(kind, mi, d) {
    if (mi < 0 || !S) return;
    const m = S.machines[mi];
    if (kind === 'rails' && Sim.setRails(S, mi, m.rails + d)) floatText((eng ? 'max_num_seqs ' : 'rails ') + m.rails, machineGeom(mi).x + 60, machineGeom(mi).y + 50, C.fg, 13);
    if (kind === 'mode' && Sim.setMode(S, mi, m.mode === 'static' ? 'continuous' : 'static')) floatText(m.mode === 'static' ? (eng ? 'static batching' : 'batch lock ON') : (eng ? 'continuous batching' : 'keeps moving'), machineGeom(mi).x + 60, machineGeom(mi).y + 50, m.mode === 'static' ? C.bad : C.good, 13);
    renderLevers();
  }
  function renderLevers() {
    const box = $('#levers');
    if (!S) { box.innerHTML = ''; return; }
    box.innerHTML = S.machines.map((m, i) => {
      const rails = S.L.levers.includes('rails') ? `<span class="lv"><span>${eng ? 'max_num_seqs' : 'rails'}</span><button class="btn sm" data-lv="rails" data-m="${i}" data-d="-1" aria-label="Fewer rails">−</button><b>${m.rails}</b><button class="btn sm" data-lv="rails" data-m="${i}" data-d="1" aria-label="More rails">+</button></span>` : '';
      const mode = S.L.levers.includes('mode') ? (S.modeUnlocked ? `<button class="btn ${m.mode === 'static' ? 'danger' : 'ok'}" data-lv="mode" data-m="${i}">${eng ? m.mode + ' batching' : (m.mode === 'static' ? 'Batch lock: ON' : 'Keeps moving')}</button>` : `<span class="lv locked">lever locked</span>`) : '';
      return `<div class="machine-lv"><b>${eng ? m.type + ' #' + m.id : 'Machine ' + (i + 1)}</b>${rails}${mode}</div>`;
    }).join('');
  }
  $('#levers').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; lever(b.dataset.lv, +b.dataset.m, +(b.dataset.d || 0)); b.blur(); });

  // ---------- effects ----------
  function shake(px) { if (!RM) shakeAmt = Math.max(shakeAmt, px); }
  let shakeAmt = 0;
  const makeDot = () => { const sp = new PIXI.Sprite(dotTex); sp.anchor.set(0.5); sp.visible = false; particles.addChild(sp); return { sp, busy: false }; };
  function burst(x, y, col, n = 14) {
    if (RM) n = Math.min(n, 4);
    for (let i = 0; i < n; i++) {
      const b = take(bursts, makeDot, 400); if (!b) return;
      const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 180;
      b.sp.x = x; b.sp.y = y; b.sp.tint = col; b.sp.alpha = 1; b.sp.visible = true; b.sp.scale.set(0.7 + Math.random());
      b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp; b.life = 0.6 + Math.random() * 0.3; b.t = 0;
    }
  }
  function floatText(text, x, y, col, size = 14) {
    const f = take(floats, () => { const t = new PIXI.Text('', font(14)); t.anchor.set(0.5); t.visible = false; L.text.addChild(t); return { t, busy: false }; }, 40);
    if (!f) return;
    f.t.text = text; f.t.style = font(size, 800, col); f.t.x = x; f.t.y = y; f.t.alpha = 1; f.t.visible = true; f.life = 1.1; f.age = 0;
  }
  function emitTokens(mi, n) {
    // one spark per rail that got a token this step, off the right end of its track
    const M = mv[mi], m = M.m;
    const ys = m.run.map(r => M.slot.has(r.id) ? railGeom(mi, M.slot.get(r.id)).y : null).filter(y => y != null);
    const count = Math.min(n, 10, Math.max(1, ys.length));
    const x1 = railGeom(mi, 0).x1;
    for (let i = 0; i < count; i++) {
      const t = take(tokens, makeDot, 1500); if (!t) return;
      t.sp.x = x1 + 2; t.sp.y = ys.length ? ys[i % ys.length] : machineGeom(mi).y + machineGeom(mi).h / 2; t.sp.tint = C.gold; t.sp.alpha = 0.95; t.sp.visible = true; t.sp.scale.set(0.7 + Math.random() * 0.5);
      t.vx = 160 + Math.random() * 160; t.vy = (Math.random() - 0.5) * 40; t.life = 0.9;
    }
  }
  function drainFx() {
    for (const f of S.fx) {
      if (f.kind === 'spawn') { const r = reqById(f.id); if (r) makeCapsule(r); }
      else if (f.kind === 'placed') {
        // Placed by something other than the cannon (auto-dispatch, bots): fly the sprite into a rail.
        const v = vis.get(f.id);
        if (v && (v.state === 'lane' || v.state === 'loaded')) {
          const M = mv[f.machine], k = assignSlot(M, f.id, Math.floor(M.m.rails / 2)), rk = railGeom(f.machine, k);
          if (loaded === f.id) loaded = null;
          v.state = 'flying'; v.tween = { x0: v.c.x, y0: v.c.y, x1: rk.x0 + 10, y1: rk.y, t: 0, dur: 0.28, then: () => removeCapsule(f.id) };
        }
      }
      else if (f.kind === 'tokens') { const M = mv[f.machine]; if (M) M.glow = 1; emitTokens(f.machine, f.n); }
      else if (f.kind === 'done') {
        const g = machineGeom(f.machine);
        const x = g.x + g.w - 30, y = g.y + 40 + Math.random() * (g.h - 80);
        burst(x, y, f.ok ? C.gold : C.muted, f.ok ? 10 : 5);
        floatText((f.ok ? '+' : '½ ') + Math.round(f.coins) + (f.mult > 1 ? ` ×${f.mult.toFixed(2)}` : ''), x - 20, y - 16, f.ok ? C.gold : C.muted, f.ok ? 15 : 12);
        if (f.ok && S.combo > 0 && S.combo % 5 === 0) { floatText(`COMBO ${S.combo}`, G.W * 0.42, 40, C.accent, 22); }
        if (!f.ok) floatText(eng ? `late: TTFT ${f.ttft.toFixed(1)} s` : 'late…', x - 20, y + 4, C.bad, 11);
      }
      else if (f.kind === 'timeout') {
        const v = vis.get(f.id); const x = v ? v.c.x : G.laneX1, y = v ? v.c.y : G.H / 2;
        burst(x, y, C.bad, 16); floatText(eng ? 'timeout' : 'GAVE UP', x, y - 22, C.bad, 15); shake(8); removeCapsule(f.id);
      }
      else if (f.kind === 'preempt') {
        const r = reqById(f.id); if (!r) continue;
        const g = machineGeom(f.machine); const v = makeCapsule(r);
        v.state = 'flying'; v.tween = { x0: g.x + 40, y0: g.y + g.h - 30, x1: laneX(r), y1: v.y, t: 0, dur: 0.4, then: () => { v.state = 'lane'; } };
        floatText(eng ? 'preempted (KV)' : 'POPPED OUT', g.x + 60, g.y + g.h - 40, C.bad, 13); shake(4);
      }
      else if (f.kind === 'admit') { if (f.cold) { const g = machineGeom(f.machine); floatText(eng ? `cold prefill ${(f.prefill * 1000).toFixed(0)} ms` : 'cold read!', g.wheel.x, g.wheel.y - g.wheel.r - 16, C.cool, 12); } }
      else if (f.kind === 'warn') { floatText(`${f.event.name} in 15 s!`, G.W * 0.42, 60, C.bad, 20); }
      else if (f.kind === 'unlock') { floatText('NEW LEVER UNLOCKED', G.W * 0.42, 80, C.good, 20); renderLevers(); }
      else if (f.kind === 'end') { showBanner(); }
    }
    S.fx.length = 0;
  }

  // ---------- coach ----------
  let coachKey = '';
  function coach() {
    const L = S.L, waiting = S.queue.filter(r => r.phase === 'lane').length;
    if (L.tutorial) {
      const m = S.machines[0], seated = m.run.length + m.pending.length;
      if (S.delivered + seated === 0) return ['Step 1 · shoot', 'The capsule in your cannon is one request. Point at "rail 1" on the machine and click (or press Space).'];
      if (S.delivered === 0) return ['Step 2 · watch', 'It rides its track while the wheel turns. One turn = one token for every busy track. The sparks on the right are the reply.'];
      if (m.rails < 4 && waiting < 2) return ['Step 3 · more rails', 'Press + under the machine (or the + key) until it has 4 rails. Watch the turn time: it barely changes.'];
      if (m.rails < 4) return ['Step 3 · more rails', 'Capsules are piling up. Add rails with + until there are 4. Each rail is one more request served at once.'];
      if (!eng && S.delivered < 6) return ['Step 4 · X-ray', 'Press X. Every piece turns into its real engine name, and the panel below shows the metrics. Press X again to go back.'];
      if (loaded != null && waiting >= 2) return ['Step 5 · choose', 'You can click any capsule in the lane to load that one instead of the most urgent. Try it.'];
      return ['Training', `${S.delivered} of 10 delivered. Right-click or Z throws a loaded capsule away (sheds it). Level 1 is this with a clock.`];
    }
    const m0 = S.machines[0];
    const rush = S.events.find(e => e.kind === 'rush' && S.t >= e.at - 15 && S.t < e.at);
    const anyFree = S.machines.some(m => m.run.length + m.pending.length < m.rails && !(m.mode === 'static' && m.run.length));
    if (S.t < 8 && S.delivered === 0 && !S.machines.some(m => m.run.length + m.pending.length)) return ['How to play', 'A capsule is loaded in your cannon. Point at a track on the machine and click (or Space) to shoot it onto a rail.'];
    if (L.id === 2 && m0.mode === 'static' && S.modeUnlocked) return ['New lever', 'Flip the batch-lock lever below. Rails will refill the moment one frees up.'];
    if (L.id === 2 && m0.mode === 'static' && S.bounces >= 1) return ['Locked out', 'The batch runs until its slowest sequence finishes. Nothing new can board: the empty tracks show a red ✕ at the gate.'];
    if (L.levers.includes('rails') && waiting >= 3 && S.machines.every(m => m.rails < L.railsMax && m.run.length + m.pending.length >= m.rails)) return ['Rails are full', `Every track is taken. Add rails with + (below, or the + key). Then watch the turn time: it barely moves.`];
    if (L.id === 3 && rush) return [`${rush.name} in ${Math.ceil(rush.at - S.t)} s`, 'Keep both machines fed. Same colour to the same machine, so the reader stays warm. Click a capsule in the lane to load it instead of the urgent one.'];
    if (L.id === 3 && S.machines.some(m => m.run.some(r => r.cold && r.tFirst === null))) return ['Cold read', 'The reader is grinding through a new colour (16k tokens). Send the same colour to the same machine next time: it is almost free when warm.'];
    if (waiting >= 4 && anyFree) return ['Capsules waiting', 'Tracks are open. Shoot fast: rings are running out.'];
    if (waiting >= 4 && !anyFree) return ['Everything full', 'No track free. Zap the loaded capsule (right-click or Z) to shed it instead of letting it time out.'];
    if (S.combo >= 10) return [`Combo ×${(1 + 0.25 * Math.floor(S.combo / 5)).toFixed(2)}`, 'Every on-time reply multiplies the coins. Keep the streak.'];
    return ['Looking good', L.id === 1 ? 'Each request rides its track while the wheel stamps its reply, one token per turn.' : 'Keep the tracks fed and the rings green.'];
  }
  function renderCoach() {
    if (!S) return;
    const [tag, text] = S.over ? ['', ''] : coach();
    const key = tag + text;
    if (key !== coachKey) { coachKey = key; $('#coach-tag').textContent = tag; $('#coach-text').textContent = text; }
  }

  // ---------- HUD ----------
  function renderHud() {
    if (!S) return;
    const L = S.L, G2 = L.goal;
    $('#h-level').textContent = L.endless ? 'Endless' : L.tutorial ? L.name + (slow ? ' · slow motion' : '') : `Level ${L.id} · ${L.name}` + (slow ? ' · slow motion' : '');
    $('#h-goal').textContent = G2.deliver != null ? `${S.delivered} / ${G2.deliver}` : `${S.delivered}`;
    $('#h-goal-l').textContent = eng ? 'completed' : 'delivered';
    const pct = Math.round(Sim.sloPct(S) * 100);
    $('#h-slo').textContent = pct + '%'; $('#h-slo').className = G2.sloMin != null && pct < G2.sloMin * 100 ? 'bad' : '';
    $('#h-slo-l').textContent = eng ? `in SLO (TTFT ≤ ${L.slo.ttft}s)` : 'on time';
    $('#h-to').textContent = L.tutorial ? '—' : `${S.timeouts} / ${G2.maxTimeouts}`; $('#h-to').className = !L.tutorial && S.timeouts >= G2.maxTimeouts - 1 ? 'bad' : '';
    $('#h-time').textContent = L.endless || L.tutorial ? fmt(S.t) : fmt(Math.max(0, G2.timeLimit - S.t));
    $('#h-score').textContent = S.score.toLocaleString();
    const mult = 1 + 0.25 * Math.floor(S.combo / 5);
    $('#h-combo').textContent = mult > 1 ? `×${mult.toFixed(2)}` : '×1';
    $('#h-combo').className = mult > 1 ? 'hot' : '';
    renderCoach();
  }
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function relabel() {
    $('#xray').setAttribute('aria-pressed', String(eng));
    document.documentElement.dataset.eng = eng ? 'on' : 'off';
    renderLevers(); coachKey = ''; renderHud();
    $('#legend').innerHTML = eng
      ? 'wheel = decode step (one forward pass) · track = one sequence slot, max_num_seqs of them · tank = KV cache (16-token blocks) · ribbon = prompt tokens · gold = cached prefix · blue ring = prefill'
      : 'wheel = one turn stamps a token on every busy track · track = a rail, one request rides it while its reply is written · tank = memory for everything cooking · ribbon = how long the request is · gold = already read';
  }

  // ---------- frame ----------
  let last = performance.now(), hudAcc = 0, reported = false;
  app.ticker.add(() => {
    try { frame(); } catch (err) {
      // An exception here would stop the ticker for good (that was the "game freezes" bug). Keep going and say so.
      console.error('Tokenworks frame error', err);
      if (!reported) { reported = true; $('#coach-tag').textContent = 'Bug'; $('#coach-text').textContent = 'A frame error was caught (see console). Playing on. ' + (err && err.message); coachKey = 'err'; }
    }
  });
  function frame() {
    const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!S) return;
    const running = !paused && !S.over && $('#overlay').hidden && readyT <= 0;
    if (readyT > 0 && !paused && $('#overlay').hidden) {
      readyT -= dt; const n = Math.ceil(readyT);
      $('#ready').innerHTML = readyT > 0 ? `<div><b>${n}</b><span>${S.L.tutorial ? 'Capsules come from the left. Your cannon is on the red line.' : 'Shoot capsules onto the tracks before their rings run out. P pauses.'}</span></div>` : '<div><b>GO</b></div>';
      if (readyT <= 0) setTimeout(() => { $('#ready').hidden = true; }, 500);
    }
    if (running) { let rem = dt * (slow ? 0.6 : 1); while (rem > 1e-6) { const d = Math.min(0.02, rem); Sim.step(S, d); rem -= d; } }
    drainFx();
    // aiming
    if (!aim.usePointer) { const sp = 1.6 * dt; if (keys.w || keys.arrowup) aim.angle -= sp; if (keys.s || keys.arrowdown) aim.angle += sp; aim.angle = clamp(aim.angle, -MAX_ANGLE, MAX_ANGLE); }
    computeAim();
    if (running) autoLoad();
    // capsules
    for (const v of vis.values()) {
      const r = reqById(v.id);
      if (!r) { removeCapsule(v.id); continue; }
      if (v.tween) {
        const tw = v.tween; tw.t += dt; const p = Math.min(1, tw.t / tw.dur), e = 1 - Math.pow(1 - p, 3);
        v.c.x = tw.x0 + (tw.x1 - tw.x0) * e; v.c.y = tw.y0 + (tw.y1 - tw.y0) * e;
        if (p >= 1) { v.tween = null; tw.then && tw.then(); }
      } else if (v.state === 'lane') { v.c.x = laneX(r); v.c.y = v.y; }
      else if (v.state === 'loaded') { const mz = muzzle(); v.c.x = mz.x; v.c.y = mz.y; }
      else if (v.state === 'shot' && running) {
        // substep so a fast shot cannot skip over a machine panel
        let rem = dt;
        while (rem > 0 && v.state === 'shot') {
          const d = Math.min(rem, 20 / SHOT_SPEED); rem -= d;
          v.c.x += v.shot.vx * d; v.c.y += v.shot.vy * d;
          const mi = machineAt(v.c.x, v.c.y);
          if (mi >= 0) land(v, mi);
          else if (v.c.x > G.W + 16 || v.c.y < -16 || v.c.y > G.H + 16) miss(v);
        }
      }
      if (vis.has(v.id) && (v.state !== 'flying' || r.phase === 'lane')) drawRing(v, r);
    }
    for (let i = 0; i < mv.length; i++) drawMachine(i, dt);
    drawCannon();
    // particles
    const adv = running ? 1 : 0;
    for (const t of tokens) { if (!t.busy) continue; t.life -= dt * adv; t.sp.x += t.vx * dt * adv; t.sp.y += t.vy * dt * adv; t.sp.alpha = Math.max(0, t.life); if (t.life <= 0 || t.sp.x > G.W + 10) { t.busy = false; t.sp.visible = false; } }
    for (const b of bursts) { if (!b.busy) continue; b.t += dt; b.sp.x += b.vx * dt; b.sp.y += b.vy * dt; b.vy += 300 * dt; b.sp.alpha = Math.max(0, 1 - b.t / b.life); if (b.t >= b.life) { b.busy = false; b.sp.visible = false; } }
    for (const f of floats) { if (!f.busy) continue; f.age += dt; f.t.y -= 28 * dt; f.t.alpha = Math.max(0, 1 - f.age / f.life); if (f.age >= f.life) { f.busy = false; f.t.visible = false; } }
    if (shakeAmt > 0) { world.x = (Math.random() - 0.5) * shakeAmt; world.y = (Math.random() - 0.5) * shakeAmt; shakeAmt = Math.max(0, shakeAmt - dt * 30); } else { world.x = 0; world.y = 0; }
    if ((hudAcc += dt) > 0.1) { hudAcc = 0; renderHud(); }
  }

  // ---------- flow ----------
  function showModal(id) { $('#overlay').hidden = false; for (const m of ['m-menu', 'm-intro', 'm-end']) $('#' + m).hidden = m !== id; const f = $('#' + id).querySelector('button:not([hidden])'); f && f.focus(); }
  function unlocked(i) { const L = Sim.LEVELS[i]; return L.tutorial || i === 0 || L.endless ? (L.tutorial || i === 0 || (best[1] || 0) > 0) : (best[Sim.LEVELS[i - 1].id] || 0) > 0 || (best[L.id] || 0) > 0; }
  function renderMenu() {
    const order = Sim.LEVELS.map((L, i) => i).sort((a, b) => (Sim.LEVELS[b].tutorial ? 1 : 0) - (Sim.LEVELS[a].tutorial ? 1 : 0));   // training first
    $('#levels').innerHTML = order.map(i => { const L = Sim.LEVELS[i]; return `<button class="btn level" data-level="${i}" ${unlocked(i) ? '' : 'disabled'}>
      <small>${L.endless ? 'Endless' : L.tutorial ? 'Start here' : 'Level ' + L.id}</small><span>${L.name}</span>
      <span class="stars">${L.endless ? (best.endless ? 'best ' + best.endless.toLocaleString() : '') : L.tutorial ? (best.T ? 'done' : 'no clock, no timeouts') : '★'.repeat(best[L.id] || 0) + '☆'.repeat(3 - (best[L.id] || 0))}</span></button>`; }).join('');
    $('#resume').hidden = !(S && !S.over);           // a game is waiting behind the menu
    $('#slowmo').checked = slow;
  }
  function openIntro(i) {
    levelIdx = i; const L = Sim.LEVELS[i];
    $('#intro-num').textContent = L.endless ? 'Endless mode' : L.tutorial ? 'Training' : `Level ${L.id} of ${Sim.LEVELS.filter(x => !x.endless && !x.tutorial).length}`;
    $('#intro-title').textContent = L.name; $('#intro-text').textContent = L.brief; $('#intro-goal').textContent = L.goalText;
    showModal('m-intro');
  }
  function play() {
    S = Sim.create(levelIdx); paused = false; loaded = null; reported = false;
    for (const id of [...vis.keys()]) removeCapsule(id);
    for (const pool of [tokens, bursts, floats]) for (const o of pool) { o.busy = false; (o.sp || o.t).visible = false; }
    layout(); rebuildMachines(); renderLevers(); relabel();
    aim.angle = 0; aim.usePointer = false;
    $('#pause').setAttribute('aria-pressed', 'false'); $('#paused').hidden = true;
    $('#banner').hidden = true; readyT = 3; $('#ready').hidden = false; $('#ready').innerHTML = '';
    $('#overlay').hidden = true;
  }
  function endLevel() {
    const L = S.L, n = Sim.stars(S);
    if (L.endless) { if (S.score > (best.endless || 0)) best.endless = S.score; }
    else if (L.tutorial) best.T = 1;
    else if (S.win) best[L.id] = Math.max(best[L.id] || 0, n);
    try { localStorage.setItem('tokenworks-best', JSON.stringify(best)); } catch (e) {}
    $('#end-sub').textContent = L.endless ? `Endless · ${fmt(S.t)}` : `Level ${L.id} · ${L.name}`;
    $('#end-title').textContent = L.endless ? 'Run over' : S.win ? ['Shift done', 'Smooth operator', 'Flawless'][n - 1] : 'Shift over';
    $('#end-stars').innerHTML = L.endless ? `<b>${S.score.toLocaleString()}</b> points` : L.tutorial ? '' : [1, 2, 3].map(i => `<span class="${i <= n ? '' : 'off'}">★</span>`).join('');
    const cells = [['Delivered', S.delivered], ['On time', Math.round(Sim.sloPct(S) * 100) + '%'], ['Timeouts', S.timeouts], ['Best combo', S.bestCombo], ['Coins', Math.round(S.coins)], ['Score', S.score.toLocaleString()]];
    $('#end-res').innerHTML = cells.map(([a, b]) => `<div><small>${a}</small><b>${b}</b></div>`).join('');
    $('#end-why').textContent = S.win ? '' : S.why;
    $('#end-learn').textContent = L.learn;
    $('#end-learn-box').hidden = !L.learn;
    $('#end-next').hidden = !(S.win && !L.tutorial && levelIdx < Sim.LEVELS.length - 1 && !Sim.LEVELS[levelIdx + 1].endless && !Sim.LEVELS[levelIdx + 1].tutorial);
    if (L.tutorial) { $('#end-next').hidden = false; $('#end-next').textContent = 'Level 1'; } else $('#end-next').textContent = 'Next level';
    $('#banner').hidden = true;
    showModal('m-end');
  }
  function showBanner() {
    const L = S.L, n = Sim.stars(S);
    $('#banner').innerHTML = `<span>${L.endless ? 'Run over' : L.tutorial ? 'Training done' : S.win ? 'Shift done' : 'Shift over'}</span>` +
      (L.endless || L.tutorial ? '' : `<span class="stars">${'★'.repeat(n)}${'☆'.repeat(3 - n)}</span>`) +
      `<small>${S.delivered} delivered · ${Math.round(Sim.sloPct(S) * 100)}% on time · score ${S.score.toLocaleString()}${S.win ? '' : S.why ? ' · ' + S.why : ''}</small>` +
      `<button class="btn big" id="results">Results</button>`;
    $('#banner').hidden = false;
    $('#results').focus();
  }
  function togglePause() { if (!S || S.over) return; paused = !paused; $('#pause').setAttribute('aria-pressed', String(paused)); $('#paused').hidden = !paused; }

  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.level != null) openIntro(+b.dataset.level);
    if (b.id === 'go') play();
    if (b.id === 'intro-back' || b.id === 'end-menu' || b.id === 'menu') { if (S && !S.over) { paused = true; } renderMenu(); showModal('m-menu'); }
    if (b.id === 'end-retry') openIntro(levelIdx);
    if (b.id === 'end-next') openIntro(S && S.L.tutorial ? 0 : levelIdx + 1);
    if (b.id === 'results') endLevel();
    if (b.id === 'pause') togglePause();
    if (b.id === 'xray') { eng = !eng; relabel(); }
    if (b.id === 'resume') { $('#overlay').hidden = true; paused = false; $('#pause').setAttribute('aria-pressed', 'false'); $('#paused').hidden = true; }
    if ($('#overlay').hidden) b.blur();              // never leave a HUD button focused: Space must shoot, not click it
  });

  $('#slowmo').addEventListener('change', e => { slow = e.target.checked; try { localStorage.setItem('tokenworks-slow', slow ? '1' : '0'); } catch (x) {} renderHud(); });
  layout(); relabel(); renderMenu(); showModal('m-menu');
  window.TW = { get S() { return S; }, app, play, openIntro, pools: { tokens, bursts, floats }, shoot: mi => { if (loaded == null) autoLoad(); if (loaded != null && aimAtMachine(mi)) { fire(); return true; } return false; } };
})();
