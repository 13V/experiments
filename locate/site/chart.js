/* Locate — price charts, drawn the way the desk's own monitors draw them.
   scene.js paints candles onto its screens with a fixed grammar: a 4-line grid, right-hand price
   labels, 0.64-width candles, a 9-period mean in cyan, volume at 35% alpha along the foot, and a
   dashed last-price line with a filled tag. This is that grammar at DOM scale, on real candles.

   Candles come from GeckoTerminal by way of /api/ohlcv (edge-cached, one fetch shared by every
   visitor); on plain static hosting the browser asks GeckoTerminal directly (CORS is open there).
   Pool ids are the 32-byte Uniswap v4 ids DexScreener reports as pairAddress. */
(function () {
  'use strict';
  const UP = '#3ddc84', DOWN = '#ff5c6a', CY = '#57e6ff', INK = '#dbe6ec', DIM = 'rgba(219,230,236,.55)', GRID = 'rgba(120,160,180,.12)';
  const FONT = '"Chakra Petch", sans-serif';
  const TF = { '15m': 'minute?aggregate=15', '1h': 'hour?aggregate=1', '1d': 'day?aggregate=1' };
  const fmt = (n, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  // price labels: enough decimals to tell neighbouring gridlines apart, never more than four
  const fmtPx = (n, span) => fmt(n, span < 0.05 ? 4 : span < 5 ? 2 : span < 500 ? 2 : 0);

  let apiAvailable = true;   // false after a 404: static hosting without the Vercel function
  const memo = new Map();    // `${pool}|${tf}|${limit}` -> { ts, promise }
  const TTL = { '15m': 30e3, '1h': 60e3, '1d': 300e3 };

  async function direct(pool, tf, limit) {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/${TF[tf]}&limit=${limit}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('geckoterminal HTTP ' + res.status);
    const body = await res.json();
    const list = (((body || {}).data || {}).attributes || {}).ohlcv_list || [];
    return list.map((k) => k.map(Number)).sort((a, b) => a[0] - b[0]);
  }
  /** Candles for one pool: [[t, o, h, l, c, v], ...] oldest first, or null when the pool is unknown. */
  function candles(pool, tf, limit) {
    pool = String(pool || '').toLowerCase();
    if (!pool) return Promise.resolve(null);
    const key = `${pool}|${tf}|${limit}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.ts < TTL[tf]) return hit.promise;
    const promise = (async () => {
      if (apiAvailable) {
        try {
          const res = await fetch(`/api/ohlcv?pool=${pool}&tf=${tf}&limit=${limit}`);
          if (res.status === 404) apiAvailable = false;
          else if (res.ok) return (await res.json()).candles;
          else throw new Error('ohlcv api HTTP ' + res.status);
        } catch (e) { if (apiAvailable) throw e; }
      }
      return direct(pool, tf, limit);
    })();
    memo.set(key, { ts: Date.now(), promise });
    promise.catch(() => memo.delete(key));
    return promise;
  }
  /** Sparkline series for many pools at once: Map(pool -> candles | null). */
  async function series(pools, tf, limit) {
    const out = new Map();
    const want = [...new Set(pools.filter(Boolean).map((p) => String(p).toLowerCase()))];
    if (!want.length) return out;
    if (apiAvailable) {
      try {
        const res = await fetch(`/api/ohlcv?pools=${want.join(',')}&tf=${tf}&limit=${limit}`);
        if (res.status === 404) apiAvailable = false;
        else if (res.ok) {
          const body = await res.json();
          for (const p of want) if (Object.prototype.hasOwnProperty.call(body.series || {}, p)) out.set(p, body.series[p]);
          return out;
        }
      } catch { /* fall through to direct */ }
    }
    let i = 0;   // three at a time: GeckoTerminal meters by IP and this is the visitor's own allowance
    await Promise.all(Array.from({ length: Math.min(3, want.length) }, async () => {
      while (i < want.length) { const p = want[i++]; try { out.set(p, await candles(p, tf, limit)); } catch { /* dash */ } }
    }));
    return out;
  }

  // ------------------------------------------------------------------ drawing
  /** Fit a canvas to its CSS box at device resolution; returns the 2d context scaled to CSS px. */
  function fit(cv) {
    const r = cv.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), hgt = Math.max(1, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== hgt * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: hgt };
  }
  const tfmt = { '15m': (d) => d.toISOString().slice(11, 16), '1h': (d) => d.toISOString().slice(5, 16).replace('T', ' '), '1d': (d) => d.toISOString().slice(0, 10) };

  /**
   * The chart proper. `el` is the panel body; the panel bar's meta span (`meta`) becomes the
   * OHLC readout under the crosshair. Returns { setTimeframe, destroy }.
   */
  function mount(el, opts) {
    const pool = String(opts.pool || '').toLowerCase();
    const meta = opts.meta || null;
    const restMeta = opts.restMeta || '';
    const cv = document.createElement('canvas'); cv.className = 'cd'; el.appendChild(cv);
    const bar = document.createElement('div'); bar.className = 'cd-tf';
    const btns = {};
    for (const tf of ['15m', '1h', '1d']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = tf.toUpperCase(); b.dataset.tf = tf;
      b.addEventListener('click', () => setTimeframe(tf)); bar.appendChild(b); btns[tf] = b;
    }
    el.appendChild(bar);
    const note = document.createElement('div'); note.className = 'cd-note'; el.appendChild(note);

    let tf = opts.tf || '1h', data = null, hover = -1, dead = false, raf = 0;
    const draw = () => {
      raf = 0;
      const { ctx, w, h } = fit(cv);
      ctx.clearRect(0, 0, w, h);
      if (!data || data.length < 2) return;
      const c = data;
      const padR = 66, x0 = 14, x1 = w - padR, y0 = 16, y1 = h - 58, volH = 34;
      let hi = -Infinity, lo = Infinity;
      for (const k of c) { if (k[2] > hi) hi = k[2]; if (k[3] < lo) lo = k[3]; }
      const span = hi - lo || hi * 0.01 || 1;
      const Y = (p) => y1 - ((p - lo) / span) * (y1 - y0);
      const cw = (x1 - x0) / c.length;
      const X = (i) => x0 + i * cw + cw / 2;
      // grid + right-hand price labels, four lines as the painter draws
      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.font = `400 11px ${FONT}`; ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) { const y = Math.round(y0 + (y1 - y0) * i / 4) + .5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(fmtPx(hi - span * i / 4, span), x1 + 8, y); }
      // time labels along the foot
      const every = Math.max(1, Math.round(c.length / Math.max(2, Math.floor((x1 - x0) / 110))));
      ctx.textAlign = 'center';
      for (let i = 0; i < c.length; i += every) { ctx.fillStyle = DIM; ctx.fillText(tfmt[tf](new Date(c[i][0] * 1000)), X(i), h - 9); }
      // volume, 35% alpha along the foot
      let vmax = 0; for (const k of c) if (k[5] > vmax) vmax = k[5];
      for (let i = 0; i < c.length; i++) { const k = c[i]; const vh = vmax ? (k[5] / vmax) * volH : 0; ctx.fillStyle = k[4] >= k[1] ? 'rgba(61,220,132,.35)' : 'rgba(255,92,106,.35)'; ctx.fillRect(x0 + i * cw + 1, y1 + 20 - vh, Math.max(1, cw - 2), vh); }
      // candles
      for (let i = 0; i < c.length; i++) {
        const k = c[i], x = Math.round(X(i)) + .5, up = k[4] >= k[1];
        ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
        ctx.beginPath(); ctx.moveTo(x, Y(k[2])); ctx.lineTo(x, Y(k[3])); ctx.stroke();
        const top = Y(Math.max(k[1], k[4])), bot = Y(Math.min(k[1], k[4]));
        ctx.fillRect(x - Math.max(1, cw * 0.32), top, Math.max(2, cw * 0.64), Math.max(1.5, bot - top));
      }
      // nine-period mean, cyan
      ctx.strokeStyle = 'rgba(87,230,255,.8)'; ctx.lineWidth = 1.5; ctx.beginPath();
      let sum = 0;
      for (let i = 0; i < c.length; i++) { sum += c[i][4]; if (i > 8) sum -= c[i - 9][4]; const m = sum / Math.min(i + 1, 9); i ? ctx.lineTo(X(i), Y(m)) : ctx.moveTo(X(i), Y(m)); }
      ctx.stroke();
      // last price: dashed line and a filled tag on the axis
      const last = c[c.length - 1][4], first = c[0][1], chg = (last - first) / first;
      ctx.strokeStyle = 'rgba(219,230,236,.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x0, Y(last)); ctx.lineTo(x1, Y(last)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = chg >= 0 ? UP : DOWN; ctx.fillRect(x1 + 2, Y(last) - 9, padR - 4, 18);
      ctx.fillStyle = '#04070a'; ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(fmtPx(last, span), x1 + 7, Y(last));
      // crosshair
      if (hover >= 0 && hover < c.length) {
        const k = c[hover], x = Math.round(X(hover)) + .5, y = Math.round(Y(k[4])) + .5;
        ctx.strokeStyle = 'rgba(219,230,236,.35)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 + 20); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = INK; ctx.fillRect(x1 + 2, y - 9, padR - 4, 18);
        ctx.fillStyle = '#04070a'; ctx.font = `600 11px ${FONT}`; ctx.fillText(fmtPx(k[4], span), x1 + 7, y);
        ctx.fillStyle = INK; ctx.fillRect(x - 34, h - 18, 68, 16);
        ctx.fillStyle = '#04070a'; ctx.textAlign = 'center'; ctx.fillText(tfmt[tf](new Date(k[0] * 1000)), x, h - 10);
      }
      if (meta) {
        if (hover >= 0 && hover < c.length) {
          const k = c[hover], d = k[4] - k[1];
          meta.innerHTML = '';
          for (const [lab, v] of [['O', fmtPx(k[1], span)], ['H', fmtPx(k[2], span)], ['L', fmtPx(k[3], span)], ['C', fmtPx(k[4], span)], ['V', '$' + fmt(k[5], 0)]]) {
            const s = document.createElement('span'); s.className = 'ohlc'; s.append(lab + ' '); const b = document.createElement('b'); b.textContent = v; if (lab === 'C') b.className = d >= 0 ? 'pos' : 'neg'; s.appendChild(b); meta.appendChild(s);
          }
        } else meta.textContent = restMeta;
      }
    };
    const request = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const idx = (ev) => {
      if (!data) return -1;
      const r = cv.getBoundingClientRect(); const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const x0 = 14, x1 = r.width - 66; if (px < x0 || px > x1) return -1;
      return Math.max(0, Math.min(data.length - 1, Math.floor((px - x0) / ((x1 - x0) / data.length))));
    };
    const onMove = (ev) => { const i = idx(ev); if (i !== hover) { hover = i; request(); } };
    const onLeave = () => { if (hover !== -1) { hover = -1; request(); } };
    cv.addEventListener('mousemove', onMove); cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('touchstart', onMove, { passive: true }); cv.addEventListener('touchmove', onMove, { passive: true }); cv.addEventListener('touchend', onLeave);
    const ro = new ResizeObserver(request); ro.observe(cv);

    let seq = 0;
    async function setTimeframe(next) {
      tf = next; for (const k in btns) btns[k].classList.toggle('on', k === tf);
      const my = ++seq; note.textContent = ''; el.classList.add('loading');
      try {
        const rows = await candles(pool, tf, tf === '1d' ? 90 : tf === '1h' ? 120 : 96);
        if (dead || my !== seq) return;
        data = rows && rows.length ? rows : null; hover = -1;
        if (!data) note.textContent = 'NO CANDLES FOR THIS POOL YET';
      } catch (e) { if (dead || my !== seq) return; data = null; note.textContent = 'CANDLES UNAVAILABLE · ' + String(e.message || e).toUpperCase(); }
      el.classList.remove('loading'); request();
    }
    setTimeframe(tf);
    // keep the last candle honest while the page is open
    const tick = setInterval(() => { if (!document.hidden) { memo.delete(`${pool}|${tf}|${tf === '1d' ? 90 : tf === '1h' ? 120 : 96}`); setTimeframe(tf); } }, 60e3);
    return { setTimeframe, destroy() { dead = true; clearInterval(tick); ro.disconnect(); if (raf) cancelAnimationFrame(raf); } };
  }

  /** A sparkline: closes only, coloured by the sign of the move, filled to the baseline at 12%. */
  function spark(cv, rows) {
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    if (!rows || rows.length < 2) { ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(0, h / 2 + .5); ctx.lineTo(w, h / 2 + .5); ctx.stroke(); return null; }
    // a 3-point mean takes the 15-minute jitter off the trace without moving its shape; the move
    // reported is still first close to last close, unsmoothed
    const raw = rows.map((k) => k[4]);
    const cl = raw.map((v, i) => (i === 0 || i === raw.length - 1) ? v : (raw[i - 1] + v + raw[i + 1]) / 3);
    let hi = -Infinity, lo = Infinity; for (const v of cl) { if (v > hi) hi = v; if (v < lo) lo = v; }
    const span = hi - lo || hi * 0.001 || 1, up = raw[raw.length - 1] >= raw[0];
    const X = (i) => 1 + (i / (cl.length - 1)) * (w - 2), Y = (v) => 2 + (1 - (v - lo) / span) * (h - 4);
    ctx.beginPath(); ctx.moveTo(X(0), Y(cl[0]));
    for (let i = 1; i < cl.length; i++) { const xm = (X(i - 1) + X(i)) / 2, ym = (Y(cl[i - 1]) + Y(cl[i])) / 2; ctx.quadraticCurveTo(X(i - 1), Y(cl[i - 1]), xm, ym); }
    ctx.lineTo(X(cl.length - 1), Y(cl[cl.length - 1]));
    ctx.strokeStyle = up ? UP : DOWN; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(X(cl.length - 1), h); ctx.lineTo(X(0), h); ctx.closePath();
    ctx.fillStyle = up ? 'rgba(61,220,132,.12)' : 'rgba(255,92,106,.12)'; ctx.fill();
    ctx.fillStyle = up ? UP : DOWN; ctx.beginPath(); ctx.arc(X(cl.length - 1), Y(cl[cl.length - 1]), 2, 0, Math.PI * 2); ctx.fill();
    return (raw[raw.length - 1] - raw[0]) / raw[0];
  }

  window.LocateChart = { candles, series, mount, spark };
})();
