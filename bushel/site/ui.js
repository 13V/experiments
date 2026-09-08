'use strict';
/**
 * Manna — visual components for the desk's trading pages: token badges, delta pills, the
 * featured area chart and its hover crosshair, sparklines, a range selector, a buy/sell
 * pressure bar, a debounced search box, a sortable table header, and the KPI stat tile. Every
 * export is a plain function that returns a real DOM node (SVG nodes via createElementNS); none
 * of them build markup out of strings, so there is nothing here an unsanitised value could break
 * out of.
 *
 * This is a plain script, not a module — it is loaded with a bare <script src> ahead of app.js
 * and lib.js, and it does not require either of them. Where a formatted string would normally
 * come from window.MANNA (lib.js), a tiny local fallback stands in if that global is absent, so
 * the component still renders something sane when this file is opened on its own. When MANNA is
 * present its formatters are preferred, so numbers on the desk read exactly the way the rest of
 * the site already renders them.
 *
 * Everything is namespaced under the "u-" class prefix in ui.css, which leans entirely on the
 * custom properties style.css already defines (panel colours, borders, the green/red/gold
 * accents, the mono font, the tiny label device) rather than inventing a second palette.
 */
(function () {
  // ============================================================================ tiny fallbacks
  // Used only when window.MANNA (lib.js) has not been loaded. Mirrors lib.js's own rules closely
  // enough that a chart's high/low labels look right either way; the real thing is preferred
  // whenever it is on the page.
  const DASH = (window.MANNA && window.MANNA.DASH) || '—';
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const groupLocal = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimZerosLocal = (s) => (s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s);
  function fmtPriceFallback(n) {
    if (!finite(n)) return DASH;
    if (n >= 1000) return '$' + groupLocal(n.toFixed(2));
    if (n >= 1) return '$' + trimZerosLocal(n.toFixed(4));
    if (n <= 0) return '$0';
    const places = Math.min(18, Math.ceil(-Math.log10(n)) + 3);
    return '$' + trimZerosLocal(n.toFixed(Math.max(0, places)));
  }
  function fmtPrice(n) {
    const M = window.MANNA;
    return M && typeof M.fmtPrice === 'function' ? M.fmtPrice(n) : fmtPriceFallback(n);
  }

  // ============================================================================ DOM helpers
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    return el;
  }
  function el(tag, className, children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (children) for (const c of children) if (c) node.appendChild(c);
    return node;
  }
  function text(str) { return document.createTextNode(str); }
  function hideFromAT(node) { node.setAttribute('aria-hidden', 'true'); return node; }

  // ============================================================================ 1. coinAvatar
  /** A short, stable hash of `str` folded into a 0-359 hue, so a symbol always lands on the same
   * badge colour without a lookup table. Not cryptographic — just deterministic. */
  function hueFromString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  /**
   * A round token badge, `size` px across (default 26). With an `imageUrl` it tries to show the
   * real token image (lazy, no-referrer); the monogram fallback is always painted underneath
   * first, so a broken or slow image never leaves a hole — the worst case is the image failing
   * to cover it, which `onerror` handles by removing the <img> outright.
   */
  function coinAvatar(symbol, imageUrl, size) {
    const px = size || 26;
    const sym = (symbol || '?').toString().toUpperCase();
    const initials = (sym.replace(/[^A-Z0-9]/g, '').slice(0, 2)) || '?';
    const wrap = el('span', 'u-avatar');
    wrap.style.width = px + 'px';
    wrap.style.height = px + 'px';
    wrap.style.fontSize = Math.max(9, Math.round(px * 0.4)) + 'px';
    wrap.style.setProperty('--u-hue', String(hueFromString(sym)));
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', symbol || 'token');

    const fallback = el('span', 'u-avatar-fallback');
    fallback.textContent = initials;
    hideFromAT(fallback);
    wrap.appendChild(fallback);

    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'u-avatar-img';
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { if (img.parentNode) img.parentNode.removeChild(img); });
      img.src = imageUrl;
      wrap.appendChild(img);
    }
    return wrap;
  }

  // ============================================================================ 2. deltaPill
  /**
   * The green/red percentage chip. `pct` is a plain percentage number (-8.65 means -8.65%, not
   * a fraction) — pass null or undefined for "no data yet" and a neutral dash pill comes back
   * instead of a stray "NaN%". The arrow is dropped at exactly zero since neither colour applies.
   */
  function deltaPill(pct, opts) {
    opts = opts || {};
    const dp = opts.dp == null ? 2 : opts.dp;
    const pill = el('span', 'u-pill');
    if (!finite(pct)) {
      pill.classList.add('u-pill--flat');
      pill.appendChild(text(DASH));
      return pill;
    }
    const dir = pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'flat';
    pill.classList.add('u-pill--' + dir);
    if (dir !== 'flat') {
      const arrow = el('span', 'u-pill-arrow');
      arrow.textContent = dir === 'pos' ? '▲' : '▼';
      hideFromAT(arrow);
      pill.appendChild(arrow);
    }
    const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
    pill.appendChild(el('span', 'u-pill-val', [text(sign + Math.abs(pct).toFixed(dp) + '%')]));
    return pill;
  }

  // ============================================================================ shared chart layout
  /**
   * The normalisation every chart (area, sparkline, hover) builds on: each raw value becomes a
   * point in a flat 0-100 x/0-100 y box (x by index, y by value, high at the top). A flat series
   * (every value equal) is centred at y=50 instead of dividing by a zero span, and a single point
   * still gets a well-defined x (50) so a one-point series never trips a NaN into the path data.
   */
  const CHART_PAD_TOP = 12;
  const CHART_PAD_BOTTOM = 10;
  function layoutPoints(points) {
    const n = points ? points.length : 0;
    const vals = [];
    for (let i = 0; i < n; i++) if (finite(points[i])) vals.push(points[i]);
    const has = vals.length > 0;
    const hi = has ? Math.max.apply(null, vals) : 0;
    const lo = has ? Math.min.apply(null, vals) : 0;
    const flat = !has || hi === lo;
    const span = (hi - lo) || 1;
    const xFor = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
    const yFor = (v) => (flat ? 50 : CHART_PAD_TOP + (1 - (v - lo) / span) * (100 - CHART_PAD_TOP - CHART_PAD_BOTTOM));
    const items = [];
    for (let i = 0; i < n; i++) {
      const v = points[i];
      const ok = finite(v);
      items.push({ i, v: ok ? v : null, x: xFor(i), y: ok ? yFor(v) : null });
    }
    return { n, has, hi, lo, flat, items };
  }

  /** Catmull-Rom through `pts` ({x,y} in the 0-100 box), turned into cubic-bezier path data, with
   * each segment's control points clamped to that segment's own y-range so the curve stays a
   * gentle pass through the data rather than overshooting past sharp reversals. 0 and 1 point
   * inputs are handled by the caller; this only ever sees 2 or more. */
  function smoothPath(pts) {
    if (pts.length === 2) return 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2)
      + ' L' + pts[1].x.toFixed(2) + ',' + pts[1].y.toFixed(2);
    let d = 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? i : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      let c1x = p1.x + (p2.x - p0.x) / 6;
      let c1y = p1.y + (p2.y - p0.y) / 6;
      let c2x = p2.x - (p3.x - p1.x) / 6;
      let c2y = p2.y - (p3.y - p1.y) / 6;
      const yLo = Math.min(p1.y, p2.y), yHi = Math.max(p1.y, p2.y);
      c1y = Math.min(yHi, Math.max(yLo, c1y));
      c2y = Math.min(yHi, Math.max(yLo, c2y));
      d += ' C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2)
        + ' ' + p2.x.toFixed(2) + ',' + p2.y.toFixed(2);
    }
    return d;
  }

  /** Green if the series rose (last >= first), red if it fell, gold when there is not enough
   * signal to call a direction (0 or 1 point, or a flat line). */
  function directionColor(points) {
    const vals = (points || []).filter(finite);
    if (vals.length < 2) return 'var(--gold)';
    const first = vals[0], last = vals[vals.length - 1];
    if (last === first) return 'var(--gold)';
    return last > first ? 'var(--green)' : 'var(--red)';
  }

  let chartUid = 0;

  // ============================================================================ 3. areaChart
  /**
   * The big featured price chart: a smooth line over a gradient fill, faint horizontal
   * gridlines, and the series' high/low printed above it. `opts`: `height` (px, default 220),
   * `color` (any CSS colour; defaults to the direction rule above), `showAxis` (gridlines + the
   * high/low readout, default true) and `labels` (x-axis tick strings under the plot). Handles
   * 0, 1, 2 and many points, and a flat series, without ever dividing by zero.
   */
  function areaChart(points, opts) {
    opts = opts || {};
    points = points || [];
    const height = opts.height || 220;
    const showAxis = opts.showAxis !== false;
    const color = opts.color || directionColor(points);
    const layout = layoutPoints(points);
    const uid = 'u-chart-grad-' + (++chartUid);

    const wrap = el('div', 'u-chart');
    wrap.style.setProperty('--u-chart-color', color);

    if (showAxis) {
      const head = el('div', 'u-chart-head');
      if (layout.has) {
        if (layout.flat) {
          head.appendChild(el('span', 'u-chart-hl', [text(fmtPrice(layout.hi))]));
        } else {
          head.appendChild(el('span', 'u-chart-hl u-chart-hl--hi', [text('High '), el('b', null, [text(fmtPrice(layout.hi))])]));
          head.appendChild(el('span', 'u-chart-hl u-chart-hl--lo', [text('Low '), el('b', null, [text(fmtPrice(layout.lo))])]));
        }
      }
      wrap.appendChild(head);
    }

    const plot = el('div', 'u-chart-plot');
    const svg = svgEl('svg', { class: 'u-chart-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
    svg.setAttribute('aria-hidden', 'true');
    plot.appendChild(svg);

    if (showAxis) {
      const grid = svgEl('g', { class: 'u-chart-grid' });
      [25, 50, 75].forEach((gy) => {
        grid.appendChild(svgEl('line', { x1: '0', x2: '100', y1: String(gy), y2: String(gy), 'vector-effect': 'non-scaling-stroke' }));
      });
      svg.appendChild(grid);
    }

    const valid = layout.items.filter((p) => p.y !== null);
    if (valid.length > 0) {
      const linePts = valid.length === 1 ? [{ x: 0, y: valid[0].y }, { x: 100, y: valid[0].y }] : valid;
      const lineD = smoothPath(linePts);
      const areaD = lineD + ' L' + linePts[linePts.length - 1].x.toFixed(2) + ',100'
        + ' L' + linePts[0].x.toFixed(2) + ',100 Z';

      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: uid, x1: '0', y1: '0', x2: '0', y2: '1' });
      const stop0 = svgEl('stop', { offset: '0%' });
      stop0.style.stopColor = 'var(--u-chart-color)';
      stop0.style.stopOpacity = '0.32';
      const stop1 = svgEl('stop', { offset: '100%' });
      stop1.style.stopColor = 'var(--u-chart-color)';
      stop1.style.stopOpacity = '0';
      grad.appendChild(stop0);
      grad.appendChild(stop1);
      defs.appendChild(grad);
      svg.appendChild(defs);

      svg.appendChild(svgEl('path', { class: 'u-chart-area', d: areaD, fill: 'url(#' + uid + ')' }));
      svg.appendChild(svgEl('path', { class: 'u-chart-line', d: lineD, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    } else {
      plot.appendChild(el('div', 'u-chart-empty', [text('No data')]));
    }
    wrap.appendChild(plot);
    wrap.style.setProperty('--u-chart-h', height + 'px');

    if (opts.labels && opts.labels.length) {
      const axis = el('div', 'u-chart-xaxis');
      opts.labels.forEach((lb) => axis.appendChild(el('span', null, [text(String(lb))])));
      wrap.appendChild(axis);
    }

    // Kept for chartHover and for callers that want the raw <svg> without re-querying for it.
    wrap.svg = svg;
    wrap.points = points;
    return wrap;
  }

  // ============================================================================ 4. chartHover
  /**
   * Wires a crosshair (a vertical rule plus a dot on the nearest sample) and a small floating
   * label onto an <svg> built by areaChart. `points` is the same array areaChart was given —
   * chartHover re-derives the same 0-100 layout independently, so the crosshair lines up with
   * the curve without areaChart having to hand back any private state. `onMove(index, point)`
   * is called on every move; whatever it returns (a string or a Node) becomes the label's
   * content, which is how the caller "fills" it. Listens for both pointer and touch events, and
   * returns a `destroy()` that removes every listener and every node this added — safe to call
   * once and safe to call again.
   */
  function chartHover(svg, points, onMove) {
    if (!svg) return { destroy() {} };
    points = points || [];
    const layout = layoutPoints(points);
    const host = svg.parentNode; // areaChart's .u-chart-plot, which is position:relative

    const rule = svgEl('line', { class: 'u-chart-rule', y1: '0', y2: '100', 'vector-effect': 'non-scaling-stroke' });
    const dot = svgEl('circle', { class: 'u-chart-dot', r: '2.6', 'vector-effect': 'non-scaling-stroke' });
    rule.style.display = 'none';
    dot.style.display = 'none';
    svg.appendChild(rule);
    svg.appendChild(dot);

    const tip = host ? el('div', 'u-chart-tip') : null;
    if (tip) { tip.style.display = 'none'; hideFromAT(tip); host.appendChild(tip); }

    function nearestIndex(px) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < layout.items.length; i++) {
        const d = Math.abs(layout.items[i].x - px);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function moveTo(clientX) {
      if (!layout.items.length) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const px = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      const idx = nearestIndex(px);
      const item = layout.items[idx];
      rule.setAttribute('x1', String(item.x));
      rule.setAttribute('x2', String(item.x));
      rule.style.display = '';
      if (item.y !== null) {
        dot.setAttribute('cx', String(item.x));
        dot.setAttribute('cy', String(item.y));
        dot.style.display = '';
      } else {
        dot.style.display = 'none';
      }
      const content = onMove ? onMove(idx, points[idx]) : null;
      if (tip) {
        tip.style.left = item.x + '%';
        tip.style.top = (item.y === null ? 10 : item.y) + '%';
        tip.style.display = '';
        if (content instanceof Node) { tip.textContent = ''; tip.appendChild(content); }
        else if (content != null) { tip.textContent = String(content); }
      }
    }
    function clear() {
      rule.style.display = 'none';
      dot.style.display = 'none';
      if (tip) tip.style.display = 'none';
    }
    function onPointerMove(e) { moveTo(e.clientX); }
    function onTouchMove(e) {
      if (e.touches && e.touches[0]) { moveTo(e.touches[0].clientX); e.preventDefault(); }
    }
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerleave', clear);
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    svg.addEventListener('touchend', clear);
    svg.addEventListener('touchcancel', clear);

    function destroy() {
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerleave', clear);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('touchend', clear);
      svg.removeEventListener('touchcancel', clear);
      if (rule.parentNode) rule.parentNode.removeChild(rule);
      if (dot.parentNode) dot.parentNode.removeChild(dot);
      if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    }
    return { destroy };
  }

  // ============================================================================ 5. sparkline
  /** The small in-row trend line, `opts.width`x`opts.height` (default 64x22), no fill — just the
   * smoothed line, coloured by the same direction rule as areaChart unless `opts.color` is set. */
  function sparkline(points, opts) {
    opts = opts || {};
    const w = opts.width || 64, h = opts.height || 22;
    const color = opts.color || directionColor(points);
    const svg = svgEl('svg', { class: 'u-spark', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
    svg.style.setProperty('--u-chart-color', color);
    hideFromAT(svg);
    const layout = layoutPoints(points || []);
    const valid = layout.items.filter((p) => p.y !== null);
    if (valid.length > 0) {
      const pts = valid.length === 1 ? [{ x: 0, y: valid[0].y }, { x: 100, y: valid[0].y }] : valid;
      svg.appendChild(svgEl('path', { d: smoothPath(pts), fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    }
    return svg;
  }

  // ============================================================================ 6. rangeChips
  /**
   * The 1D/7D/1M/... range selector: a row of real buttons in a radiogroup, one active. `items`
   * is an array of strings or `{key,label}` pairs; `active` is the current key; `onPick(key)`
   * fires on click and on arrow-key roving (Home/End jump to the ends), so the whole thing works
   * from the keyboard without a mouse.
   */
  function rangeChips(items, active, onPick) {
    const list = (items || []).map((it) => (typeof it === 'string' ? { key: it, label: it } : it));
    const wrap = el('div', 'u-chips');
    wrap.setAttribute('role', 'radiogroup');
    const buttons = list.map((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'u-chip';
      btn.textContent = it.label;
      btn.setAttribute('role', 'radio');
      btn.dataset.key = it.key;
      wrap.appendChild(btn);
      return btn;
    });
    function paint(key) {
      buttons.forEach((btn) => {
        const on = btn.dataset.key === key;
        btn.classList.toggle('u-chip--active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      });
    }
    function pick(key, focus) {
      paint(key);
      if (focus) {
        const btn = buttons.find((b) => b.dataset.key === key);
        if (btn) btn.focus();
      }
      if (onPick) onPick(key);
    }
    buttons.forEach((btn, idx) => {
      btn.addEventListener('click', () => pick(btn.dataset.key, false));
      btn.addEventListener('keydown', (e) => {
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % buttons.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + buttons.length) % buttons.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        if (next >= 0) { e.preventDefault(); pick(buttons[next].dataset.key, true); }
      });
    });
    paint(active != null ? active : (list[0] && list[0].key));
    wrap.setActive = paint;
    return wrap;
  }

  // ============================================================================ 7. pressureBar
  /** A thin buy/sell split bar — green left, red right — with both counts and the buy share as
   * text. `buys`/`sells` are counts (not fractions); 0/0 renders a neutral, evenly-split bar
   * with no share percentage rather than a divide-by-zero. */
  function pressureBar(buys, sells) {
    const b = finite(buys) ? Math.max(0, buys) : 0;
    const s = finite(sells) ? Math.max(0, sells) : 0;
    const total = b + s;
    const pct = total > 0 ? (b / total) * 100 : null;
    const wrap = el('div', 'u-pressure' + (total === 0 ? ' u-pressure--empty' : ''));
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Buy/sell pressure: ' + b + ' buys, ' + s + ' sells');
    const bar = el('div', 'u-pressure-bar');
    const buySpan = el('span', 'u-pressure-buy');
    const sellSpan = el('span', 'u-pressure-sell');
    const buyPct = pct === null ? 50 : pct;
    buySpan.style.width = buyPct + '%';
    sellSpan.style.width = (100 - buyPct) + '%';
    bar.appendChild(buySpan);
    bar.appendChild(sellSpan);
    const meta = el('div', 'u-pressure-meta', [
      el('span', 'u-pressure-buys', [text(b + ' buys')]),
      el('span', 'u-pressure-share', [text(pct === null ? DASH : Math.round(pct) + '%')]),
      el('span', 'u-pressure-sells', [text(s + ' sells')]),
    ]);
    wrap.appendChild(bar);
    wrap.appendChild(meta);
    return wrap;
  }

  // ============================================================================ 8. searchBox
  function magnifierIcon() {
    const svg = svgEl('svg', { class: 'u-search-icon', viewBox: '0 0 24 24' });
    svg.appendChild(svgEl('circle', { cx: '10.5', cy: '10.5', r: '6.5' }));
    svg.appendChild(svgEl('path', { d: 'M19.5 19.5 15 15' }));
    hideFromAT(svg);
    return svg;
  }
  function clearIcon() {
    const svg = svgEl('svg', { class: 'u-search-clear-icon', viewBox: '0 0 24 24' });
    svg.appendChild(svgEl('path', { d: 'M6 6l12 12M18 6 6 18' }));
    hideFromAT(svg);
    return svg;
  }

  /** The top-bar search field: a magnifier, an input debounced ~120ms so `onInput` is not called
   * on every keystroke, and a clear button that only shows once there is something to clear.
   * Returns `{el, value, clear}` — `value()` reads the current text, `clear()` empties it (and
   * fires `onInput('')`) the same way the button does. */
  function searchBox(placeholder, onInput) {
    const wrap = el('div', 'u-search');
    wrap.setAttribute('role', 'search');
    const input = document.createElement('input');
    input.className = 'u-search-input';
    input.placeholder = placeholder || 'Search';
    input.setAttribute('aria-label', placeholder || 'Search');
    input.autocomplete = 'off';
    input.spellcheck = false;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'u-search-clear';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.hidden = true;
    clearBtn.appendChild(clearIcon());

    let timer = null;
    function fire(v) { if (onInput) onInput(v); }
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fire(input.value), 120);
    }
    input.addEventListener('input', () => {
      clearBtn.hidden = input.value.length === 0;
      schedule();
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.hidden = true;
      if (timer) clearTimeout(timer);
      fire('');
      input.focus();
    });

    wrap.appendChild(magnifierIcon());
    wrap.appendChild(input);
    wrap.appendChild(clearBtn);

    return {
      el: wrap,
      value: () => input.value,
      clear: () => {
        input.value = '';
        clearBtn.hidden = true;
        if (timer) clearTimeout(timer);
        fire('');
      },
    };
  }

  // ============================================================================ 9. sortableHeader
  /**
   * Builds a <thead> whose sortable columns are real buttons that cycle asc/desc on the active
   * column (a click on a different column starts it at asc); the active column shows a ▲/▼ and
   * carries `aria-sort`. `columns` is `[{key, label, num, sortable}]` — `num` right-aligns the
   * cell the way the desk's own tables already do. Returns `{el, setActive(key, dir)}` so a page
   * can also drive the header's indicator from outside (e.g. to set the initial sort).
   */
  function sortableHeader(columns, onSort) {
    columns = columns || [];
    const state = { key: null, dir: 'asc' };
    const thead = document.createElement('thead');
    const row = document.createElement('tr');
    const cells = {};

    columns.forEach((col) => {
      const th = document.createElement('th');
      if (col.num) th.classList.add('num');
      if (col.sortable) {
        th.classList.add('u-th-sortable');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'u-th-btn';
        btn.appendChild(text(col.label));
        const arrow = el('span', 'u-th-arrow');
        hideFromAT(arrow);
        btn.appendChild(arrow);
        btn.addEventListener('click', () => {
          if (state.key === col.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else { state.key = col.key; state.dir = 'asc'; }
          paint();
          if (onSort) onSort(state.key, state.dir);
        });
        th.appendChild(btn);
      } else {
        th.textContent = col.label;
      }
      cells[col.key] = th;
      row.appendChild(th);
    });
    thead.appendChild(row);

    function paint() {
      columns.forEach((col) => {
        const th = cells[col.key];
        th.classList.remove('u-th-active');
        th.removeAttribute('aria-sort');
        const arrow = th.querySelector('.u-th-arrow');
        if (arrow) arrow.textContent = '';
      });
      if (state.key && cells[state.key]) {
        const th = cells[state.key];
        th.classList.add('u-th-active');
        th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
        const arrow = th.querySelector('.u-th-arrow');
        if (arrow) arrow.textContent = state.dir === 'asc' ? '▲' : '▼';
      }
    }
    function setActive(key, dir) { state.key = key; state.dir = dir || 'asc'; paint(); }
    paint();
    return { el: thead, setActive };
  }

  // ============================================================================ icon set
  // A small built-in line-icon registry for statTile, so the desk never reaches for an icon
  // font or a network request. Each icon is a flat list of SVG shape descriptors in a 24x24
  // box, drawn stroke-first to match the rail's own nav icons; a couple (flame) read better
  // filled solid, which the descriptor says for itself via `fill`.
  const ICONS = {
    wallet: [
      { tag: 'path', attrs: { d: 'M4 7.2A2.2 2.2 0 0 1 6.2 5h11.6A2.2 2.2 0 0 1 20 7.2v9.6A2.2 2.2 0 0 1 17.8 19H6.2A2.2 2.2 0 0 1 4 16.8V7.2z' } },
      { tag: 'path', attrs: { d: 'M4 9.8h16' } },
      { tag: 'path', attrs: { d: 'M15 13.6h3a1 1 0 0 1 1 1v.8a1 1 0 0 1-1 1h-3a1.9 1.9 0 0 1 0-3.8z' } },
    ],
    coins: [
      { tag: 'ellipse', attrs: { cx: '12', cy: '6.6', rx: '7', ry: '2.6' } },
      { tag: 'path', attrs: { d: 'M5 6.6v10.8c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6V6.6' } },
      { tag: 'path', attrs: { d: 'M5 12c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6' } },
    ],
    chart: [
      { tag: 'path', attrs: { d: 'M4 19.5h16' } },
      { tag: 'path', attrs: { d: 'M4.5 15.5l4-4.5 3.8 3 6.2-7.5' } },
    ],
    clock: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8' } },
      { tag: 'path', attrs: { d: 'M12 7.8V12.3l3 2' } },
    ],
    flame: [
      { tag: 'path', attrs: { d: 'M17.66 18.66A8 8 0 0 1 6.34 7.34S7 9 9 10c0-2 .5-5 3-7 1 2 3.1 2.78 4.66 4.34A7.98 7.98 0 0 1 20 13a7.98 7.98 0 0 1-2.34 5.66z' } },
      { tag: 'path', attrs: { d: 'M9.88 16.12A3 3 0 1 0 12.01 11L11 14H9c0 .77.3 1.54.88 2.12z' } },
    ],
    shield: [
      { tag: 'path', attrs: { d: 'M12 3.2l6.5 2.6v5.1c0 4.6-2.8 7.9-6.5 9.6-3.7-1.7-6.5-5-6.5-9.6V5.8L12 3.2z' } },
      { tag: 'path', attrs: { d: 'M9 12.1l2 2 4.2-4.4' } },
    ],
    arrows: [
      { tag: 'path', attrs: { d: 'M4 8.5h13.5M13.5 4.5l4 4-4 4' } },
      { tag: 'path', attrs: { d: 'M20 15.5H6.5m4 4-4-4 4-4' } },
    ],
  };

  function buildIcon(name) {
    const shapes = ICONS[name] || ICONS.chart;
    const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'u-icon' });
    hideFromAT(svg);
    shapes.forEach((shape) => svg.appendChild(svgEl(shape.tag, shape.attrs)));
    return svg;
  }

  // ============================================================================ 10. statTile
  /**
   * The KPI tile: a round icon, the tiny uppercase label, a big tabular-numeral value, and an
   * optional delta pill and sub-line. `icon` is a name from the ICONS set above; `delta`, when
   * present, is handed straight to deltaPill (so null/undefined there still renders its own
   * neutral dash) — omit the `delta` key entirely to leave the pill out altogether.
   */
  function statTile(opts) {
    opts = opts || {};
    const tile = el('div', 'u-tile');
    if (opts.icon) tile.appendChild(el('span', 'u-tile-icon', [buildIcon(opts.icon)]));
    const body = el('div', 'u-tile-body');
    body.appendChild(el('div', 'u-tile-label', [text(opts.label || '')]));
    const row = el('div', 'u-tile-value-row');
    row.appendChild(el('span', 'u-tile-value', [text(opts.value === null || opts.value === undefined ? DASH : String(opts.value))]));
    if (Object.prototype.hasOwnProperty.call(opts, 'delta')) row.appendChild(deltaPill(opts.delta));
    body.appendChild(row);
    if (opts.sub) body.appendChild(el('div', 'u-tile-sub', [text(opts.sub)]));
    tile.appendChild(body);
    return tile;
  }

  // ============================================================================ export
  window.MannaUI = {
    coinAvatar,
    deltaPill,
    areaChart,
    chartHover,
    sparkline,
    rangeChips,
    pressureBar,
    searchBox,
    sortableHeader,
    statTile,
    ICONS,
  };
})();
