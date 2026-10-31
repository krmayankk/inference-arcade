// Bot driver for game/index.html?bot=1[&lvl=N][&x=1][&probe=ms]. Starts a level, lets a simple
// dispatcher play, and (for headless screenshots, where requestAnimationFrame is throttled) drives
// the PixiJS ticker itself. See sim/headless/shoot.sh.
(function () {
  const q = new URLSearchParams(location.search);
  const lvl = +(q.get('lvl') || 0), xr = q.get('x') === '1';
  window.__err = null;
  if (q.has('trace')) PIXI.settings.RENDER_OPTIONS.preserveDrawingBuffer = true;
  window.onerror = (m, src, line) => { window.__err = window.__err || (m + ' @' + line); };
  setTimeout(() => {
    TW.openIntro(lvl); TW.play();
    if (xr) document.querySelector('#xray').click();
    if (lvl === 0) Sim.setRails(TW.S, 0, 6);
    setInterval(() => { try { TW.app.ticker.update(performance.now()); } catch (e) { window.__err = window.__err || e.message; } }, 40);
    setInterval(() => {
      const S = TW.S; if (!S || S.over) return;
      const free = m => m.rails - m.run.length - m.pending.length;
      for (const r of S.queue) if (r.phase === 'lane' && S.t - r.t0 > 1.2 && Math.random() < 0.5) {
        const m = S.machines.find(x => r.shared && Sim.isWarm(S, x, r.family) && free(x) > 0) || S.machines.slice().sort((a, b) => free(b) - free(a))[0];
        Sim.place(S, r.id, m.id);
      }
    }, 250);
  }, 1500);
  if (q.has('trace')) {
    // Sample the first machine's left border every 250 ms: 1 = drawn, 0 = blank. Reported in the title.
    const trace = []; const cv2 = document.createElement('canvas'); cv2.width = cv2.height = 4; const c2 = cv2.getContext('2d');
    const iv = setInterval(() => {
      const S = TW.S; if (!S) return;
      const app = TW.app, W = app.screen.width, H = app.screen.height, n = S.machines.length;
      const mH = Math.min(460, (H - 24 - 12 * (n - 1)) / n), mY = (H - (n * mH + (n - 1) * 12)) / 2;
      // sample the top of the first machine's wheel ring (bright when drawn; the floor grid never lands there)
      const wr = Math.min(mH * 0.28, 58), x = Math.round(W * 0.47 + 18 + wr), y = Math.round(mY + mH / 2 + 6 - wr);
      c2.drawImage(app.view, x * app.renderer.resolution, y * app.renderer.resolution, 2, 2, 0, 0, 2, 2);
      const d = c2.getImageData(0, 0, 1, 1).data;
      const gl = app.renderer.gl, ge = gl ? gl.getError() : -1;
      trace.push((d[0] + d[1] + d[2] > 160 ? '1' : '0') + ':' + S.t.toFixed(1) + '/' + S.delivered + '/' + vis_count() + (ge ? '/gl' + ge : ''));
      if (trace.length >= 64) { clearInterval(iv); document.title = 'TRACE ' + trace.join(' '); }
    }, 250);
    function vis_count() { return S_floats(); }
    function S_floats() { return TW.pools ? TW.pools.floats.filter(f => f.busy).length : -1; }
  }
  if (q.has('grab')) setTimeout(() => {
    // Read the WebGL canvas directly (needs trace=1 for preserveDrawingBuffer) and park it in the DOM for dump-dom.
    const el = document.createElement('div'); el.id = 'grab'; el.textContent = TW.app.view.toDataURL('image/png'); document.body.appendChild(el);
  }, +q.get('grab'));
  if (q.has('probe')) setTimeout(() => { const S = TW.S; document.title = `PROBE err=${window.__err} t=${S.t.toFixed(1)} delivered=${S.delivered} screen=${TW.app.screen.width}x${TW.app.screen.height}`; }, +q.get('probe'));
})();
