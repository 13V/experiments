'use strict';
/**
 * Stonk Packs live feed. Static, no dependencies, no build step.
 * Contract mode: polls `revealed()` and scans `Opened`/`Pull` logs for a stats strip,
 * a "latest pulls" list, and (once real pulls exist) takes over the ticker tape.
 * Demo mode (no contract deployed yet): the same strip and list, fed by the
 * `stonk:opened` event app.js fires after each demo pack, persisted in localStorage
 * so it survives a reload. The tape is left alone in demo mode.
 * Every RPC call is wrapped so a bad or slow node degrades the view, never the page.
 */
(function (global) {
  const C = global.STONK_CONFIG || {};
  const SP = global.SP;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

  const DEFAULTS = { logChunkBlocks: 50000, maxScanBlocks: 3000000, refreshMs: 20000, maxRows: 12, demoStorageKey: 'stonkpacks:demo-feed', demoMaxRows: 50 };
  const FEED_CFG = Object.assign({}, DEFAULTS, C.feed || {});
  const CONTRACT = /^0x[0-9a-fA-F]{40}$/.test(C.contract || '') ? C.contract : null;
  const MYTHIC_TIER = Array.isArray(C.tiers) && C.tiers.length ? C.tiers.length - 1 : 5;

  const tierName = (i) => (Array.isArray(C.tiers) && C.tiers[i] && C.tiers[i].name) || TIER_NAMES[i] || `Tier ${Number(i) + 1}`;
  const symbolFor = (addr) => (addr && C.symbols && C.symbols[addr.toLowerCase()]) || (SP && SP.shortAddr ? SP.shortAddr(addr) : String(addr));

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  // ---------------------------------------------------------------------------
  // Rendering (shared by chain and demo mode)
  // ---------------------------------------------------------------------------
  function setTag(text, ok) {
    const el = $('live-tag');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
  }

  function statHtml(k, v) {
    return `<div class="stat"><div class="k">${esc(k)}</div><div class="v v-big">${esc(v)}</div></div>`;
  }
  function renderStats(vals) {
    const el = $('live-stats');
    if (!el) return;
    el.innerHTML = statHtml('Packs ripped', vals.packs) + statHtml('Paid out', vals.paid) + statHtml('Top pull', vals.top) + statHtml('Mythics found', vals.mythics);
  }

  const seenKeys = new Set();
  function rowHtml(p, isNew) {
    const tier = Math.min(Number(p.tier) || 0, 5);
    const symbol = p.symbol || 'USDG';
    const isCash = symbol === 'USDG';
    const looksLikeTicker = /^[A-Z0-9.]{1,8}$/.test(symbol);
    const logo = isCash
      ? `<div class="feed-logo cash">$</div>`
      : looksLikeTicker
        ? `<img class="feed-logo" src="${esc(C.logoPath || 'logos/')}${esc(symbol)}.png" alt="" loading="lazy" onerror="this.remove()">`
        : `<div class="feed-logo cash">&#9670;</div>`;
    const who = p.holder === 'you' ? 'you' : p.holder ? SP.shortAddr(p.holder) : 'someone';
    return (
      `<div class="feed-row${isNew ? ' feed-in' : ''}" style="--r:var(--r-${tier})">` +
      logo +
      `<div class="feed-main">` +
      `<div class="feed-sym">${esc(symbol)} <span class="feed-usd">${SP.fmtUsd(p.usdCents)}</span></div>` +
      `<div class="feed-tier">${esc(tierName(p.tier))}</div>` +
      `</div>` +
      `<div class="feed-who"><div class="feed-addr">${esc(who)}</div><div class="feed-time">${esc(timeAgo(p.ts))}</div></div>` +
      `</div>`
    );
  }
  function renderList(rows) {
    const el = $('live-list');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = `<p class="feed-empty">${CONTRACT ? 'No pulls yet. Waiting on the chain.' : 'No pulls yet. Rip a demo pack to get on the board.'}</p>`;
      return;
    }
    el.innerHTML = rows.map((p) => rowHtml(p, !seenKeys.has(p.key))).join('');
    rows.forEach((p) => seenKeys.add(p.key));
  }

  function renderTapeFrom(rows) {
    const tapeEl = $('tape');
    if (!tapeEl || !rows.length) return;
    const items = rows.map((p) => `<span>${esc(p.holder ? SP.shortAddr(p.holder) : 'someone')} pulled <b>${SP.fmtUsd(p.usdCents)}</b> ${esc(p.symbol)} &middot; ${esc(tierName(p.tier))}</span>`);
    const half = items.join('');
    tapeEl.innerHTML = half + half;
  }

  // ---------------------------------------------------------------------------
  // Chain mode: revealed() + Opened/Pull log scan, cached in memory, refreshed
  // every FEED_CFG.refreshMs by scanning only the blocks since the last pass.
  // ---------------------------------------------------------------------------
  const pullsById = new Map();
  const openedByPack = new Map();
  const blockTsCache = new Map();
  let lastScannedTo = null;
  let scanning = false;

  async function safeRpc(method, params) {
    try { return await SP.rpc(C.rpc, method, params); } catch { return null; }
  }
  async function safeLatestBlock() {
    const hex = await safeRpc('eth_blockNumber', []);
    return hex != null ? parseInt(hex, 16) : null;
  }
  async function safeLogs(fromNum, toNum) {
    const logs = await safeRpc('eth_getLogs', [{
      address: CONTRACT,
      fromBlock: '0x' + Math.max(0, fromNum).toString(16),
      toBlock: '0x' + Math.max(0, toNum).toString(16),
      topics: [[SP.EVENTS.Opened, SP.EVENTS.Pull]],
    }]);
    return Array.isArray(logs) ? logs : [];
  }
  async function safeRevealed() {
    const data = await safeRpc('eth_call', [{ to: CONTRACT, data: SP.encodeCall('revealed()') }, 'latest']);
    if (data == null) return null;
    try { const w = SP.words(data); return w.length ? Number(SP.toBig(w[0])) : null; } catch { return null; }
  }

  function ingestLogs(logs) {
    for (const log of logs) {
      let dec = null;
      try { dec = SP.decodeLog(log); } catch { dec = null; }
      if (!dec) continue;
      if (dec.name === 'Opened') {
        openedByPack.set(dec.packId.toString(), { to: dec.to });
      } else if (dec.name === 'Pull') {
        const key = (log.transactionHash || '') + ':' + (log.logIndex != null ? log.logIndex : dec.index);
        if (pullsById.has(key)) continue;
        pullsById.set(key, {
          key,
          packId: dec.packId.toString(),
          tier: dec.tier,
          symbol: dec.cash ? 'USDG' : symbolFor(dec.token),
          usdCents: dec.usdCents,
          blockNumber: log.blockNumber,
          blockNum: log.blockNumber ? parseInt(log.blockNumber, 16) : 0,
          logIdx: log.logIndex != null ? parseInt(log.logIndex, 16) : 0,
          holder: null,
          ts: null,
        });
      }
    }
    for (const p of pullsById.values()) {
      if (!p.holder) {
        const o = openedByPack.get(p.packId);
        if (o) p.holder = o.to;
      }
    }
  }

  async function initialScan(latest) {
    const deploy = Number(C.deployBlock) || 0;
    const chunk = FEED_CFG.logChunkBlocks;
    let to = latest, scanned = 0;
    while (to >= deploy && scanned < FEED_CFG.maxScanBlocks) {
      const from = Math.max(deploy, to - chunk + 1);
      ingestLogs(await safeLogs(from, to));
      scanned += to - from + 1;
      to = from - 1;
    }
  }
  async function incrementalScan(fromExclusive, latest) {
    const chunk = FEED_CFG.logChunkBlocks;
    let from = fromExclusive + 1;
    while (from <= latest) {
      const to = Math.min(latest, from + chunk - 1);
      ingestLogs(await safeLogs(from, to));
      from = to + 1;
    }
  }

  function computeChainSnapshot() {
    const all = Array.from(pullsById.values());
    let paidTotal = 0, top = null, mythics = 0;
    for (const p of all) {
      paidTotal += p.usdCents;
      if (!top || p.usdCents > top.usdCents) top = p;
      if (Number(p.tier) === MYTHIC_TIER) mythics++;
    }
    const latest = all.slice().sort((a, b) => b.blockNum - a.blockNum || b.logIdx - a.logIdx).slice(0, FEED_CFG.maxRows);
    return { all, paidTotal, top, mythics, latest };
  }

  async function ensureBlockTimestamps(rows) {
    const need = [];
    for (const r of rows) if (r.blockNumber && !blockTsCache.has(r.blockNumber) && need.indexOf(r.blockNumber) === -1) need.push(r.blockNumber);
    await Promise.all(need.map(async (bn) => {
      const blk = await safeRpc('eth_getBlockByNumber', [bn, false]);
      if (blk && blk.timestamp) blockTsCache.set(bn, parseInt(blk.timestamp, 16) * 1000);
    }));
    for (const r of rows) r.ts = blockTsCache.has(r.blockNumber) ? blockTsCache.get(r.blockNumber) : r.ts || Date.now();
  }

  async function chainTick() {
    if (scanning) return;
    scanning = true;
    try {
      const latest = await safeLatestBlock();
      if (latest != null) {
        if (lastScannedTo == null) await initialScan(latest);
        else if (latest > lastScannedTo) await incrementalScan(lastScannedTo, latest);
        lastScannedTo = latest;
      }
      const revealed = await safeRevealed();
      const snap = computeChainSnapshot();
      await ensureBlockTimestamps(snap.latest);
      renderStats({
        packs: revealed != null ? revealed.toLocaleString('en-US') : '—',
        paid: snap.all.length ? SP.fmtUsd(snap.paidTotal) : '—',
        top: snap.top ? `${SP.fmtUsd(snap.top.usdCents)} ${snap.top.symbol}` : '—',
        mythics: snap.all.length ? snap.mythics.toLocaleString('en-US') : '—',
      });
      renderList(snap.latest);
      if (snap.latest.length) renderTapeFrom(snap.latest);
      setTag('on-chain', true);
    } catch { /* degrade to whatever we already have; never throw */ }
    scanning = false;
  }

  // ---------------------------------------------------------------------------
  // Demo mode: no chain, just the `stonk:opened` events this browser fired.
  // ---------------------------------------------------------------------------
  let demoPulls = [];

  function loadDemo() {
    try {
      const raw = localStorage.getItem(FEED_CFG.demoStorageKey);
      const arr = raw ? JSON.parse(raw) : [];
      demoPulls = Array.isArray(arr) ? arr : [];
    } catch { demoPulls = []; }
  }
  function saveDemo() {
    try { localStorage.setItem(FEED_CFG.demoStorageKey, JSON.stringify(demoPulls.slice(0, FEED_CFG.demoMaxRows))); } catch { /* private mode or full quota: keep going in memory */ }
  }

  function renderDemo() {
    let paidTotal = 0, top = null, mythics = 0;
    const packs = new Set();
    for (const p of demoPulls) {
      paidTotal += p.usdCents;
      if (!top || p.usdCents > top.usdCents) top = p;
      if (Number(p.tier) === MYTHIC_TIER) mythics++;
      packs.add(p.groupId);
    }
    renderStats({
      packs: demoPulls.length ? packs.size.toLocaleString('en-US') : '—',
      paid: demoPulls.length ? SP.fmtUsd(paidTotal) : '—',
      top: top ? `${SP.fmtUsd(top.usdCents)} ${top.symbol}` : '—',
      mythics: demoPulls.length ? mythics.toLocaleString('en-US') : '—',
    });
    renderList(demoPulls.slice(0, FEED_CFG.maxRows));
  }

  function onOpened(e) {
    try {
      const pack = e && e.detail;
      if (!pack || !Array.isArray(pack.pulls) || !pack.pulls.length) return;
      const groupId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const ts = Date.now();
      const records = pack.pulls.map((p, i) => ({ key: `${groupId}-${i}`, groupId, tier: p.tier, symbol: p.symbol || 'USDG', usdCents: p.usdCents, holder: 'you', ts }));
      demoPulls = records.concat(demoPulls).slice(0, FEED_CFG.demoMaxRows);
      saveDemo();
      renderDemo();
    } catch { /* never throw from an event handler */ }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  let started = false;
  function init() {
    if (started) return;
    started = true;
    if (!$('live')) return;
    renderStats({ packs: '—', paid: '—', top: '—', mythics: '—' });
    renderList([]);
    if (CONTRACT) {
      setTag('scanning…', false);
      chainTick();
      setInterval(chainTick, FEED_CFG.refreshMs);
    } else {
      setTag('demo', false);
      loadDemo();
      renderDemo();
      global.addEventListener('stonk:opened', onOpened);
      setInterval(renderDemo, FEED_CFG.refreshMs);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  global.FEED = { init };
})(window);
