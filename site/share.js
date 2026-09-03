'use strict';
/**
 * Stonk Packs share card. Draws an opened pack as a 1200x630 PNG on an offscreen
 * canvas, in the page's own language: paper, grain, ink rules, one green, foil for
 * a Mythic. Everything it draws is same-origin (the logos are local PNGs), so the
 * canvas never taints and toBlob keeps working.
 *
 *   const blob = await SHARE.renderCard(pack, { tiers, tierColors, siteUrl });
 *
 * pack: { id, demo, totalCents, pulls: [{ tier, symbol, name, usdCents, amountText }] }
 */
(function (global) {
  const W = 1200;
  const H = 630;

  const PAPER = '#f4efe4';
  const INK = '#141311';
  const INK2 = '#4a4640';
  const INK3 = '#8a847a';
  const RULE = '#cfc7b4';
  const GREEN = '#0f7a3d';
  const GREEN_INK = '#0a5a2c';
  const WHITE = '#ffffff';

  // .card[data-tier="5"] .face.back, and its one step down
  const FOIL = [[0, '#f7e7b0'], [0.3, '#fff7dc'], [0.55, '#e9c96a'], [0.8, '#fff2c8'], [1, '#dcb95a']];
  const LEGENDARY = [[0, '#fbe9d6'], [0.6, PAPER], [1, PAPER]];

  const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  const TIER_COLORS = ['#6b665e', '#2f7d4f', '#2b5fa8', '#6f3fa3', '#c25a12', '#b8891b'];
  const SITE_URL = 'stonk-packs.vercel.app';
  const LOGO_PATH = (global.STONK_CONFIG && global.STONK_CONFIG.logoPath) || 'logos/';

  const FONTS = { display: '', serif: '', mono: '' };

  const fmtUsd = (cents) =>
    (global.SP && global.SP.fmtUsd)
      ? global.SP.fmtUsd(cents)
      : '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const cssVar = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  };

  // ---------------------------------------------------------------------------
  // Text: canvas letter-spacing where the browser has it, hand-tracked where not.
  // ---------------------------------------------------------------------------
  const CAN_TRACK = (() => {
    try { return 'letterSpacing' in document.createElement('canvas').getContext('2d'); } catch { return false; }
  })();

  function font(g, spec, track) {
    g.font = spec;
    g.__track = track || 0;
    if (CAN_TRACK) g.letterSpacing = (track || 0) + 'px';
  }
  function widthOf(g, s) {
    if (CAN_TRACK) return g.measureText(s).width;
    let w = 0, n = 0;
    for (const ch of s) { w += g.measureText(ch).width + g.__track; n++; }
    return n ? w - g.__track : 0;
  }
  function text(g, s, x, y, align) {
    s = String(s);
    const w = widthOf(g, s);
    const dx = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    if (CAN_TRACK) {
      g.textAlign = 'left';
      g.fillText(s, x + dx, y);
    } else {
      let cx = x + dx;
      for (const ch of s) { g.fillText(ch, cx, y); cx += g.measureText(ch).width + g.__track; }
    }
    return w;
  }
  function fit(g, s, max) {
    s = String(s || '');
    if (!s || widthOf(g, s) <= max) return s;
    let out = s;
    while (out.length > 1 && widthOf(g, out + '…') > max) out = out.slice(0, -1);
    return out.replace(/[\s,.·-]+$/, '') + '…';
  }

  // ---------------------------------------------------------------------------
  // Shapes
  // ---------------------------------------------------------------------------
  function roundPath(g, x, y, w, h, r) {
    const c = Array.isArray(r) ? r : [r, r, r, r];
    const m = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = c.map((v) => Math.max(0, Math.min(v, m)));
    g.beginPath();
    g.moveTo(x + tl, y);
    g.lineTo(x + w - tr, y);
    g.arcTo(x + w, y, x + w, y + tr, tr);
    g.lineTo(x + w, y + h - br);
    g.arcTo(x + w, y + h, x + w - br, y + h, br);
    g.lineTo(x + bl, y + h);
    g.arcTo(x, y + h, x, y + h - bl, bl);
    g.lineTo(x, y + tl);
    g.arcTo(x, y, x + tl, y, tl);
    g.closePath();
  }
  const fillRound = (g, x, y, w, h, r, style) => { g.fillStyle = style; roundPath(g, x, y, w, h, r); g.fill(); };
  const strokeRound = (g, x, y, w, h, r, style, lw) => {
    g.strokeStyle = style; g.lineWidth = lw;
    roundPath(g, x + lw / 2, y + lw / 2, w - lw, h - lw, r);
    g.stroke();
  };
  function gradient(g, stops, x, y, w, h) {
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    for (const [at, col] of stops) grad.addColorStop(at, col);
    return grad;
  }
  function line(g, x1, y1, x2, y2, style, lw) {
    g.strokeStyle = style; g.lineWidth = lw;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }

  // The page's paper grain, as a repeating tile multiplied over the whole card.
  let grainTile = null;
  function grain(g) {
    if (!grainTile) {
      const n = 160;
      const seed = document.createElement('canvas');
      seed.width = seed.height = n;
      const sg = seed.getContext('2d');
      const img = sg.createImageData(n, n);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random();
        d[i] = 51; d[i + 1] = 46; d[i + 2] = 38;
        d[i + 3] = v * 72; // linear, not v*v: squaring gave a heavy tail of dark flecks that read as blotchy
      }
      sg.putImageData(img, 0, 0);
      // scale it up once so the speckle reads as paper tooth, not television snow
      const t = document.createElement('canvas');
      t.width = t.height = n * 2;
      const tg = t.getContext('2d');
      tg.imageSmoothingEnabled = true;
      tg.drawImage(seed, 0, 0, n * 2, n * 2);
      grainTile = t;
    }
    const pat = g.createPattern(grainTile, 'repeat');
    if (!pat) return;
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = 0.3; // matches the mean darkening of the page's own body::before noise
    g.fillStyle = pat;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  // ---------------------------------------------------------------------------
  // Logos: same-origin PNGs. Light marks vanish on paper, so those get an ink disc,
  // exactly as the page does it.
  // ---------------------------------------------------------------------------
  const logoCache = new Map();
  function isLight(img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const cg = c.getContext('2d', { willReadFrequently: true });
      cg.drawImage(img, 0, 0, 24, 24);
      const d = cg.getImageData(0, 0, 24, 24).data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 40) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      }
      return n > 0 && sum / n > 190;
    } catch { return false; }
  }
  function loadLogo(symbol) {
    if (!/^[A-Z0-9.]{1,8}$/.test(symbol || '')) return Promise.resolve(null);
    if (logoCache.has(symbol)) return logoCache.get(symbol);
    const p = new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      img.onload = () => done(img.naturalWidth ? img : null);
      img.onerror = () => done(null);
      setTimeout(() => done(null), 5000);
      img.src = LOGO_PATH + symbol + '.png';
    }).then((img) => (img ? { img, light: isLight(img) } : null));
    logoCache.set(symbol, p);
    return p;
  }

  function drawLogo(g, logo, symbol, cx, cy, d) {
    const r = d / 2;
    g.save();
    g.fillStyle = 'rgba(20, 19, 17, 0.85)';
    g.beginPath(); g.arc(cx + 2, cy + 2, r, 0, Math.PI * 2); g.fill();
    g.restore();
    g.fillStyle = logo && logo.light ? INK : WHITE;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    if (logo) {
      const box = d - 14;
      const s = Math.min(box / logo.img.naturalWidth, box / logo.img.naturalHeight);
      const w = logo.img.naturalWidth * s;
      const h = logo.img.naturalHeight * s;
      g.save();
      g.beginPath(); g.arc(cx, cy, r - 3, 0, Math.PI * 2); g.clip();
      g.drawImage(logo.img, cx - w / 2, cy - h / 2, w, h);
      g.restore();
    } else if (symbol === 'USDG') {
      g.fillStyle = GREEN_INK;
      font(g, `800 ${Math.round(d * 0.5)}px ${FONTS.display}`, 0);
      g.textBaseline = 'middle';
      text(g, '$', cx, cy + 1, 'center');
      g.textBaseline = 'alphabetic';
    } else {
      g.fillStyle = INK3;
      font(g, `800 ${Math.round(d * 0.32)}px ${FONTS.display}`, -0.5);
      g.textBaseline = 'middle';
      text(g, (symbol || '?').slice(0, 3), cx, cy + 1, 'center');
      g.textBaseline = 'alphabetic';
    }
    g.lineWidth = 2;
    g.strokeStyle = INK;
    g.beginPath(); g.arc(cx, cy, r - 1, 0, Math.PI * 2); g.stroke();
  }

  function barcode(g, x, y, w, h, seedText) {
    let seed = 2166136261;
    for (const ch of String(seedText || 'stonk')) { seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619) >>> 0; }
    const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    g.save();
    g.globalAlpha = 0.8;
    g.fillStyle = INK;
    let cx = x;
    while (cx < x + w) {
      const bw = 1 + Math.floor(next() * 2.4);
      if (cx + bw > x + w) break;
      g.fillRect(cx, y, bw, h);
      cx += bw + 1 + Math.floor(next() * 3);
    }
    g.restore();
  }

  // ---------------------------------------------------------------------------
  // One card, drawn like .face.back
  // ---------------------------------------------------------------------------
  function drawCard(g, box, pull, logo, index, pack, tiers, tierColors) {
    const { x, y, w, h } = box;
    const t = Math.max(0, Math.min(Number(pull.tier) || 0, 5));
    const r = tierColors[t] || TIER_COLORS[t];
    const name = (tiers[pull.tier] && tiers[pull.tier].name) || TIER_NAMES[t] || `Tier ${t + 1}`;

    // hard print shadow, then the card face
    fillRound(g, x + 5, y + 6, w, h, 8, 'rgba(20, 19, 17, 0.15)');
    const face = t === 5 ? gradient(g, FOIL, x, y, w, h) : t === 4 ? gradient(g, LEGENDARY, x, y, w, h) : PAPER;
    fillRound(g, x, y, w, h, 8, face);
    if (t === 5) {
      g.save();
      roundPath(g, x, y, w, h, 8); g.clip();
      g.globalAlpha = 0.45;
      g.fillStyle = '#fffdf2';
      g.beginPath();
      g.moveTo(x - 10, y + h * 0.74); g.lineTo(x + w * 0.60, y - 10);
      g.lineTo(x + w * 0.82, y - 10); g.lineTo(x - 10, y + h * 0.98);
      g.closePath(); g.fill();
      g.restore();
    }
    strokeRound(g, x, y, w, h, 8, INK, 2);

    const pad = 8;
    const ix = x + pad, iw = w - pad * 2;

    // band
    const bandH = 22;
    fillRound(g, ix, y + pad, iw, bandH, [4, 4, 0, 0], r);
    g.fillStyle = PAPER;
    g.textBaseline = 'middle';
    font(g, `800 10.5px ${FONTS.display}`, 1.05);
    const noUp = `NO. ${pack.id}-${index + 1}`;
    const noW = widthOf(g, noUp);
    text(g, fit(g, name.toUpperCase(), iw - 14 - noW - 8), ix + 7, y + pad + bandH / 2 + 0.5, 'left');
    text(g, noUp, ix + iw - 7, y + pad + bandH / 2 + 0.5, 'right');
    g.textBaseline = 'alphabetic';

    // foot first: it fixes where the body ends
    const footH = 64;
    const footY = y + h - pad - footH;
    strokeRound(g, ix, footY, iw, footH, [0, 0, 4, 4], r, 1.5);
    g.fillStyle = INK;
    font(g, `800 18px ${FONTS.display}`, -0.35);
    text(g, fmtUsd(pull.usdCents), ix + 8, footY + 24, 'left');
    g.fillStyle = INK2;
    font(g, `10.5px ${FONTS.mono}`, 0);
    text(g, fit(g, pull.amountText || '', iw - 16), ix + 8, footY + 40, 'left');
    barcode(g, ix + 8, footY + 47, iw - 16, 11, pull.symbol + pack.id + index);

    // body: the rarity rails, the mark, the ticker
    const bodyY = y + pad + bandH;
    const bodyH = footY - bodyY;
    line(g, ix + 0.75, bodyY, ix + 0.75, bodyY + bodyH, r, 1.5);
    line(g, ix + iw - 0.75, bodyY, ix + iw - 0.75, bodyY + bodyH, r, 1.5);

    const hasName = !!pull.name;
    const blockH = 54 + 10 + 30 + (hasName ? 18 : 0);
    const top = bodyY + (bodyH - blockH) / 2;
    drawLogo(g, logo, pull.symbol, x + w / 2, top + 27, 54);
    g.fillStyle = INK;
    let size = 34;
    font(g, `800 ${size}px ${FONTS.display}`, -1.5);
    while (size > 16 && widthOf(g, pull.symbol) > iw - 16) {
      size -= 2;
      font(g, `800 ${size}px ${FONTS.display}`, -1.5);
    }
    text(g, pull.symbol, x + w / 2, top + 54 + 10 + 26, 'center');
    if (hasName) {
      g.fillStyle = INK2;
      font(g, `italic 12px ${FONTS.serif}`, 0);
      text(g, fit(g, pull.name, iw - 12), x + w / 2, top + 54 + 10 + 44, 'center');
    }
  }

  // ---------------------------------------------------------------------------
  // The card
  // ---------------------------------------------------------------------------
  async function renderCard(pack, opts) {
    if (!pack || !Array.isArray(pack.pulls) || !pack.pulls.length) throw new Error('nothing to share yet');
    const o = opts || {};
    const tiers = o.tiers || [];
    const tierColors = o.tierColors || TIER_COLORS;
    const siteUrl = o.siteUrl || SITE_URL;

    FONTS.display = cssVar('--display', '"Helvetica Neue", Helvetica, Arial, sans-serif');
    FONTS.serif = cssVar('--serif', 'Georgia, "Times New Roman", serif');
    FONTS.mono = cssVar('--mono', '"Courier New", Courier, monospace');
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* draw anyway */ } }

    const pulls = pack.pulls.slice(0, 5);
    const logos = await Promise.all(pulls.map((p) => (p.symbol === 'USDG' ? null : loadLogo(p.symbol))));

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    g.textBaseline = 'alphabetic';

    g.fillStyle = PAPER;
    g.fillRect(0, 0, W, H);

    // frame
    g.strokeStyle = INK; g.lineWidth = 3;
    g.strokeRect(25.5, 25.5, W - 51, H - 51);

    const L = 58, R = W - 58;

    // masthead
    g.fillStyle = INK;
    font(g, `800 46px ${FONTS.display}`, -1.4);
    text(g, 'STONK PACKS', L, 105, 'left');
    g.fillStyle = INK3;
    font(g, `12px ${FONTS.mono}`, 1.5);
    text(g, `SERIES 1 · ${pulls.length} CARDS · REAL TOKENIZED STOCK`, L + 2, 128, 'left');

    g.fillStyle = INK;
    font(g, `800 30px ${FONTS.display}`, -0.9);
    text(g, `Pack #${pack.id}`, R, 103, 'right');
    if (pack.demo) {
      g.save();
      font(g, `11px ${FONTS.mono}`, 1.6);
      const label = 'DEMO';
      const bw = widthOf(g, label) + 18, bh = 24;
      g.translate(R - bw / 2, 128);
      g.rotate(-2 * Math.PI / 180);
      g.strokeStyle = INK3; g.lineWidth = 1.5;
      g.strokeRect(-bw / 2 + 0.75, -bh / 2 + 0.75, bw - 1.5, bh - 1.5);
      g.fillStyle = INK3;
      g.textBaseline = 'middle';
      text(g, label, 0, 1, 'center');
      g.restore();
      g.textBaseline = 'alphabetic';
    }

    // double rule, like the masthead's
    line(g, L, 152.5, R, 152.5, INK, 1);
    line(g, L, 157.5, R, 157.5, INK, 1);

    // the five cards
    const gap = 18;
    const cardW = (R - L - gap * 4) / 5;
    const cardH = Math.round(cardW * 1.4);
    const cardY = 180;
    pulls.forEach((p, i) => {
      drawCard(g, { x: Math.round(L + i * (cardW + gap)), y: cardY, w: Math.round(cardW), h: cardH }, p, logos[i], i, pack, tiers, tierColors);
    });

    // the take
    const footTop = cardY + cardH + 32;
    line(g, L, footTop, R, footTop, RULE, 1);
    const total = Number(pack.totalCents || pulls.reduce((s, p) => s + (p.usdCents || 0), 0));
    g.fillStyle = INK3;
    font(g, `12px ${FONTS.mono}`, 1.6);
    text(g, 'TOTAL PULLED', L + 2, footTop + 26, 'left');
    g.fillStyle = GREEN_INK;
    font(g, `800 62px ${FONTS.display}`, -2.4);
    const totalW = text(g, fmtUsd(total), L, footTop + 82, 'left');
    g.fillStyle = INK2;
    font(g, `italic 20px ${FONTS.serif}`, 0);
    text(g, `in stocks, from ${pulls.length} pulls.`, L + totalW + 16, footTop + 82, 'left');

    // the address, bottom right, set like the ticker tape
    font(g, `800 15px ${FONTS.display}`, 1.2);
    const urlText = siteUrl.toUpperCase();
    const chipW = widthOf(g, urlText) + 28, chipH = 38;
    const chipX = R - chipW, chipY = footTop + 44;
    g.fillStyle = GREEN;
    g.fillRect(chipX + 4, chipY + 4, chipW, chipH);
    g.fillStyle = INK;
    g.fillRect(chipX, chipY, chipW, chipH);
    g.fillStyle = PAPER;
    g.textBaseline = 'middle';
    text(g, urlText, chipX + chipW / 2, chipY + chipH / 2 + 1, 'center');
    g.textBaseline = 'alphabetic';

    grain(g);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not export the card'))), 'image/png');
    });
  }

  global.SHARE = { renderCard };
})(window);
