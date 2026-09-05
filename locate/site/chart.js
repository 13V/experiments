/* Locate — price charts, drawn the way the desk's own monitors draw them.
   scene.js paints candles onto its screens with a fixed grammar: a 4-line grid, right-hand price
   labels, 0.64-width candles, a 9-period mean in cyan, volume at 35% alpha along the foot, and a
   dashed last-price line with a filled tag. This is that grammar at DOM scale, on real candles.

   Candles come from GeckoTerminal by way of /api/ohlcv (edge-cached, one fetch shared by every
   visitor); on plain static hosting the browser asks GeckoTerminal directly (CORS is open there).
   Pool ids are the 32-byte Uniswap v4 ids DexScreener reports as pairAddress. */
(function () {
  'use strict';
  // colour comes from the stylesheet's --cd-* tokens; these are the fallbacks
  const cssVar = (n, fb) => { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || fb; };
  let UP, DOWN, INK, DIM, GRID, FONT;
  function palette() {
    UP = cssVar('--cd-up', '#f2c46d'); DOWN = cssVar('--cd-down', '#f0569a'); INK = cssVar('--cd-text', '#f4f5ff');
    DIM = cssVar('--cd-muted', '#7d82a8'); GRID = cssVar('--cd-grid', 'rgba(255,255,255,.05)');
    FONT = cssVar('--ui', "'Inter', sans-serif");
  }
  palette();
  const TF = { '15m': 'minute?aggregate=15', '1h': 'hour?aggregate=1', '1d': 'day?aggregate=1' };
  const fmt = (n, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  // price labels: enough decimals to tell neighbouring gridlines apart, never more than four
  const fmtPx = (n, span) => fmt(n, span < 0.05 ? 4 : span < 5 ? 2 : span < 500 ? 2 : 0);

  let apiAvailable = true;   // false after a 404: static hosting without the Vercel function
  const memo = new Map();    // `${pool}|${tf}|${limit}` -> { ts, promise }
  const TTL = { '15m': 60e3, '1h': 90e3, '1d': 300e3 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** fetch with a deadline: a request that hangs must not stall the retry loop behind it */
  function fetchT(url, ms, init) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({}, init, { signal: ac.signal })).finally(() => clearTimeout(t));
  }

  async function direct(pool, tf, limit) {
    const res = await fetchT(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/${TF[tf]}&limit=${limit}`, 6000, { headers: { Accept: 'application/json' } });
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
      // The function first (one cached answer for everyone), then GeckoTerminal directly. A
      // refusal is usually the upstream metering a burst, so a few tries a second or two apart
      // succeed where one does not; the caller only hears about it when all of them fail.
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await sleep(700 * 2 ** (attempt - 1));
        if (apiAvailable) {
          try {
            const res = await fetchT(`/api/ohlcv?pool=${pool}&tf=${tf}&limit=${limit}`, 9000);
            if (res.status === 404) apiAvailable = false;
            else if (res.ok) return (await res.json()).candles;
            else lastErr = new Error('ohlcv api HTTP ' + res.status);
          } catch (e) { lastErr = e; }
        }
        try { return await direct(pool, tf, limit); } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('unavailable');
    })();
    memo.set(key, { ts: Date.now(), promise });
    promise.catch(() => memo.delete(key));
    return promise;
  }
  /** Sparkline series for many pools at once: Map(pool -> candles | null). */
  async function series(pools, tf, limit) {
    const out = new Map();
    const all = [...new Set(pools.filter(Boolean).map((p) => String(p).toLowerCase()))];
    const want = [];
    for (const p of all) {
      const hit = memo.get(`${p}|${tf}|${limit}`);
      if (hit && Date.now() - hit.ts < TTL[tf]) { try { out.set(p, await hit.promise); continue; } catch { /* refetch */ } }
      want.push(p);
    }
    if (!want.length) return out;
    const remember = (p, rows) => memo.set(`${p}|${tf}|${limit}`, { ts: Date.now(), promise: Promise.resolve(rows) });
    if (apiAvailable) {
      try {
        const res = await fetchT(`/api/ohlcv?pools=${want.join(',')}&tf=${tf}&limit=${limit}`, 12000);
        if (res.status === 404) apiAvailable = false;
        else if (res.ok) {
          const body = await res.json();
          for (const p of want) if (Object.prototype.hasOwnProperty.call(body.series || {}, p)) { out.set(p, body.series[p]); remember(p, body.series[p]); }
          if (want.every((p) => out.has(p))) return out;   // anything the function could not get, fetch direct below
        }
      } catch { /* fall through to direct */ }
    }
    const missing = want.filter((p) => !out.has(p));
    if (!missing.length) return out;
    let i = 0;   // three at a time: GeckoTerminal meters by IP and this is the visitor's own allowance
    await Promise.all(Array.from({ length: Math.min(3, missing.length) }, async () => {
      while (i < missing.length) { const p = missing[i++]; try { const rows = await direct(p, tf, limit); out.set(p, rows); remember(p, rows); } catch { /* dash */ } }
    }));
    return out;
  }

  // ------------------------------------------------------------------ drawing
  /** Fit a canvas to its CSS box at device resolution; returns the 2d context scaled to CSS px. */
  function fit(cv) {
    // layout size, not the bounding rect: the window is transform-scaled while it docks, and a
    // rect read mid-flight would size the backing store to the scaled box for good
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, cv.clientWidth), hgt = Math.max(1, cv.clientHeight);
    if (cv.width !== w * dpr || cv.height !== hgt * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: hgt };
  }
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hm = (d) => d.toISOString().slice(11, 16), dmy = (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const tfmt = {
    '15m': hm, '1h': hm, '1d': (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`,
    card: { '15m': (d) => `${dmy(d)} · ${hm(d)} UTC`, '1h': (d) => `${dmy(d)} · ${hm(d)} UTC`, '1d': dmy },
  };

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
    (opts.tfSlot || el).appendChild(bar);
    const note = document.createElement('div'); note.className = 'cd-note'; el.appendChild(note);

    let tf = opts.tf || '1h', data = null, hover = -1, dead = false, raf = 0;
    const draw = () => {
      raf = 0; palette();
      const { ctx, w, h } = fit(cv);
      ctx.clearRect(0, 0, w, h);
      if (!data || data.length < 2) return;
      const c = data;
      const axW = 58, x0 = axW, x1 = w - 18, y0 = 18, y1 = h - 42;
      let hi = -Infinity, lo = Infinity;
      for (const k of c) { if (k[2] > hi) hi = k[2]; if (k[3] < lo) lo = k[3]; }
      const pad = (hi - lo) * 0.06 || hi * 0.005 || 1; hi += pad; lo -= pad;
      const span = hi - lo;
      const Y = (p) => y1 - ((p - lo) / span) * (y1 - y0);
      const cw = (x1 - x0) / c.length;
      const X = (i) => x0 + i * cw + cw / 2;
      const axis = (v) => (span > 2000 ? (v / 1000).toFixed(1) + 'k' : fmtPx(v, span));
      // gridlines, faint, with the label and a dot on the left axis
      ctx.lineWidth = 1; ctx.font = `500 11px ${FONT}`; ctx.textBaseline = 'middle';
      const yLast = Math.round(Y(c[c.length - 1][4])) + .5;   // the price tag sits here; labels step aside
      for (let i = 0; i <= 5; i++) {
        const y = Math.round(y0 + (y1 - y0) * i / 5) + .5;
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        if (Math.abs(y - yLast) < 14) continue;
        ctx.fillStyle = DIM; ctx.textAlign = 'right'; ctx.fillText(axis(hi - span * i / 5), axW - 14, y);
        ctx.beginPath(); ctx.arc(axW - 6, y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      // time labels and dots along the foot
      const every = Math.max(1, Math.round(c.length / Math.max(2, Math.floor((x1 - x0) / 96))));
      ctx.textAlign = 'center';
      let lastDay = -1;
      for (let i = 0; i < c.length; i += every) {
        const d = new Date(c[i][0] * 1000); let lab = tfmt[tf](d);
        if (tf !== '1d') { const day = d.getUTCDate(); if (day !== lastDay && lastDay !== -1) lab = `${day} ${MON[d.getUTCMonth()]}`; lastDay = day; }   // a new day is labelled by its date
        ctx.fillStyle = DIM; ctx.fillText(lab, X(i), h - 14); ctx.beginPath(); ctx.arc(X(i), y1 + 9, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      // candles: 1px wicks, rounded bodies, gold up and pink down
      const bw = Math.max(3, Math.min(14, cw * 0.55)), r = Math.min(3, bw / 2);
      for (let i = 0; i < c.length; i++) {
        const k = c[i], x = Math.round(X(i)) + .5, up = k[4] >= k[1];
        ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
        ctx.beginPath(); ctx.moveTo(x, Y(k[2])); ctx.lineTo(x, Y(k[3])); ctx.stroke();
        const top = Y(Math.max(k[1], k[4])), bot = Y(Math.min(k[1], k[4])), bh = Math.max(2, bot - top);
        ctx.beginPath(); ctx.roundRect(x - bw / 2, top, bw, bh, r); ctx.fill();
      }
      // last price: a dashed line and a white tag on the axis
      const last = c[c.length - 1][4], first = c[0][1], chg = (last - first) / first;
      const yl = Math.round(Y(last)) + .5;
      ctx.strokeStyle = 'rgba(244,245,255,.45)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x0, yl); ctx.lineTo(x1, yl); ctx.stroke(); ctx.setLineDash([]);
      const tag = axis(last); ctx.font = `600 10.5px ${FONT}`; const tw = ctx.measureText(tag).width + 14;
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(axW - 10 - tw, yl - 9, tw, 18, 9); ctx.fill();
      ctx.fillStyle = '#0e1231'; ctx.textAlign = 'center'; ctx.fillText(tag, axW - 10 - tw / 2, yl);
      // crosshair: a dashed vertical, a dot on the close, and a card with the time and price
      if (hover >= 0 && hover < c.length) {
        const k = c[hover], x = Math.round(X(hover)) + .5, y = Y(k[4]);
        ctx.strokeStyle = 'rgba(244,245,255,.28)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1 + 4); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = k[4] >= k[1] ? UP : DOWN; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
        const l1 = tfmt.card[tf](new Date(k[0] * 1000)), l2 = '$' + fmt(k[4]);
        ctx.font = `500 10.5px ${FONT}`; const w1 = ctx.measureText(l1).width; ctx.font = `600 12px ${FONT}`; const w2 = ctx.measureText(l2).width;
        const cwid = Math.max(w1, w2) + 20, chgt = 40; let cx = x - cwid / 2, cy = y - chgt - 14;
        if (cy < y0) cy = y + 14; cx = Math.max(x0, Math.min(x1 - cwid, cx));
        ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(cx, cy, cwid, chgt, 8); ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.textAlign = 'left'; ctx.fillStyle = '#6d729a'; ctx.font = `500 10.5px ${FONT}`; ctx.fillText(l1, cx + 10, cy + 13);
        ctx.fillStyle = '#0e1231'; ctx.font = `600 12px ${FONT}`; ctx.fillText(l2, cx + 10, cy + 28);
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
      const r = cv.getBoundingClientRect(); const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (cv.clientWidth / (r.width || 1));
      const x0 = 58, x1 = cv.clientWidth - 18; if (px < x0 || px > x1) return -1;
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
      const slow = setTimeout(() => { if (my === seq && !data) note.textContent = 'Fetching candles…'; }, 1800);
      try {
        const rows = await candles(pool, tf, tf === '1d' ? 90 : tf === '1h' ? 120 : 96);
        if (dead || my !== seq) return;
        data = rows && rows.length ? rows : null; hover = -1;
        clearTimeout(slow);
        note.textContent = data ? '' : 'No candles for this pool yet';   // the slow-note may already be up
      } catch (e) {
        clearTimeout(slow);
        if (dead || my !== seq) return; data = null;
        note.textContent = 'Chart unavailable right now · it will retry shortly';
        console.warn('candles', e);
      }
      el.classList.remove('loading'); request();
    }
    setTimeframe(tf);
    // keep the last candle honest while the page is open
    const tick = setInterval(() => { if (!document.hidden && (data || !dead)) { memo.delete(`${pool}|${tf}|${tf === '1d' ? 90 : tf === '1h' ? 120 : 96}`); setTimeframe(tf); } }, 60e3);
    const soon = setInterval(() => { if (!data && !document.hidden) setTimeframe(tf); }, 15e3);
    return { setTimeframe, destroy() { dead = true; clearInterval(tick); clearInterval(soon); ro.disconnect(); if (raf) cancelAnimationFrame(raf); } };
  }

  /** A sparkline: closes only, coloured by the sign of the move, filled to the baseline at 12%. */
  function spark(cv, rows) {
    palette();
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
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, up ? 'rgba(242,196,109,.22)' : 'rgba(240,86,154,.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = up ? UP : DOWN; ctx.beginPath(); ctx.arc(X(cl.length - 1), Y(cl[cl.length - 1]), 2, 0, Math.PI * 2); ctx.fill();
    return (raw[raw.length - 1] - raw[0]) / raw[0];
  }

  window.LocateChart = { candles, series, mount, spark };
})();
