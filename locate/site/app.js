'use strict';
/**
 * Locate — app shell, router, wallet, and the four views.
 * No build step, no dependencies. Everything talks to the chain through LOC (lib.js).
 */
(function () {
  const L = window.LOC;
  const { rpc, ethCall, encodeCall, decodeWords, toBig, toAddr, marketParamsTuple,
    fmtToken, parseAmount, fmtUsd, fmtPct, fmtNum, shortAddr, fmtHf, describeError, sameAddr } = L;

  const DEX_CHAIN = 'robinhood'; // confirmed by curling DexScreener for the NVDA token in markets.json
  const STOCK_DECIMALS = 18;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const STATE = {
    addresses: null,
    markets: null,
    account: null,
    quotes: null,
    quotesTs: 0,
    quotesUnavailable: false,
    dexCache: new Map(),   // lower(address) -> { ts, data: {priceUsd,liqUsd,vol24,dexId,url,pairCount} | null }
    marketCache: new Map(),// symbol -> Promise<onchain data | null>
    route: 'markets',
  };
  window.LOCATE_STATE = STATE; // inspection hook, harmless

  // ================================================================== DOM helper
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  /**
   * A monitor panel — the one kind of box the desk has. A 34px chrome bar (cyan tab, title,
   * right-aligned meta) the way scene.js's own `chrome()` painter draws it, then whatever body
   * content follows. `title`/`meta` are plain strings or nodes; extra args are appended as the
   * panel's body verbatim, so a table, a stat row, or a form all live in the same shell.
   */
  function pnl(title, meta, ...body) {
    const bar = h('div', { class: 'pnl-bar' },
      h('span', { class: 'pnl-title' }, title),
      (meta === null || meta === undefined) ? null : h('span', { class: 'pnl-meta' }, meta));
    return h('section', { class: 'pnl' }, bar, ...body);
  }
  /** A padded content block inside a panel (tables and the chart pane manage their own insets). */
  const pad = (...children) => h('div', { class: 'pnl-pad' }, ...children);
  /** The dim, uppercase explainer line every screen prints at the foot of its panel. */
  const foot = (...content) => h('div', { class: 'pnl-foot' }, ...content);
  /** A caption-over-value pair, the way the scene sets a DIM label above a big number. */
  function kstat(label) {
    const val = h('div', { class: 'kval skel' });
    return { el: h('div', { class: 'kstat' }, h('div', { class: 'klabel' }, label), val), val };
  }
  /** One term-sheet row: label, dotted leader, value. */
  const lrow = (label, value) => h('div', { class: 'lrow' }, h('dt', {}, label), h('span', { class: 'lead', 'aria-hidden': 'true' }), h('dd', {}, value));
  /** Utilisation as a ten-cell text bar, e.g. ▮▮▮▮▯▯▯▯▯▯ 41.2%. */
  function ubar(u) {
    const n = Math.max(0, Math.min(10, Math.round(u * 10)));
    return h('span', { class: 'ubar' }, '▮'.repeat(n) + '▯'.repeat(10 - n), h('b', {}, fmtPct(u)));
  }
  const premClass = (p) => 'num' + (p === null || p === undefined ? '' : (p > 0 ? ' pos' : p < 0 ? ' neg' : '') + (Math.abs(p) > 0.05 ? ' hot' : ''));
  /** A cell value. `cls` maps to a tone: dim, pos, neg. */
  const TONE = { dim: 'dim', green: 'pos', red: 'neg', yellow: '' };
  const tile = (text, cls) => h('span', { class: ('v ' + (TONE[cls] ?? cls ?? '')).trim() }, text);
  const skel = () => h('span', { class: 'v skel' });
  /** Sets a cell's value (and an optional numeric sort key). */
  function setTile(td, text, sortValue) {
    let t = td.querySelector('.v');
    if (!t) { clear(td); t = tile(''); td.appendChild(t); }
    t.classList.remove('skel');
    if (t.textContent !== text) t.textContent = text;
    if (sortValue !== undefined && sortValue !== null && !Number.isNaN(sortValue)) td.dataset.v = String(sortValue);
  }
  /** A board/tape row's identity cell: ticker only, exactly what the scene's own screens show —
   *  no logo, no second line. The full name still reaches assistive tech via the cell's title. */
  const symCell = (symbol, name) => h('td', { class: 'sym', title: name || '' }, symbol);
  /** Click a column heading to sort; cells sort by data-v when present, else by their text. */
  function makeSortable(table) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    ths.forEach((th, i) => {
      if (th.dataset.nosort !== undefined) return;
      th.classList.add('sortable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      const key = (tr) => {
        const td = tr.children[i];
        if (!td) return null;
        if (td.dataset.v !== undefined && td.dataset.v !== '') return Number(td.dataset.v);
        const t = td.textContent.trim();
        const n = Number(t.replace(/[^0-9.+-]/g, ''));
        return /\d/.test(t) && !Number.isNaN(n) ? n : (t || null);
      };
      const go = () => {
        const dir = th.dataset.dir === 'desc' ? 'asc' : 'desc';
        ths.forEach((o) => o.removeAttribute('data-dir'));
        th.dataset.dir = dir;
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.children);
        rows.sort((a, b) => {
          const ka = key(a), kb = key(b);
          if (ka === kb) return 0;
          if (ka === null) return 1;
          if (kb === null) return -1;
          if (typeof ka !== typeof kb) return typeof ka === 'number' ? -1 : 1;
          if (typeof ka === 'number') return dir === 'asc' ? ka - kb : kb - ka;
          return dir === 'asc' ? ka.localeCompare(kb) : kb.localeCompare(ka);
        });
        rows.forEach((r, n) => { tbody.appendChild(r); const idx = r.querySelector('td.idx'); if (idx) idx.textContent = String(n + 1); });
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  // ================================================================== toasts
  let toastSeq = 0;
  function renderToastBody(box, { kind, title, body, link, linkText }) {
    box.className = `toast ${kind}`;
    clear(box);
    box.appendChild(h('div', { class: 't-title' }, title));
    if (body) box.appendChild(h('div', {}, body));
    if (link) box.appendChild(h('div', {}, h('a', { href: link, target: '_blank', rel: 'noopener' }, linkText || 'view on explorer')));
  }
  function toast(opts) {
    const id = ++toastSeq;
    const box = h('div', { id: `toast-${id}` });
    renderToastBody(box, opts);
    document.getElementById('toasts').appendChild(box);
    if (opts.kind !== 'pending') setTimeout(() => box.remove(), opts.kind === 'error' ? 9000 : 6000);
    return id;
  }
  function updateToast(id, opts) {
    const box = document.getElementById(`toast-${id}`);
    if (!box) { toast(opts); return; }
    renderToastBody(box, opts);
    if (opts.kind !== 'pending') setTimeout(() => box.remove(), opts.kind === 'error' ? 9000 : 6000);
  }

  // ================================================================== wallet
  async function connectWallet() {
    if (!window.ethereum) {
      toast({ kind: 'error', title: 'no wallet found', body: 'install a browser wallet extension, then reload.' });
      return;
    }
    try {
      const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      STATE.account = accs[0] || null;
      await ensureChain();
      updateWalletUI();
      navigate(); // re-render the current view now that we have an account
    } catch (e) {
      toast({ kind: 'error', title: 'connect failed', body: describeError(e) });
    }
  }

  async function ensureChain() {
    const hex = '0x' + STATE.addresses.chainId.toString(16);
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    if (String(cur).toLowerCase() === hex.toLowerCase()) return true;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      return true;
    } catch (switchErr) {
      if (switchErr && (switchErr.code === 4902 || /unrecognized chain/i.test(describeError(switchErr)))) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hex,
            chainName: 'Robinhood Chain',
            rpcUrls: [STATE.addresses.rpc],
            blockExplorerUrls: [STATE.addresses.explorer],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          }],
        });
        return true;
      }
      toast({ kind: 'error', title: 'wrong network', body: describeError(switchErr) });
      return false;
    }
  }

  async function updateWalletUI() {
    const seg = document.getElementById('s-wallet');
    clear(seg);
    if (!STATE.account) {
      seg.appendChild(h('button', { class: 'ghost', onclick: connectWallet }, 'Connect wallet'));
      return;
    }
    seg.appendChild(h('span', { class: 'dim' }, shortAddr(STATE.account)));
    const balSpan = h('span', { class: 'amber' }, ' …');
    seg.appendChild(h('span', {}, ' USDG '));
    seg.appendChild(balSpan);
    try {
      const data = await ethCall(STATE.addresses.rpc, STATE.addresses.usdg, encodeCall('balanceOf(address)', STATE.account));
      const bal = toBig(decodeWords(data)[0]);
      balSpan.textContent = fmtToken(bal, STATE.addresses.usdgDecimals, 2);
    } catch { balSpan.textContent = '—'; }
  }

  function wireWalletEvents() {
    if (!window.ethereum || !window.ethereum.on) return;
    window.ethereum.on('accountsChanged', (accs) => {
      STATE.account = accs && accs[0] ? accs[0] : null;
      updateWalletUI();
      navigate();
    });
    window.ethereum.on('chainChanged', () => location.reload());
  }

  async function sendTx({ to, data, title }) {
    if (!STATE.account) throw new Error('connect wallet first');
    const id = toast({ kind: 'pending', title: title || 'sending…', body: 'confirm in wallet' });
    try {
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: STATE.account, to, data }] });
      const link = STATE.addresses.explorer + '/tx/' + hash;
      updateToast(id, { kind: 'pending', title: title || 'submitted', body: shortAddr(hash), link, linkText: 'view tx' });
      const receipt = await waitReceipt(hash);
      const ok = receipt && (receipt.status === '0x1' || receipt.status === 1);
      updateToast(id, { kind: ok ? 'success' : 'error', title: ok ? (title ? title + ' — confirmed' : 'confirmed') : 'reverted', body: shortAddr(hash), link, linkText: 'view tx' });
      if (!ok) throw new Error('transaction reverted on-chain');
      return receipt;
    } catch (e) {
      updateToast(id, { kind: 'error', title: 'failed', body: describeError(e) });
      throw e;
    }
  }
  async function waitReceipt(hash) {
    for (let i = 0; i < 150; i++) {
      const r = await rpc(STATE.addresses.rpc, 'eth_getTransactionReceipt', [hash]);
      if (r) return r;
      await sleep(2000);
    }
    throw new Error('timed out waiting for a receipt');
  }
  async function ensureAllowance(tokenAddr, spender, neededRaw, label) {
    if (neededRaw <= 0n) return;
    const data = await ethCall(STATE.addresses.rpc, tokenAddr, encodeCall('allowance(address,address)', STATE.account, spender));
    const current = toBig(decodeWords(data)[0]);
    if (current >= neededRaw) return;
    await sendTx({ to: tokenAddr, data: encodeCall('approve(address,uint256)', spender, neededRaw), title: `approve ${label}` });
  }
  function toAssetsUp(shares, totalAssets, totalShares) {
    const num = shares * (totalAssets + 1n);
    const den = totalShares + 1000000n; // VIRTUAL_SHARES, per SPEC §2
    return (num + den - 1n) / den;
  }

  // ================================================================== quotes proxy (Robinhood, no CORS)
  let quotesNoticeLogged = false;
  let quotesInFlight = null;
  async function fetchQuotes(force) {
    // One request at a time: every view that asks while a fetch is in flight awaits that same
    // fetch (boot warms the cache, so the first view would otherwise see an empty result).
    // After that, one attempt per 15s (matching the function's own s-maxage) whether it
    // succeeded or failed — locally without `vercel dev` this also stops the browser's own
    // resource-fail logging from repeating on every call.
    if (quotesInFlight) return quotesInFlight;
    const attemptedRecently = STATE.quotesLastAttempt && (Date.now() / 1000 - STATE.quotesLastAttempt) < 15;
    if (attemptedRecently && !force) return STATE.quotes || { assets: [], prices: [] };
    STATE.quotesLastAttempt = Date.now() / 1000;
    quotesInFlight = (async () => {
      try {
        const res = await fetch('/api/quotes');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        STATE.quotes = data;
        STATE.quotesTs = data.ts || Date.now() / 1000;
        STATE.quotesUnavailable = false;
      } catch (e) {
        STATE.quotesUnavailable = true;
        if (!STATE.quotes) STATE.quotes = { assets: [], prices: [] };
        // Deliberately console.info, not console.error: this is an expected, fully-handled
        // state when running locally without `vercel dev` (see the notice on Markets/Premium),
        // not a real failure. Logged once so it's still visible while debugging.
        if (!quotesNoticeLogged) { console.info('[locate] /api/quotes unavailable (expected without `vercel dev`) — DEX prices still load.'); quotesNoticeLogged = true; }
      } finally {
        quotesInFlight = null;
      }
      return STATE.quotes;
    })();
    return quotesInFlight;
  }
  function quoteFor(symbol) {
    const row = (STATE.quotes?.prices || []).find((p) => p.tokenSymbol === symbol);
    if (!row) return null;
    const bid = parseFloat(row.bid), ask = parseFloat(row.ask);
    return { bid, ask, mid: (bid + ask) / 2, halted: !!row.isTradingHalt, volume: parseFloat(row.dailyTradingVolume || '0') };
  }

  // ================================================================== DexScreener (browser, CORS: *)
  /**
   * `/latest/dex/tokens/<addr(s)>` caps every response at 30 pairs TOTAL — confirmed by
   * direct testing (even a single-address query for NVDA alone returns exactly 30, and a
   * batch of any size never returns more). So a batch reply that comes back exactly 30
   * pairs long may be silently missing pairs for some of the requested addresses; anything
   * absent from such a reply is re-checked one address at a time before we call it "no
   * pool" — a solo query for one address is ground truth since none of these tokens has
   * anywhere near 30 pairs once you're not sharing the cap with 7-30 other addresses.
   */
  async function dexFetchRaw(addrs) {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs.join(',')}`);
    if (!res.ok) throw new Error('dexscreener HTTP ' + res.status);
    const body = await res.json();
    return (body.pairs || []).filter((p) => p.chainId === DEX_CHAIN);
  }
  function summarize(addrLower, pairs) {
    const mine = pairs.filter((p) => p.baseToken.address.toLowerCase() === addrLower);
    if (!mine.length) return null;
    const best = mine.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
    const vol24 = mine.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
    const chg24 = best.priceChange && best.priceChange.h24 !== undefined ? Number(best.priceChange.h24) : null;
    return { priceUsd: Number(best.priceUsd), liqUsd: best.liquidity?.usd || 0, vol24, chg24, dexId: best.dexId, url: best.url, pairCount: mine.length };
  }
  let dexApiAvailable = true; // false after a 404: plain static hosting without the Vercel function
  async function fetchDexViaApi(addrs, onProgress) {
    const result = new Map();
    if (!addrs.length) return result;   // an empty address list is a 400 from the function
    const chunks = [];
    for (let i = 0; i < addrs.length; i += 60) chunks.push(addrs.slice(i, i + 60));
    let done = 0;
    for (const chunk of chunks) {
      const res = await fetch('/api/dex?addrs=' + chunk.map((a) => a.toLowerCase()).join(','));
      if (res.status === 404) { dexApiAvailable = false; throw new Error('no /api/dex'); }
      if (!res.ok) throw new Error('dex api HTTP ' + res.status);
      const body = await res.json();
      for (const addr of chunk) {
        const key = addr.toLowerCase();
        result.set(key, Object.prototype.hasOwnProperty.call(body.pools || {}, key) ? body.pools[key] : undefined);
      }
      done += chunk.length;
      if (onProgress) onProgress(done, addrs.length);
    }
    return result;
  }
  async function fetchDexForAddresses(addrs, opts = {}) {
    if (!addrs || !addrs.length) return new Map();
    if (dexApiAvailable) {
      try { return await fetchDexViaApi(addrs, opts.onProgress); }
      catch (e) { if (dexApiAvailable) console.warn('[locate] /api/dex failed, falling back to direct DexScreener calls', e); }
    }
    return fetchDexDirect(addrs, opts);
  }
  async function fetchDexDirect(addrs, { batchSize = 8, onProgress } = {}) {
    const result = new Map();
    const batches = [];
    for (let i = 0; i < addrs.length; i += batchSize) batches.push(addrs.slice(i, i + batchSize));
    const uncertain = [];
    // total is fixed up front and progress is just how many addresses have a final answer
    // in `result` — monotonic and accurate whether or not a given batch hit the 30-pair cap.
    const total = addrs.length;
    const report = () => { if (onProgress) onProgress(result.size, total); };
    for (const batch of batches) {
      try {
        const pairs = await dexFetchRaw(batch);
        const capped = pairs.length >= 30;
        for (const addr of batch) {
          const key = addr.toLowerCase();
          const s = summarize(key, pairs);
          if (s) result.set(key, s);
          else if (capped) uncertain.push(addr);
          else result.set(key, null);
        }
      } catch { uncertain.push(...batch); }
      report();
    }
    for (const addr of uncertain) {
      const key = addr.toLowerCase();
      try {
        const pairs = await dexFetchRaw([addr]);
        result.set(key, summarize(key, pairs));
      } catch { result.set(key, undefined); /* checked, but genuinely unreachable right now */ }
      report();
    }
    return result;
  }
  async function ensureDexData(addrs, opts) {
    const now = Date.now();
    const need = addrs.filter((a) => { const c = STATE.dexCache.get(a.toLowerCase()); return !c || now - c.ts > 20000; });
    if (need.length) {
      const fresh = await fetchDexForAddresses(need, opts);
      for (const [k, v] of fresh) STATE.dexCache.set(k, { ts: now, data: v });
    }
    const out = new Map();
    for (const a of addrs) { const c = STATE.dexCache.get(a.toLowerCase()); if (c) out.set(a.toLowerCase(), c.data); }
    return out;
  }

  // ================================================================== on-chain reads
  function isDeployed(m) { return !!(m.oracle && m.marketId); }
  function mpFor(m) {
    return { loanToken: m.token, collateralToken: STATE.addresses.usdg, oracle: m.oracle, irm: STATE.addresses.adaptiveCurveIrm, lltv: BigInt(m.lltvBps) * 10n ** 14n };
  }
  async function readMarketTotals(m) {
    const data = await ethCall(STATE.addresses.rpc, STATE.addresses.morpho, encodeCall('market(bytes32)', m.marketId));
    const w = decodeWords(data);
    return { totalSupplyAssets: toBig(w[0]), totalSupplyShares: toBig(w[1]), totalBorrowAssets: toBig(w[2]), totalBorrowShares: toBig(w[3]), lastUpdate: toBig(w[4]), fee: toBig(w[5]) };
  }
  async function readOraclePrice(oracle) {
    const data = await ethCall(STATE.addresses.rpc, oracle, encodeCall('price()'));
    return toBig(decodeWords(data)[0]);
  }
  /** oracle.price() is collateral(USDG)-in-loan(stock) terms per Morpho's IOracle convention
   *  (SPEC §2: "price of 1 unit of collateral in loan units"); for our USDG(6dp)/stock(18dp)
   *  markets that means humanStockPerUsdg = priceRaw / 1e48, so the human "$ per share" figure
   *  people actually want is the inverse: 1e48 / priceRaw. Derivation in the PR report. */
  function usdgPerStockFromOracle(priceRaw) { return 1e48 / Number(priceRaw); }

  function loadMarketOnchain(m) {
    if (STATE.marketCache.has(m.symbol)) return STATE.marketCache.get(m.symbol);
    const p = (async () => {
      try {
        const mp = mpFor(m);
        const t = await readMarketTotals(m);
        const rateData = await ethCall(
          STATE.addresses.rpc, STATE.addresses.adaptiveCurveIrm,
          encodeCall(
            'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
            marketParamsTuple(mp),
            [t.totalSupplyAssets, t.totalSupplyShares, t.totalBorrowAssets, t.totalBorrowShares, t.lastUpdate, t.fee]
          )
        );
        const ratePerSecondWad = toBig(decodeWords(rateData)[0]);
        const borrowApy = Math.exp((Number(ratePerSecondWad) / 1e18) * 31536000) - 1;
        const utilisation = t.totalSupplyAssets > 0n ? Number(t.totalBorrowAssets) / Number(t.totalSupplyAssets) : 0;
        const supplyApy = borrowApy * utilisation; // fee 0, per SPEC §7
        const availableRaw = t.totalSupplyAssets > t.totalBorrowAssets ? t.totalSupplyAssets - t.totalBorrowAssets : 0n;
        const priceRaw = await readOraclePrice(m.oracle);
        return { ...t, borrowApy, supplyApy, utilisation, availableRaw, priceRaw, usdgPerStock: usdgPerStockFromOracle(priceRaw) };
      } catch (e) {
        console.warn('on-chain read failed for', m.symbol, e);
        return null;
      }
    })();
    STATE.marketCache.set(m.symbol, p);
    return p;
  }

  /** Best price we can find right now: live oracle if the market exists, else DEX, else Robinhood quote. */
  async function getReferencePrice(m) {
    if (isDeployed(m)) {
      try { return { value: usdgPerStockFromOracle(await readOraclePrice(m.oracle)), source: 'oracle' }; } catch { /* fall through */ }
    }
    const dex = await ensureDexData([m.token]);
    const d = dex.get(m.token.toLowerCase());
    if (d) return { value: d.priceUsd, source: 'dex' };
    await fetchQuotes();
    const q = quoteFor(m.symbol);
    if (q) return { value: q.mid, source: 'quote' };
    return null;
  }

  async function getMorphoPosition(marketId, account) {
    const data = await ethCall(STATE.addresses.rpc, STATE.addresses.morpho, encodeCall('position(bytes32,address)', marketId, account));
    const w = decodeWords(data);
    return { supplyShares: toBig(w[0]), borrowShares: toBig(w[1]), collateral: toBig(w[2]) };
  }

  // ================================================================== router actions
  async function doOpenShort(m, collateralRaw, borrowRaw) {
    const mp = mpFor(m);
    const authData = await ethCall(STATE.addresses.rpc, STATE.addresses.morpho, encodeCall('isAuthorized(address,address)', STATE.account, STATE.addresses.router));
    if (toBig(decodeWords(authData)[0]) === 0n) {
      await sendTx({ to: STATE.addresses.morpho, data: encodeCall('setAuthorization(address,bool)', STATE.addresses.router, true), title: 'authorize router on Morpho' });
    }
    await ensureAllowance(STATE.addresses.usdg, STATE.addresses.router, collateralRaw, 'USDG');
    await sendTx({
      to: STATE.addresses.router,
      data: encodeCall('openShort((address,address,address,address,uint256),uint256,uint256,address)', marketParamsTuple(mp), collateralRaw, borrowRaw, STATE.account),
      title: `open ${m.symbol} short`,
    });
  }
  async function doAddCollateral(m, amountRaw) {
    const mp = mpFor(m);
    await ensureAllowance(STATE.addresses.usdg, STATE.addresses.router, amountRaw, 'USDG');
    await sendTx({ to: STATE.addresses.router, data: encodeCall('addCollateral((address,address,address,address,uint256),uint256)', marketParamsTuple(mp), amountRaw), title: `add collateral · ${m.symbol}` });
  }
  async function doRepayAmount(m, amountRaw) {
    const mp = mpFor(m);
    await ensureAllowance(m.token, STATE.addresses.router, amountRaw, m.symbol);
    await sendTx({ to: STATE.addresses.router, data: encodeCall('repay((address,address,address,address,uint256),uint256,uint256)', marketParamsTuple(mp), amountRaw, 0), title: `repay ${m.symbol}` });
  }
  async function doCloseShort(m) {
    const mp = mpFor(m);
    const pos = await getMorphoPosition(m.marketId, STATE.account);
    if (pos.borrowShares > 0n) {
      const t = await readMarketTotals(m);
      const est = toAssetsUp(pos.borrowShares, t.totalBorrowAssets, t.totalBorrowShares);
      const buffered = est + est / 100n + 1n; // +1% for interest accrued before the tx lands
      await ensureAllowance(m.token, STATE.addresses.router, buffered, m.symbol);
    }
    await sendTx({ to: STATE.addresses.router, data: encodeCall('closeShort((address,address,address,address,uint256),uint256,uint256,address)', marketParamsTuple(mp), 0, 0, STATE.account), title: `close ${m.symbol} short` });
  }

  // ================================================================== router
  /** Fills the hero's live counter and hands the scene real prices, whichever route you land on. */
  async function primeLive() {
    try {
      await fetchQuotes();
      const dex = await ensureDexData(STATE.markets.map((m) => m.token));
      const rows = [];
      for (const m of STATE.markets) {
        const q = quoteFor(m.symbol), d = dex.get(m.token.toLowerCase());
        if (q && d) rows.push({ symbol: m.symbol, name: m.name, quote: q.mid, dex: d.priceUsd, prem: (d.priceUsd - q.mid) / q.mid });
      }
      if (!rows.length) { const bar = document.getElementById('livebar'); if (bar) bar.style.display = 'none'; return; }
      const board = rows.slice().sort((a, b) => Math.abs(b.prem) - Math.abs(a.prem));
      if (window.LocateScene) window.LocateScene.setData(rows, board);
      paintLiveBar(rows.length, board[0]);
      primeFullBoard();   // the ten markets land immediately; the whole registry follows
    } catch (e) { const bar = document.getElementById('livebar'); if (bar) bar.style.display = 'none'; }
  }
  function paintLiveBar(count, top) {
    const n = document.getElementById('live-n'), w = document.getElementById('live-w');
    if (n) n.textContent = String(count);
    if (w && top) w.textContent = `${top.symbol} ${top.prem >= 0 ? '+' : ''}${fmtPct(top.prem)}`;
  }
  /** Every Robinhood token with a pool, fetched in the background so the hero can quote the real count. */
  async function primeFullBoard() {
    try {
      const q = STATE.quotes || {};
      const reg = [];
      for (const a of q.assets || []) {
        const dep = (a.deployments || []).find((x) => x.chainId === STATE.addresses.chainId);
        if (dep) reg.push({ symbol: a.tokenSymbol, addr: dep.contractAddress.toLowerCase() });
      }
      if (reg.length < 20) return;
      const dex = await ensureDexData(reg.map((r) => r.addr));
      const board = [];
      for (const r of reg) {
        const d = dex.get(r.addr), qq = quoteFor(r.symbol);
        if (d && qq) board.push({ symbol: r.symbol, quote: qq.mid, dex: d.priceUsd, prem: (d.priceUsd - qq.mid) / qq.mid });
      }
      if (board.length < 20) return;
      board.sort((a, b) => Math.abs(b.prem) - Math.abs(a.prem));
      if (window.LocateScene) window.LocateScene.setData(null, board);
      paintLiveBar(board.length, board[0]);
    } catch (e) { /* the ten-market number already shown is good enough */ }
  }

  const ROUTES = ['markets', 'lend', 'short', 'premium', 'm'];
  let currentCleanup = null;
  // which monitor each route lives on, so the camera lands somewhere that matches the content
  const POSE_FOR = { markets: 'markets', premium: 'premium', lend: 'desk', short: 'desk', m: 'desk' };
  // roughly where that monitor appears in the wide shot, so the panel grows out of the right screen
  const DOCK_ORIGIN = { markets: [0.50, 0.62], premium: [0.74, 0.62], desk: [0.26, 0.36] };
  function setActiveTab(tab) {
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === tab));
    const idx = ['markets', 'lend', 'short', 'premium'].indexOf(tab);
    document.querySelectorAll('#cmd-keys kbd').forEach((k, i) => k.classList.toggle('on', i === idx));
  }
  /** The prompt's working directory: the route, or the symbol for a market page. */
  function updateCmdPath() {
    const el = document.getElementById('cl-path');
    if (!el) return;
    el.textContent = STATE.route === 'm' ? `~/${(STATE.param || '').toLowerCase()}` : `~/${STATE.route || ''}`;
  }
  function navigate() {
    if (currentCleanup) { try { currentCleanup(); } catch { /* noop */ } currentCleanup = null; }
    const hashParts = location.hash.replace(/^#\/?/, '').split('?');
    const segs = hashParts[0].split('/');
    const raw = segs[0];
    STATE.query = new URLSearchParams(hashParts[1] || '');
    // no route at all means the wide shot: the hero is a route, not a separate page
    const hero = raw === '';
    const wasHero = !document.body.classList.contains('docked');
    document.body.classList.toggle('docked', !hero);
    const route = ROUTES.includes(raw) ? raw : 'markets';
    const pose = hero ? 'hero' : (POSE_FOR[route] || 'markets');
    if (window.LocateScene) window.LocateScene.setPose(pose);
    // Coming in from the wide shot: grow the UI out of the monitor the camera is flying at, so the
    // panel and the camera arrive together instead of the UI simply appearing over the top.
    if (!hero && wasHero) {
      const o = DOCK_ORIGIN[pose] || DOCK_ORIGIN.markets;
      // viewport pixels, not percentages: the app is taller than the screen, so a percentage of its
      // own height puts the origin below the fold and the zoom appears to come from nowhere
      document.body.style.setProperty('--dock-x', `${Math.round(innerWidth * o[0])}px`);
      document.body.style.setProperty('--dock-y', `${Math.round(innerHeight * o[1])}px`);
      document.body.classList.remove('zooming');
      void document.body.offsetWidth;   // restart the animation
      document.body.classList.add('zooming');
      clearTimeout(navigate._zoomT);
      navigate._zoomT = setTimeout(() => document.body.classList.remove('zooming'), 1250);
    }
    if (hero) {
      if (currentCleanup) { try { currentCleanup(); } catch (e) { /* noop */ } currentCleanup = null; }
      setActiveTab(null);
      return;
    }
    STATE.route = route;
    STATE.param = segs[1] ? decodeURIComponent(segs[1]) : null;
    const mode = route === 'lend' ? 'lend' : route === 'short' ? 'short' : (STATE.query.get('mode') === 'lend' ? 'lend' : 'short');
    setActiveTab(route === 'm' ? mode : route);
    updateCmdPath();
    const view = document.getElementById('view');
    clear(view);
    view.scrollTop = 0;
    const renderers = {
      markets: renderMarkets,
      premium: renderPremium,
      lend: (v) => renderMarket(v, 'lend'),
      short: (v) => renderMarket(v, 'short'),
      m: (v) => renderMarket(v, mode),
    };
    currentCleanup = renderers[route](view) || null;
  }

  // ================================================================== Markets view
  function renderMarkets(view) {
    const anyOpen = STATE.markets.some(isDeployed);
    const totalCap = STATE.markets.reduce((a, m) => a + (m.initialCapUsd || 0), 0);

    const vol = kstat('DEX VOLUME 24H');
    const widest = kstat('WIDEST PREMIUM');
    const median = kstat('MEDIAN PREMIUM');
    const quotes = kstat('ROBINHOOD QUOTES');
    const notice = h('div', { class: 'notice hidden' }, h('strong', {}, 'Quotes unavailable. '), 'This is a local copy without the /api/quotes function; DEX prices still load.');

    view.appendChild(pnl('MARKETS',
      anyOpen ? `${STATE.markets.length} MARKETS OPEN` : `OPENS SOON · ${STATE.markets.length} MARKETS · ${fmtUsd(totalCap, 0)} CAP`,
      pad(h('div', { class: 'krow' }, vol.el, widest.el, median.el, quotes.el), notice),
      foot('Borrow a stock against USDG, or lend yours and earn the borrow rate — select a row to open its market.')
    ));

    const table = h('table', { class: 'markets' + (anyOpen ? ' open' : '') });
    const cols = [
      ['Stock', ''], ['Quote', 'num'], ['DEX', 'num'], ['Premium', 'num'], ['24h', 'num'], ['Volume 24h', 'num'], ['LLTV', 'num'], [anyOpen ? 'Cap' : 'Cap at launch', 'num'],
      ...(anyOpen ? [['Borrow APY', 'num'], ['Supply APY', 'num'], ['Available', 'num'], ['Status', '']] : []),
    ];
    table.appendChild(h('thead', {}, h('tr', {}, ...cols.map(([t, c]) => h('th', { class: c }, t)))));
    const tbody = h('tbody');
    table.appendChild(tbody);

    view.appendChild(pnl('STOCK MARKETS', anyOpen ? null : 'SORT ANY COLUMN',
      h('div', { class: 'table-wrap' }, table),
      foot('Quote is Robinhood’s 24/5 price. DEX is the deepest Robinhood Chain pool on DexScreener; 24h and volume are that pool’s. Premium is DEX over quote.')
    ));
    makeSortable(table);

    const rows = new Map();
    for (const m of STATE.markets) {
      const go = () => { location.hash = `#/m/${m.symbol}`; };
      const r = {
        quoteC: h('td', { class: 'num' }, skel()),
        dexC: h('td', { class: 'num' }, skel()),
        premC: h('td', { class: 'num' }, skel()),
        chgC: h('td', { class: 'num' }, skel()),
        volC: h('td', { class: 'num' }, skel()),
      };
      const cells = [
        symCell(m.symbol, m.name), r.quoteC, r.dexC, r.premC, r.chgC, r.volC,
        h('td', { class: 'num', 'data-v': String(m.lltvBps) }, tile((m.lltvBps / 100).toFixed(1) + '%')),
        h('td', { class: 'num', 'data-v': String(m.initialCapUsd) }, tile(fmtUsd(m.initialCapUsd, 0), 'dim')),
      ];
      if (anyOpen) {
        const dep = isDeployed(m);
        r.borrowC = h('td', { class: 'num' }, dep ? skel() : tile('—', 'dim'));
        r.supplyC = h('td', { class: 'num' }, dep ? skel() : tile('—', 'dim'));
        r.availC = h('td', { class: 'num' }, dep ? skel() : tile('—', 'dim'));
        r.statusC = h('td', {}, h('span', { class: 'pill' + (dep ? ' open' : '') }, dep ? 'Open' : 'Opens soon'));
        cells.push(r.borrowC, r.supplyC, r.availC, r.statusC);
      }
      const tr = h('tr', { class: 'link', tabindex: '0', role: 'link', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } }, ...cells);
      tbody.appendChild(tr);
      rows.set(m.symbol, r);
    }

    let cancelled = false;
    (async () => {
      await fetchQuotes();
      if (STATE.quotesUnavailable) notice.classList.remove('hidden');
      const dex = await ensureDexData(STATE.markets.map((m) => m.token));
      if (cancelled) return;

      let widestRow = null;
      const prems = [];
      let volSum = 0;
      for (const m of STATE.markets) {
        const r = rows.get(m.symbol);
        const q = quoteFor(m.symbol);
        const d = dex.get(m.token.toLowerCase());
        setTile(r.quoteC, q ? fmtUsd(q.mid) : '—', q ? q.mid : undefined);
        setTile(r.dexC, d ? fmtUsd(d.priceUsd) : (d === null ? 'No pool' : '—'), d ? d.priceUsd : undefined);
        const c = d && d.chg24 !== null && d.chg24 !== undefined && !Number.isNaN(d.chg24) ? d.chg24 : null;
        setTile(r.chgC, c === null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%', c === null ? undefined : c);
        r.chgC.className = 'num' + (c > 0 ? ' pos' : c < 0 ? ' neg' : '');
        setTile(r.volC, d ? fmtUsd(d.vol24, 0) : '—', d ? d.vol24 : undefined);
        r.volC.classList.add('dim');
        if (d) volSum += d.vol24 || 0;
        if (q && d) {
          const prem = (d.priceUsd - q.mid) / q.mid;
          prems.push(Math.abs(prem));
          setTile(r.premC, (prem >= 0 ? '+' : '') + fmtPct(prem), prem);
          r.premC.className = premClass(prem) + ' hasbar';
          r.premC.style.setProperty('--bar', `${Math.min(96, Math.abs(prem) * 1600)}px`);
          if (!widestRow || Math.abs(prem) > Math.abs(widestRow.prem)) widestRow = { symbol: m.symbol, prem };
        } else {
          setTile(r.premC, '—');
        }
        if (q && q.halted && r.statusC) { const pill = r.statusC.querySelector('.pill'); pill.textContent = 'Halted'; pill.className = 'pill halt'; }
      }

      vol.val.classList.remove('skel'); vol.val.textContent = volSum > 0 ? fmtUsd(volSum, 0) : '—';
      // the monitors in the scene show the same numbers this table does
      if (window.LocateScene) {
        const liveRows = [];
        for (const m of STATE.markets) {
          const q = quoteFor(m.symbol), d = dex.get(m.token.toLowerCase());
          if (q && d) liveRows.push({ symbol: m.symbol, name: m.name, quote: q.mid, dex: d.priceUsd });
        }
        window.LocateScene.setData(liveRows, liveRows.map((r) => ({ ...r, prem: (r.dex - r.quote) / r.quote })).sort((a, b) => Math.abs(b.prem) - Math.abs(a.prem)));
      }
      widest.val.classList.remove('skel');
      if (widestRow) { widest.val.textContent = `${widestRow.symbol} ${widestRow.prem >= 0 ? '+' : ''}${fmtPct(widestRow.prem)}`; widest.val.classList.add(widestRow.prem >= 0 ? 'pos' : 'neg'); }
      else widest.val.textContent = '—';
      median.val.classList.remove('skel');
      if (prems.length) { prems.sort((a, b) => a - b); median.val.textContent = fmtPct(prems[Math.floor(prems.length / 2)]); }
      else median.val.textContent = '—';
      quotes.val.classList.remove('skel');
      quotes.val.textContent = STATE.quotesUnavailable || !STATE.quotesTs ? 'Unavailable' : `${Math.max(0, Math.round(Date.now() / 1000 - STATE.quotesTs))}s ago`;

      if (!anyOpen) return;
      for (const m of STATE.markets) {
        if (!isDeployed(m)) continue;
        const r = rows.get(m.symbol);
        const q = quoteFor(m.symbol);
        const d = dex.get(m.token.toLowerCase());
        loadMarketOnchain(m).then((d2) => {
          if (cancelled || !d2) return;
          const price = d ? d.priceUsd : (q ? q.mid : d2.usdgPerStock);
          setTile(r.borrowC, fmtPct(d2.borrowApy), d2.borrowApy);
          setTile(r.supplyC, fmtPct(d2.supplyApy), d2.supplyApy);
          const availTokens = Number(d2.availableRaw) / 1e18;
          setTile(r.availC, `${fmtNum(availTokens, 1)} ${m.symbol} · ${fmtUsd(availTokens * price, 0)}`, availTokens * price);
        });
      }
    })();
    return () => { cancelled = true; };
  }

  // ================================================================== Market page (Short / Lend)
  async function tokenBalance(token, account) {
    const data = await ethCall(STATE.addresses.rpc, token, encodeCall('balanceOf(address)', account));
    return toBig(decodeWords(data)[0]);
  }
  /** Plain decimal string for an input (no thousands separators). */
  function plainToken(raw, decimals, maxFrac) { return fmtToken(raw, decimals, maxFrac).replace(/,/g, ''); }

  function howCard(mode, symbol) {
    const steps = mode === 'short' ? [
      ['Post USDG', 'Your collateral stays yours until you close. It earns nothing while posted.'],
      [`Borrow ${symbol} and sell it`, 'The router borrows the stock to your wallet in the same transaction. Sell it on the DEX pool.'],
      ['Buy back, repay, withdraw', 'Close whenever you like. You keep the price difference less the borrow interest.'],
    ] : [
      [`Deposit ${symbol}`, 'You receive vault shares that track your deposit plus the interest it earns.'],
      ['Shorts pay you', 'The vault lends your stock to the market. Borrowers pay the rate; the vault keeps 10% of the interest.'],
      ['Withdraw when there is liquidity', 'At full utilisation you wait for repayments. Lending caps are set by the vault owner.'],
    ];
    return pnl(mode === 'short' ? 'HOW A SHORT WORKS' : 'HOW LENDING WORKS', null,
      pad(h('ol', { class: 'how' }, ...steps.map((st, i) => h('li', {}, h('i', {}, String(i + 1).padStart(2, '0')), h('b', {}, st[0]), st[1]))))
    );
  }

  function renderMarket(view, mode) {
    const wanted = STATE.param || (STATE.query && STATE.query.get('s'));
    const m = STATE.markets.find((x) => x.symbol === wanted) || STATE.markets[0];
    const symbol = m.symbol;
    const deployed = isDeployed(m);
    const vault = STATE.addresses.vaults ? STATE.addresses.vaults[symbol] : null;
    const routerLive = deployed && !!STATE.addresses.router;
    const mine = { retired: false };
    let curMode = mode;

    // ---- header: identity in the bar, the big price and its change in the body ----
    const bigPrice = h('div', { class: 'kval hero skel' });
    const priceChg = h('span', { class: 'mkt-chg' });
    const priceLab = h('div', { class: 'klabel' }, ' ');
    const priceSub = h('div', { class: 'mkt-sub' });
    const headMeta = h('span', { class: 'pnl-meta' }, deployed ? 'TRADING LIVE' : 'OPENS SOON');
    view.appendChild(h('section', { class: 'pnl' },
      h('div', { class: 'pnl-bar' }, h('span', { class: 'pnl-title mkt-id' }, `${symbol} · ${m.name}`), headMeta),
      pad(
        h('div', { class: 'mkt-hero' }, priceLab, h('div', { class: 'mkt-px' }, bigPrice, priceChg)),
        priceSub
      ),
      foot(h('a', { href: '#/markets' }, '← all markets'))
    ));

    const grid = h('div', { class: 'mkt' });
    const main = h('div', { class: 'mkt-main' });
    const side = h('aside', { class: 'mkt-side' });
    grid.appendChild(main);
    grid.appendChild(side);
    view.appendChild(grid);

    // ---- terms: the same caption-over-value row every panel uses ----
    const ltv = kstat('LOAN-TO-VALUE'), borrowApy = kstat('BORROW APY'), supplyApy = kstat('SUPPLY APY'),
      avail = kstat('AVAILABLE'), util = kstat('UTILISATION'), cap = kstat('LENDING CAP');
    ltv.val.classList.remove('skel'); ltv.val.textContent = (m.lltvBps / 100).toFixed(1) + '%';
    cap.val.classList.remove('skel'); cap.val.textContent = fmtUsd(m.initialCapUsd, 0);
    if (!deployed) { for (const s of [borrowApy, supplyApy, avail, util]) { s.val.classList.remove('skel'); s.val.textContent = '—'; s.val.classList.add('dim'); } }
    main.appendChild(pnl('TERMS', null, pad(h('div', { class: 'krow' }, ltv.el, borrowApy.el, supplyApy.el, avail.el, util.el, cap.el))));

    // ---- position (only shown when there is something to show) ----
    const posPnl = pnl('YOUR POSITION', null); posPnl.classList.add('hidden');
    const posBody = h('div', { class: 'pnl-pad' });
    posPnl.appendChild(posBody);
    main.appendChild(posPnl);

    // ---- chart ----
    const chartMeta = h('span', { class: 'pnl-meta' }, 'LOADING…');
    const chartBody = h('div', {}, h('div', { class: 'ph' }, 'Loading price chart…'));
    const chart = h('section', { class: 'pnl chart' },
      h('div', { class: 'pnl-bar' }, h('span', { class: 'pnl-title' }, `${symbol} / USDG`), chartMeta),
      chartBody);
    main.appendChild(chart);
    let how = howCard(curMode, symbol);
    main.appendChild(how);

    // ---- order panel ----
    const orderTitle = h('span', {}, curMode.toUpperCase(), ' ', symbol);
    const orderPnl = pnl(orderTitle, (m.lltvBps / 100).toFixed(1) + '% LTV');
    const panel = h('div', { class: 'pnl-pad order' });
    orderPnl.appendChild(panel);
    side.appendChild(orderPnl);

    const live = { ref: null, quote: null, dex: null, onchain: null, usdgBal: null, stockBal: null, vaultLiq: null, vaultTotal: null, myAssets: null, maxWithdraw: null };
    let recomputeShort = () => {};
    let paintLendRows = () => {};

    function switchMode(next) {
      if (next === curMode) return;
      curMode = next;
      setActiveTab(next);
      try { history.replaceState(null, '', `#/m/${symbol}${next === 'lend' ? '?mode=lend' : ''}`); } catch { /* noop */ }
      orderTitle.textContent = `${curMode.toUpperCase()} ${symbol}`;
      const fresh = howCard(curMode, symbol);
      main.replaceChild(fresh, how);
      how = fresh;
      paintPanel();
    }

    function cta(label, onclick, disabled) {
      const b = h('button', { class: 'cta', onclick }, label);
      if (disabled) b.disabled = true;
      return b;
    }

    function paintPanel() {
      clear(panel);
      panel.appendChild(h('div', { class: 'segc' },
        h('button', { class: curMode === 'short' ? 'on' : '', onclick: () => switchMode('short') }, 'Short'),
        h('button', { class: curMode === 'lend' ? 'on' : '', onclick: () => switchMode('lend') }, 'Lend')
      ));
      if (curMode === 'short') paintShort(); else paintLend();
    }

    // ---------------------------------------------------------------- short
    function paintShort() {
      const lltv = m.lltvBps / 10000;
      const collIn = h('input', { type: 'text', value: '1000', inputmode: 'decimal', 'aria-label': 'Collateral in USDG' });
      const borrowIn = h('input', { type: 'text', value: '', inputmode: 'decimal', 'aria-label': `Borrow in ${symbol}` });
      const collBal = h('a', { href: '#' }, live.usdgBal === null ? '' : `Balance ${fmtToken(live.usdgBal, STATE.addresses.usdgDecimals, 2)} · Max`);
      collBal.addEventListener('click', (e) => { e.preventDefault(); if (live.usdgBal !== null) { collIn.value = plainToken(live.usdgBal, STATE.addresses.usdgDecimals, 2); setFromHf(1.5); } });
      const maxLink = h('a', { href: '#' }, 'Max at 1.5×');
      maxLink.addEventListener('click', (e) => { e.preventDefault(); setFromHf(1.5); });

      panel.appendChild(h('div', { class: 'amt' },
        h('div', { class: 'top' }, h('span', {}, 'Collateral'), collBal),
        h('div', { class: 'in' }, collIn, h('span', { class: 'unit' }, 'USDG'))
      ));
      panel.appendChild(h('div', { class: 'amt' },
        h('div', { class: 'top' }, h('span', {}, 'Borrow'), maxLink),
        h('div', { class: 'in' }, borrowIn, h('span', { class: 'unit' }, symbol))
      ));
      const chipVals = [1.2, 1.5, 2, 3];
      const chips = chipVals.map((v) => h('button', { class: 'ghost', onclick: () => setFromHf(v) }, `${v}×`));
      panel.appendChild(h('div', { class: 'chips' }, h('span', {}, 'Health factor'), ...chips));

      const fill = h('div', { class: 'fill' });
      const hfLbl = h('b', {}, '—');
      const liqLbl = h('span', {}, '');
      panel.appendChild(h('div', { class: 'hf' }, h('div', { class: 'track' }, fill), h('div', { class: 'lbl' }, h('span', {}, 'Health factor ', hfLbl), liqLbl)));

      const rLiq = h('b', {}, '—'), rApy = h('b', {}, live.onchain ? fmtPct(live.onchain.borrowApy) : (deployed ? '…' : '—')), rRecv = h('b', {}, '—'), rPrice = h('b', {}, '—');
      panel.appendChild(h('div', { class: 'rows' },
        h('div', { class: 'r' }, h('span', {}, 'Liquidation price'), rLiq),
        h('div', { class: 'r' }, h('span', {}, 'Reference price'), rPrice),
        h('div', { class: 'r' }, h('span', {}, 'Borrow APY'), rApy),
        h('div', { class: 'r' }, h('span', {}, 'Loan-to-value'), h('b', {}, (m.lltvBps / 100).toFixed(1) + '%')),
        h('div', { class: 'r' }, h('span', {}, 'You receive'), rRecv)
      ));

      const err = h('div', { class: 'inline-error hidden' });
      let btn;
      if (!routerLive) btn = cta('Opens soon', null, true);
      else if (!STATE.account) btn = cta('Connect wallet', connectWallet);
      else btn = cta(`Open ${symbol} short`, async () => {
        err.classList.add('hidden');
        const collRaw = parseAmount(collIn.value, STATE.addresses.usdgDecimals);
        const borrowRaw = parseAmount(borrowIn.value, STOCK_DECIMALS);
        if (!collRaw || collRaw <= 0n || !borrowRaw || borrowRaw <= 0n) { err.textContent = 'Enter a collateral and a borrow amount.'; err.classList.remove('hidden'); return; }
        btn.disabled = true;
        try { await doOpenShort(m, collRaw, borrowRaw); await refreshAccount(); }
        catch (e) { err.textContent = describeError(e); err.classList.remove('hidden'); }
        btn.disabled = false;
      });
      panel.appendChild(btn);
      panel.appendChild(err);
      panel.appendChild(h('div', { class: 'fine' }, routerLive
        ? 'Up to three wallet prompts: authorise the router on Morpho once, approve the USDG, open. The stock lands in your wallet; sell it on the DEX pool.'
        : `The ${symbol} market opens once its oracle and market exist on Morpho. Sizing below runs on the ${live.ref ? ({ oracle: 'oracle', dex: 'DEX', quote: 'Robinhood' })[live.ref.source] : 'reference'} price meanwhile.`));

      function setFromHf(hf) {
        const coll = parseFloat(collIn.value);
        if (!live.ref || !isFinite(coll) || coll <= 0) { recompute(); return; }
        const maxB = (coll * lltv) / live.ref.value;
        borrowIn.value = (maxB / hf).toFixed(4);
        recompute();
      }
      function recompute() {
        const coll = parseFloat(collIn.value);
        const borrow = parseFloat(borrowIn.value);
        const price = live.ref ? live.ref.value : null;
        rPrice.textContent = price ? fmtUsd(price) : '—';
        chips.forEach((c) => c.classList.remove('on'));
        if (!price || !isFinite(coll) || coll <= 0 || !isFinite(borrow) || borrow <= 0) {
          fill.style.width = '0%'; fill.className = 'fill'; hfLbl.textContent = '—'; liqLbl.textContent = ''; rLiq.textContent = '—'; rRecv.textContent = '—';
          return;
        }
        const hf = (coll * lltv) / price / borrow;
        const liq = (coll * lltv) / borrow;
        const pct = Math.max(0, Math.min(1, (hf - 1) / 2));
        fill.style.width = (pct * 100).toFixed(1) + '%';
        fill.className = 'fill' + (hf < 1.1 ? ' bad' : hf < 1.5 ? ' warn' : '');
        hfLbl.textContent = isFinite(hf) ? hf.toFixed(2) : '∞';
        liqLbl.textContent = hf < 1 ? 'Below 1: would be liquidated on open' : `Liquidated if ${symbol} reaches ${fmtUsd(liq)} (${liq / price - 1 >= 0 ? '+' : ''}${fmtPct(liq / price - 1, 1)})`;
        rLiq.textContent = fmtUsd(liq);
        rRecv.textContent = `${fmtNum(borrow, 4)} ${symbol} ≈ ${fmtUsd(borrow * price)}`;
        const near = chipVals.find((v) => Math.abs(v - hf) < 0.005);
        if (near) chips[chipVals.indexOf(near)].classList.add('on');
      }
      collIn.addEventListener('input', () => { if (borrowIn.value === '') setFromHf(1.5); else recompute(); });
      borrowIn.addEventListener('input', recompute);
      recomputeShort = () => { if (borrowIn.value === '') setFromHf(1.5); else recompute(); };
      recomputeShort();
    }

    // ---------------------------------------------------------------- lend
    function paintLend() {
      const depIn = h('input', { type: 'text', value: '', placeholder: '0', inputmode: 'decimal', 'aria-label': `Deposit in ${symbol}` });
      const depBal = h('a', { href: '#' }, live.stockBal === null ? '' : `Balance ${fmtToken(live.stockBal, STOCK_DECIMALS, 4)} · Max`);
      depBal.addEventListener('click', (e) => { e.preventDefault(); if (live.stockBal !== null) depIn.value = plainToken(live.stockBal, STOCK_DECIMALS, 6); });
      panel.appendChild(h('div', { class: 'amt' },
        h('div', { class: 'top' }, h('span', {}, 'Deposit'), depBal),
        h('div', { class: 'in' }, depIn, h('span', { class: 'unit' }, symbol))
      ));
      const rApy = h('b', {}), rLiq = h('b', {}), rTot = h('b', {}), rMine = h('b', {});
      panel.appendChild(h('div', { class: 'rows' },
        h('div', { class: 'r' }, h('span', {}, 'Supply APY'), rApy),
        h('div', { class: 'r' }, h('span', {}, 'Deposited in vault'), rTot),
        h('div', { class: 'r' }, h('span', {}, 'Withdrawable now'), rLiq),
        h('div', { class: 'r' }, h('span', {}, 'Your deposit'), rMine),
        h('div', { class: 'r' }, h('span', {}, 'Performance fee'), h('b', {}, '10% of interest'))
      ));
      paintLendRows = () => {
        rApy.textContent = live.onchain ? fmtPct(live.onchain.supplyApy) : (vault ? '…' : '—');
        rTot.textContent = live.vaultTotal !== null ? `${fmtToken(live.vaultTotal, STOCK_DECIMALS, 2)} ${symbol}` : (vault ? '…' : '—');
        rLiq.textContent = live.vaultLiq !== null ? `${fmtToken(live.vaultLiq, STOCK_DECIMALS, 2)} ${symbol}` : (vault ? '…' : '—');
        rMine.textContent = live.myAssets !== null ? `${fmtToken(live.myAssets, STOCK_DECIMALS, 4)} ${symbol}` : (STATE.account ? (vault ? '…' : '—') : 'Connect wallet');
      };
      paintLendRows();

      const err = h('div', { class: 'inline-error hidden' });
      let btn;
      if (!vault) btn = cta('Opens soon', null, true);
      else if (!STATE.account) btn = cta('Connect wallet', connectWallet);
      else btn = cta(`Deposit ${symbol}`, async () => {
        err.classList.add('hidden');
        const raw = parseAmount(depIn.value, STOCK_DECIMALS);
        if (!raw || raw <= 0n) { err.textContent = 'Enter an amount to deposit.'; err.classList.remove('hidden'); return; }
        btn.disabled = true;
        try {
          await ensureAllowance(m.token, vault, raw, symbol);
          await sendTx({ to: vault, data: encodeCall('deposit(uint256,address)', raw, STATE.account), title: `deposit ${symbol}` });
          depIn.value = '';
          await refreshAccount();
        } catch (e) { err.textContent = describeError(e); err.classList.remove('hidden'); }
        btn.disabled = false;
      });
      panel.appendChild(btn);
      panel.appendChild(err);

      if (vault && STATE.account) {
        panel.appendChild(h('div', { class: 'sub-h' }, 'Withdraw'));
        const wIn = h('input', { type: 'text', placeholder: '0', inputmode: 'decimal', 'aria-label': `Withdraw in ${symbol}` });
        const wMax = h('a', { href: '#' }, live.maxWithdraw !== null ? `Max ${fmtToken(live.maxWithdraw, STOCK_DECIMALS, 4)}` : '');
        wMax.addEventListener('click', (e) => { e.preventDefault(); if (live.maxWithdraw !== null) wIn.value = plainToken(live.maxWithdraw, STOCK_DECIMALS, 6); });
        panel.appendChild(h('div', { class: 'amt' }, h('div', { class: 'top' }, h('span', {}, 'Amount'), wMax), h('div', { class: 'in' }, wIn, h('span', { class: 'unit' }, symbol))));
        const wErr = h('div', { class: 'inline-error hidden' });
        const wBtn = h('button', { class: 'ghost cta', onclick: async () => {
          wErr.classList.add('hidden');
          const raw = parseAmount(wIn.value, STOCK_DECIMALS);
          if (!raw || raw <= 0n) { wErr.textContent = 'Enter an amount to withdraw.'; wErr.classList.remove('hidden'); return; }
          if (live.maxWithdraw !== null && raw > live.maxWithdraw) { wErr.textContent = `Only ${fmtToken(live.maxWithdraw, STOCK_DECIMALS, 4)} ${symbol} can leave right now.`; wErr.classList.remove('hidden'); return; }
          wBtn.disabled = true;
          try {
            await sendTx({ to: vault, data: encodeCall('withdraw(uint256,address,address)', raw, STATE.account, STATE.account), title: `withdraw ${symbol}` });
            wIn.value = '';
            await refreshAccount();
          } catch (e) { wErr.textContent = describeError(e); wErr.classList.remove('hidden'); }
          wBtn.disabled = false;
        } }, 'Withdraw');
        panel.appendChild(wBtn);
        panel.appendChild(wErr);
      }
      panel.appendChild(h('div', { class: 'fine' }, vault
        ? 'Withdrawals come from the vault\'s idle balance first, then from the market. When everything is borrowed you wait for repayments.'
        : `The ${symbol} vault opens with its market. Planned cap ${fmtUsd(m.initialCapUsd, 0)} at ${(m.lltvBps / 100).toFixed(1)}% loan-to-value.`));
    }

    // ---------------------------------------------------------------- position
    async function loadPosition() {
      if (!routerLive || !STATE.account) { posPnl.classList.add('hidden'); return; }
      try {
        const mp = mpFor(m);
        const data = await ethCall(STATE.addresses.rpc, STATE.addresses.router, encodeCall('positionOf((address,address,address,address,uint256),address)', marketParamsTuple(mp), STATE.account));
        if (mine.retired) return;
        const w = decodeWords(data);
        const pos = { collateral: toBig(w[0]), borrowAssets: toBig(w[1]), maxBorrow: toBig(w[2]), healthFactorWad: toBig(w[3]), liquidationPrice: toBig(w[4]) };
        if (pos.collateral === 0n && pos.borrowAssets === 0n) { posPnl.classList.add('hidden'); return; }
        clear(posBody);
        posPnl.classList.remove('hidden');
        // the same big-number-plus-gauge the scene's own position() screen paints
        const hfNum = Number(pos.healthFactorWad) / 1e18;
        const bad = hfNum < 1.2, warn = hfNum < 1.5;
        const gcolor = bad ? 'var(--down)' : warn ? 'var(--amber)' : 'var(--up)';
        const gpct = Math.max(0, Math.min(1, (hfNum - 1) / 2));
        const buf = (hfNum - 1) * 100;
        posBody.appendChild(h('div', { class: 'hf-hero' },
          h('div', {}, h('div', { class: 'klabel' }, 'HEALTH FACTOR'), h('div', { class: 'kval hero', style: bad ? 'color:var(--down)' : '' }, fmtHf(pos.healthFactorWad))),
          h('div', { class: 'gauge', style: `--pct:${gpct};--gcolor:${gcolor}` },
            h('div', { class: 'g-track' }), h('div', { class: 'g-val' }),
            h('div', { class: 'g-hole' }, h('div', { class: 'klabel' }, 'BUFFER'), h('div', { class: 'gval' }, `${buf >= 0 ? '+' : ''}${buf.toFixed(0)}%`)))
        ));
        posBody.appendChild(h('dl', { class: 'ledger' },
          lrow('Collateral', h('div', { class: 'value small' }, fmtToken(pos.collateral, STATE.addresses.usdgDecimals, 2) + ' USDG')),
          lrow('Borrowed', h('div', { class: 'value small' }, fmtToken(pos.borrowAssets, STOCK_DECIMALS, 4) + ' ' + symbol)),
          lrow('Liquidation price', h('div', { class: 'value small' }, pos.borrowAssets > 0n ? fmtUsd(Number(pos.liquidationPrice) / 1e18) : '—')),
          lrow('Can still borrow', h('div', { class: 'value small' }, fmtToken(pos.maxBorrow > pos.borrowAssets ? pos.maxBorrow - pos.borrowAssets : 0n, STOCK_DECIMALS, 4) + ' ' + symbol))
        ));
        if (live.dex && live.dex.url) posBody.appendChild(h('div', { style: 'margin:6px 0 12px' }, h('a', { href: live.dex.url, target: '_blank', rel: 'noopener' }, `Trade ${symbol} on the DEX pool ↗`)));

        const addIn = h('input', { type: 'text', placeholder: '0' });
        const addErr = h('div', { class: 'inline-error hidden' });
        const addBtn = h('button', { class: 'ghost', onclick: async () => {
          addErr.classList.add('hidden');
          const raw = parseAmount(addIn.value, STATE.addresses.usdgDecimals);
          if (!raw || raw <= 0n) { addErr.textContent = 'Enter an amount.'; addErr.classList.remove('hidden'); return; }
          addBtn.disabled = true;
          try { await doAddCollateral(m, raw); addIn.value = ''; await refreshAccount(); }
          catch (e) { addErr.textContent = describeError(e); addErr.classList.remove('hidden'); }
          addBtn.disabled = false;
        } }, 'Add collateral');
        const repayIn = h('input', { type: 'text', placeholder: '0' });
        const repayErr = h('div', { class: 'inline-error hidden' });
        const repayBtn = h('button', { class: 'ghost', onclick: async () => {
          repayErr.classList.add('hidden');
          const raw = parseAmount(repayIn.value, STOCK_DECIMALS);
          if (!raw || raw <= 0n) { repayErr.textContent = 'Enter an amount.'; repayErr.classList.remove('hidden'); return; }
          repayBtn.disabled = true;
          try { await doRepayAmount(m, raw); repayIn.value = ''; await refreshAccount(); }
          catch (e) { repayErr.textContent = describeError(e); repayErr.classList.remove('hidden'); }
          repayBtn.disabled = false;
        } }, 'Repay');
        const closeErr = h('div', { class: 'inline-error hidden' });
        const closeBtn = h('button', { class: 'danger', onclick: async () => {
          closeErr.classList.add('hidden');
          closeBtn.disabled = true;
          try { await doCloseShort(m); await refreshAccount(); }
          catch (e) { closeErr.textContent = describeError(e); closeErr.classList.remove('hidden'); }
          closeBtn.disabled = false;
        } }, 'Close position');
        posBody.appendChild(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Add collateral (USDG)'), addIn, addErr), h('div', {}, addBtn)));
        posBody.appendChild(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, `Repay (${symbol})`), repayIn, repayErr), h('div', {}, repayBtn)));
        posBody.appendChild(h('div', { class: 'actions' }, closeBtn, closeErr));
      } catch (e) {
        if (!mine.retired) console.warn('position read failed', e);
      }
    }

    async function refreshAccount() {
      if (!STATE.account) return;
      try {
        const [usdg, stock] = await Promise.all([tokenBalance(STATE.addresses.usdg, STATE.account), tokenBalance(m.token, STATE.account)]);
        if (mine.retired) return;
        live.usdgBal = usdg; live.stockBal = stock;
        if (vault) {
          const [maxW, bal] = await Promise.all([
            ethCall(STATE.addresses.rpc, vault, encodeCall('maxWithdraw(address)', STATE.account)),
            ethCall(STATE.addresses.rpc, vault, encodeCall('balanceOf(address)', STATE.account)),
          ]);
          const shares = toBig(decodeWords(bal)[0]);
          const assets = await ethCall(STATE.addresses.rpc, vault, encodeCall('convertToAssets(uint256)', shares));
          if (mine.retired) return;
          live.maxWithdraw = toBig(decodeWords(maxW)[0]);
          live.myAssets = toBig(decodeWords(assets)[0]);
        }
        paintPanel();
        await loadPosition();
      } catch (e) { if (!mine.retired) console.warn('account refresh failed', e); }
    }

    paintPanel();

    // ---- data ----
    (async () => {
      await fetchQuotes();
      const dexMap = await ensureDexData([m.token]);
      if (mine.retired) return;
      const q = quoteFor(symbol);
      const d = dexMap.get(m.token.toLowerCase()) || null;
      live.quote = q; live.dex = d;
      bigPrice.classList.remove('skel');
      if (q) { bigPrice.textContent = fmtUsd(q.mid); priceLab.textContent = 'ROBINHOOD QUOTE'; }
      else if (d) { bigPrice.textContent = fmtUsd(d.priceUsd); priceLab.textContent = 'DEX PRICE'; }
      else { bigPrice.textContent = '—'; priceLab.textContent = 'NO PRICE'; }
      clear(priceChg); clear(priceSub);
      if (d) {
        const prem = q ? (d.priceUsd - q.mid) / q.mid : null;
        if (d.chg24 !== null && !Number.isNaN(d.chg24)) {
          priceChg.textContent = `${d.chg24 >= 0 ? '+' : ''}${d.chg24.toFixed(2)}%`;
          priceChg.className = 'mkt-chg' + (d.chg24 > 0 ? ' pos' : d.chg24 < 0 ? ' neg' : '');
        }
        priceSub.appendChild(h('span', {}, 'DEX ', h('b', {}, fmtUsd(d.priceUsd))));
        if (prem !== null) priceSub.appendChild(h('span', {}, 'Premium ', h('b', { class: prem > 0 ? 'pos' : prem < 0 ? 'neg' : '' }, (prem >= 0 ? '+' : '') + fmtPct(prem))));
        priceSub.appendChild(h('span', {}, 'Volume 24h ', h('b', {}, fmtUsd(d.vol24, 0))));
        clear(chartBody);
        chartMeta.textContent = `${(d.dexId || 'pool').toUpperCase()} · ROBINHOOD CHAIN`;
        chartBody.appendChild(h('div', { class: 'scr-glass' },
          h('iframe', { src: d.url + '?embed=1&theme=dark&chartTheme=dark&trades=0&info=0&chartLeftToolbar=0&loadChartSettings=0&chartResolution=15', loading: 'lazy', title: `${symbol} price on the DEX pool` })
        ));
        chart.appendChild(foot(h('span', {}, 'chart by dexscreener · '), h('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'open the pool ↗')));
      } else {
        clear(chartBody);
        chartMeta.textContent = 'NO POOL';
        chartBody.appendChild(h('div', { class: 'ph' }, `No DEX pool found for ${symbol} yet.`));
      }
      if (q && q.halted) headMeta.textContent = 'TRADING HALTED';

      live.ref = await getReferencePrice(m);
      if (mine.retired) return;
      recomputeShort();

      if (deployed) {
        const oc = await loadMarketOnchain(m);
        if (mine.retired) return;
        if (oc) {
          live.onchain = oc;
          borrowApy.val.classList.remove('skel'); borrowApy.val.textContent = fmtPct(oc.borrowApy);
          supplyApy.val.classList.remove('skel'); supplyApy.val.textContent = fmtPct(oc.supplyApy);
          util.val.classList.remove('skel'); clear(util.val); util.val.appendChild(ubar(oc.utilisation));
          const availTokens = Number(oc.availableRaw) / 1e18;
          avail.val.classList.remove('skel'); avail.val.textContent = `${fmtNum(availTokens, 2)} ${symbol}`;
          paintPanel();
        }
      }
      if (vault) {
        try {
          const [tot, liq] = await Promise.all([ethCall(STATE.addresses.rpc, vault, encodeCall('totalAssets()')), ethCall(STATE.addresses.rpc, vault, encodeCall('liquidity()'))]);
          if (mine.retired) return;
          live.vaultTotal = toBig(decodeWords(tot)[0]); live.vaultLiq = toBig(decodeWords(liq)[0]);
          paintLendRows();
        } catch (e) { console.warn('vault read failed', e); }
      }
      await refreshAccount();
    })();

    return () => { mine.retired = true; };
  }

  // ================================================================== Premium Board
  function renderPremium(view) {
    const filter = h('input', { type: 'text', placeholder: 'Filter symbol or name', 'aria-label': 'Filter' });
    const status = h('span', { class: 'count' }, 'Loading…');
    const notice = h('div', { class: 'notice hidden' },
      h('strong', {}, 'Robinhood registry unavailable. '),
      'The full board needs api/quotes.js (Vercel only) to list all Robinhood stock tokens — that API has no CORS for direct browser calls. Showing DEX data for the ten configured markets instead.');
    const table = h('table', { class: 'premium' });
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', { class: 'idx', 'data-nosort': '' }, '#'), h('th', {}, 'Stock'), h('th', { class: 'num' }, 'DEX'), h('th', { class: 'num' }, 'Quote'),
      h('th', { class: 'num' }, 'Premium'), h('th', { class: 'num' }, '24h'), h('th', { class: 'num' }, 'Volume 24h'), h('th', {}, 'Status'), h('th', { 'data-nosort': '' }, '')
    )));
    makeSortable(table);
    let totalTokens = 0;
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const tr of table.querySelectorAll('tbody tr')) tr.hidden = q !== '' && !(tr.dataset.k || '').includes(q);
    });
    const tbody = h('tbody');
    table.appendChild(tbody);
    const wrap = h('div', { class: 'table-wrap hidden' }, table);

    view.appendChild(pnl('PREMIUM BOARD', 'DEX VS ROBINHOOD · SORTED BY GAP',
      h('div', { class: 'toolbar' }, filter, status),
      notice,
      wrap,
      foot('DEX price against Robinhood’s quote for every stock token with a pool, largest gap first — Robinhood only mints and burns while the exchange is open, so pools drift.')
    ));

    let cancelled = false;
    (async () => {
      const quotes = await fetchQuotes();
      const assets = quotes.assets || [];
      if (STATE.quotesUnavailable || !assets.length) {
        notice.classList.remove('hidden');
        const addrs = STATE.markets.map((m) => m.token);
        const dex = await ensureDexData(addrs);
        if (cancelled) return;
        const rows = STATE.markets.map((m) => ({ symbol: m.symbol, name: m.name, addr: m.token, dex: dex.get(m.token.toLowerCase()) })).filter((r) => r.dex);
        paintRows(rows);
        return;
      }

      const bySymbolAddr = new Map();
      for (const a of assets) {
        const dep = (a.deployments || []).find((d) => d.chainId === STATE.addresses.chainId);
        if (dep) bySymbolAddr.set(a.tokenSymbol, { addr: dep.contractAddress, name: String(a.tokenName || '').replace(/\s*[•·-]\s*Robinhood Token\s*$/i, '') });
      }
      const addrList = [...bySymbolAddr.values()].map((v) => v.addr);
      const dex = await ensureDexData(addrList, {
        onProgress: (done, total) => { if (!cancelled) status.textContent = `scanning DexScreener: ${done}/${total} tokens`; },
      });
      if (cancelled) return;
      const rows = [];
      for (const [symbol, info] of bySymbolAddr) {
        const d = dex.get(info.addr.toLowerCase());
        if (d) rows.push({ symbol, name: info.name, addr: info.addr, dex: d });
      }
      totalTokens = bySymbolAddr.size;
      paintRows(rows);
    })();

    function paintRows(rows) {
      if (cancelled) return;
      wrap.classList.remove('hidden');
      const withPrem = rows.map((r) => {
        const q = quoteFor(r.symbol);
        const prem = q ? (r.dex.priceUsd - q.mid) / q.mid : null;
        return { ...r, q, prem };
      });
      withPrem.sort((a, b) => Math.abs(b.prem ?? 0) - Math.abs(a.prem ?? 0));
      const gaps = withPrem.filter((r) => r.prem !== null).map((r) => Math.abs(r.prem)).sort((a, b) => a - b);
      const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
      const over = gaps.filter((g) => g > 0.05).length;
      if (window.LocateScene && withPrem.length) window.LocateScene.setData(null, withPrem.filter((r) => r.q).map((r) => ({ symbol: r.symbol, quote: r.q.mid, dex: r.dex.priceUsd, prem: r.prem })));
      status.textContent = totalTokens
        ? `${rows.length} of ${totalTokens} tokens have a pool` + (median !== null ? ` · median gap ${fmtPct(median)} · ${over} wider than 5%` : '')
        : `${rows.length} markets`;
      for (const r of withPrem) {
        const c = r.dex.chg24;
        const listed = STATE.markets.some((mm) => mm.symbol === r.symbol);
        const tr = h('tr', { 'data-k': (r.symbol + ' ' + r.name).toLowerCase(), class: listed ? 'link' : '', onclick: listed ? () => { location.hash = `#/m/${r.symbol}`; } : null },
          h('td', { class: 'idx' }, String(tbody.childElementCount + 1)),
          symCell(r.symbol, r.name),
          h('td', { class: 'num', 'data-v': String(r.dex.priceUsd) }, fmtUsd(r.dex.priceUsd)),
          h('td', { class: 'num', 'data-v': r.q ? String(r.q.mid) : '' }, r.q ? fmtUsd(r.q.mid) : '—'),
          h('td', { class: premClass(r.prem) + (r.prem !== null ? ' hasbar' : ''), 'data-v': r.prem !== null ? String(r.prem) : '', style: r.prem !== null ? `--bar:${Math.min(110, Math.abs(r.prem) * 1600)}px` : '' }, r.prem !== null ? (r.prem >= 0 ? '+' : '') + fmtPct(r.prem) : '—'),
          h('td', { class: 'num' + (c > 0 ? ' pos' : c < 0 ? ' neg' : ''), 'data-v': c === null || Number.isNaN(c) ? '' : String(c) }, c === null || Number.isNaN(c) ? '—' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%'),
          h('td', { class: 'num dim', 'data-v': String(r.dex.vol24 || 0) }, fmtUsd(r.dex.vol24, 0)),
          h('td', {}, h('span', { class: 'pill' + (r.q?.halted ? ' halt' : ' open') }, r.q?.halted ? 'Halted' : 'Trading')),
          h('td', {}, h('a', { class: 'v', href: r.dex.url, target: '_blank', rel: 'noopener' }, 'View pool'))
        );
        tbody.appendChild(tr);
      }
    }
    return () => { cancelled = true; };
  }

  // ================================================================== boot
  function startBlockPoller() {
    const el = document.getElementById('s-block');
    async function tick() {
      try {
        const bn = await rpc(STATE.addresses.rpc, 'eth_blockNumber', []);
        clear(el); el.appendChild(h('span', {}, 'block ', h('b', {}, BigInt(bn).toLocaleString('en-US'))));
      } catch { clear(el); el.appendChild(h('span', { class: 'dim' }, 'block —')); }
    }
    tick();
    setInterval(tick, 6000);
  }
  function startFeedTicker() {
    const el = document.getElementById('s-feed');
    setInterval(() => {
      clear(el);
      if (!STATE.quotesTs) {
        el.appendChild(h('span', { class: STATE.quotesUnavailable ? 'red' : 'dim' }, STATE.quotesUnavailable ? 'quotes unavailable' : 'quotes —'));
        return;
      }
      const age = Math.max(0, Math.round(Date.now() / 1000 - STATE.quotesTs));
      el.appendChild(h('span', {}, 'quotes ', h('b', {}, age + 's ago')));
    }, 1000);
  }

  function startClock() {
    const el = document.getElementById('s-clock');
    if (!el) return;
    const tick = () => { clear(el); el.appendChild(h('b', {}, new Date().toISOString().slice(11, 19))); el.appendChild(h('small', {}, 'UTC')); };
    tick();
    setInterval(tick, 1000);
  }
  /** Keys 1–4 switch desks, like the function keys on a terminal. Ignored while typing. */
  function wireHotkeys() {
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0) { location.hash = '#/' + ROUTES[i]; e.preventDefault(); }
    });
  }

  async function boot() {
    try {
      const [addresses, markets] = await Promise.all([
        fetch('./config/addresses.json').then((r) => r.json()),
        fetch('./config/markets.json').then((r) => r.json()),
      ]);
      STATE.addresses = addresses;
      STATE.markets = markets;
    } catch (e) {
      const view = document.getElementById('view');
      clear(view);
      view.appendChild(h('div', { class: 'notice error' }, h('strong', {}, 'Could not load config. '), 'Serve this directory over HTTP (e.g. python3 -m http.server), not as a local file:// page.'));
      console.error(e);
      return;
    }
    const chainSeg = document.getElementById('s-chain');
    clear(chainSeg);
    chainSeg.appendChild(h('span', {}, 'robinhood-chain:', h('b', {}, String(STATE.addresses.chainId))));

    document.getElementById('btn-connect').addEventListener('click', connectWallet);
    primeLive();
    wireWalletEvents();
    startBlockPoller();
    startFeedTicker();
    startClock();
    wireHotkeys();
    syncMastheadHeight();
    fetchQuotes(); // warm the cache so the status bar's feed age has something to show quickly
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  /** The command line docks directly under the masthead; its height varies (it wraps to two
   *  rows under 760px), so this measures rather than hardcodes the offset. */
  function syncMastheadHeight() {
    const mh = document.getElementById('masthead');
    if (!mh) return;
    const set = () => document.documentElement.style.setProperty('--mh-h', mh.offsetHeight + 'px');
    set();
    window.addEventListener('resize', set);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
