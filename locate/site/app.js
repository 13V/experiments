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
      seg.appendChild(h('button', { class: 'ghost', onclick: connectWallet }, 'connect wallet'));
      return;
    }
    seg.appendChild(h('span', { class: 'dim' }, shortAddr(STATE.account)));
    const balSpan = h('span', { class: 'amber' }, ' …');
    seg.appendChild(h('span', {}, ' · usdg '));
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
  async function fetchQuotes(force) {
    // One attempt per 15s (matching the function's own s-maxage) whether it succeeded or
    // failed — otherwise every view that calls fetchQuotes() during a single render would
    // re-probe /api/quotes and, locally without `vercel dev`, re-trigger the browser's own
    // resource-fail logging for that request on every single call.
    const attemptedRecently = STATE.quotesLastAttempt && (Date.now() / 1000 - STATE.quotesLastAttempt) < 15;
    if (attemptedRecently && !force) return STATE.quotes || { assets: [], prices: [] };
    STATE.quotesLastAttempt = Date.now() / 1000;
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
    }
    return STATE.quotes;
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
    return { priceUsd: Number(best.priceUsd), liqUsd: best.liquidity?.usd || 0, vol24, dexId: best.dexId, url: best.url, pairCount: mine.length };
  }
  async function fetchDexForAddresses(addrs, { batchSize = 8, onProgress } = {}) {
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
  const ROUTES = ['markets', 'lend', 'short', 'premium'];
  let currentCleanup = null;
  function navigate() {
    if (currentCleanup) { try { currentCleanup(); } catch { /* noop */ } currentCleanup = null; }
    const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
    const route = ROUTES.includes(raw) ? raw : 'markets';
    STATE.route = route;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
    const view = document.getElementById('view');
    clear(view);
    const renderers = { markets: renderMarkets, lend: renderLend, short: renderShort, premium: renderPremium };
    currentCleanup = renderers[route](view) || null;
  }

  // ================================================================== Markets view
  function renderMarkets(view) {
    view.appendChild(h('div', { class: 'view-head' },
      h('h2', {}, 'Markets'),
      h('div', { class: 'desk-note' }, 'Loan token is the stock, collateral is USDG. On-chain columns read "opening soon" until a market has been created — see locate/config/markets.json.')
    ));
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table');
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, 'Stock'), h('th', { class: 'num' }, 'LLTV'), h('th', { class: 'num' }, 'Cap'),
      h('th', { class: 'num' }, 'Supply APY'), h('th', { class: 'num' }, 'Borrow APY'), h('th', { class: 'num' }, 'Util'),
      h('th', { class: 'num' }, 'Available'), h('th', { class: 'num' }, 'Quote'), h('th', { class: 'num' }, 'DEX'), h('th', { class: 'num' }, 'Premium')
    )));
    const tbody = h('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    view.appendChild(wrap);

    const rows = new Map();
    for (const m of STATE.markets) {
      const supplyC = h('td', { class: 'num soon' }, '—');
      const borrowC = h('td', { class: 'num soon' }, '—');
      const utilC = h('td', { class: 'num soon' }, '—');
      const availC = h('td', { class: 'num soon' }, '—');
      const quoteC = h('td', { class: 'num' }, '…');
      const dexC = h('td', { class: 'num' }, '…');
      const premC = h('td', { class: 'num' }, '…');
      const tr = h('tr', {},
        h('td', { class: 'sym' }, m.symbol, h('span', { class: 'name' }, m.name)),
        h('td', { class: 'num' }, (m.lltvBps / 100).toFixed(1) + '%'),
        h('td', { class: 'num dim' }, fmtUsd(m.initialCapUsd, 0)),
        supplyC, borrowC, utilC, availC, quoteC, dexC, premC
      );
      tbody.appendChild(tr);
      rows.set(m.symbol, { supplyC, borrowC, utilC, availC, quoteC, dexC, premC });
    }

    let cancelled = false;
    (async () => {
      const quotes = await fetchQuotes();
      if (STATE.quotesUnavailable) {
        view.insertBefore(h('div', { class: 'notice' }, h('strong', {}, 'Quotes unavailable. '), 'This looks like a local server without the /api/quotes function (Vercel only). DEX prices below are still live.'), view.firstChild.nextSibling);
      }
      const addrs = STATE.markets.map((m) => m.token);
      const dex = await ensureDexData(addrs);
      if (cancelled) return;

      for (const m of STATE.markets) {
        const r = rows.get(m.symbol);
        const q = quoteFor(m.symbol);
        r.quoteC.textContent = q ? fmtUsd(q.mid) : '—';
        const d = dex.get(m.token.toLowerCase());
        r.dexC.textContent = d ? fmtUsd(d.priceUsd) : (d === null ? 'no pool' : '—');
        if (q && d) {
          const prem = (d.priceUsd - q.mid) / q.mid;
          r.premC.textContent = (prem >= 0 ? '+' : '') + fmtPct(prem);
          r.premC.classList.toggle('red', Math.abs(prem) > 0.05);
        } else {
          r.premC.textContent = '—';
        }
        if (isDeployed(m)) {
          loadMarketOnchain(m).then((d2) => {
            if (cancelled || !d2) return;
            const price = d ? d.priceUsd : (q ? q.mid : d2.usdgPerStock);
            r.supplyC.textContent = fmtPct(d2.supplyApy); r.supplyC.classList.remove('soon');
            r.borrowC.textContent = fmtPct(d2.borrowApy); r.borrowC.classList.remove('soon');
            r.utilC.textContent = fmtPct(d2.utilisation); r.utilC.classList.remove('soon');
            const availTokens = Number(d2.availableRaw) / 1e18;
            r.availC.textContent = `${fmtNum(availTokens, 1)} (${fmtUsd(availTokens * price)})`;
            r.availC.classList.remove('soon');
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }

  // ================================================================== Lend view
  function stockSelect(onChange, selected) {
    const sel = h('select', { onchange: (e) => onChange(e.target.value) },
      ...STATE.markets.map((m) => h('option', { value: m.symbol, selected: m.symbol === selected || undefined }, `${m.symbol} — ${m.name}`))
    );
    return sel;
  }

  function renderLend(view) {
    view.appendChild(h('div', { class: 'view-head' }, h('h2', {}, 'Lend'), h('div', { class: 'desk-note' }, 'Deposit a stock token into its vault and earn the borrow rate shorts pay. Withdrawals pull from idle balance first, then from markets — bounded by liquidity().')));
    const picker = h('div', { class: 'field' }, h('label', {}, 'Stock'));
    let symbol = STATE.markets[0].symbol;
    const body = h('div');
    picker.appendChild(stockSelect((s) => { symbol = s; paint(); }, symbol));
    view.appendChild(picker);
    view.appendChild(body);

    // Each paint() owns a `mine.retired` flag. Switching stock (a new paint()) or unmounting the
    // view retires the previous paint's flag, so an in-flight refreshStats() from a stock the
    // user already navigated away from never writes into elements that no longer represent it.
    function paint() {
      const mine = { retired: false };
      if (paint._retire) paint._retire();
      paint._retire = () => { mine.retired = true; };

      clear(body);
      const m = STATE.markets.find((x) => x.symbol === symbol);
      const vault = STATE.addresses.vaults ? STATE.addresses.vaults[symbol] : null;
      if (!vault) {
        body.appendChild(h('div', { class: 'notice' }, h('strong', {}, `${symbol} vault not deployed yet. `), `Planned initial cap ${fmtUsd(m.initialCapUsd, 0)} at ${(m.lltvBps / 100).toFixed(1)}% LLTV. Deposits open once locate/scripts/deploy.js records an address in config/addresses.json.`));
        return;
      }
      const apyEl = h('div', { class: 'value' }, '…');
      const totalEl = h('div', { class: 'value small' }, '…');
      const liqEl = h('div', { class: 'value small' }, '…');
      const posEl = h('div', { class: 'value small' }, STATE.account ? '…' : 'connect wallet');
      body.appendChild(h('div', { class: 'grid-4' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Supply APY'), apyEl),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Total deposited'), totalEl),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Vault liquidity'), liqEl),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Your position'), posEl)
      ));

      let maxWithdrawRaw = null; // uint256, from the vault's own maxWithdraw(owner) — min(owner assets, liquidity())
      const depAmt = h('input', { type: 'text', placeholder: '0.0' });
      const depErr = h('div', { class: 'inline-error hidden' });
      const depBtn = h('button', {
        onclick: async () => {
          depErr.classList.add('hidden');
          const raw = parseAmount(depAmt.value, STOCK_DECIMALS);
          if (raw === null || raw <= 0n) { depErr.textContent = 'enter a valid amount'; depErr.classList.remove('hidden'); return; }
          depBtn.disabled = true;
          try {
            await ensureAllowance(m.token, vault, raw, symbol);
            await sendTx({ to: vault, data: encodeCall('deposit(uint256,address)', raw, STATE.account), title: `deposit ${symbol}` });
            depAmt.value = '';
            refreshStats();
          } catch (e) { depErr.textContent = describeError(e); depErr.classList.remove('hidden'); }
          depBtn.disabled = false;
        },
      }, 'Deposit');
      const withAmt = h('input', { type: 'text', placeholder: '0.0' });
      const withErr = h('div', { class: 'inline-error hidden' });
      const withHint = h('div', { class: 'hint' }, STATE.account ? 'max: …' : '');
      const withBtn = h('button', {
        class: 'ghost',
        onclick: async () => {
          withErr.classList.add('hidden');
          const raw = parseAmount(withAmt.value, STOCK_DECIMALS);
          if (raw === null || raw <= 0n) { withErr.textContent = 'enter a valid amount'; withErr.classList.remove('hidden'); return; }
          if (maxWithdrawRaw !== null && raw > maxWithdrawRaw) { withErr.textContent = `exceeds maxWithdraw (${fmtToken(maxWithdrawRaw, STOCK_DECIMALS, 4)} ${symbol})`; withErr.classList.remove('hidden'); return; }
          withBtn.disabled = true;
          try {
            await sendTx({ to: vault, data: encodeCall('withdraw(uint256,address,address)', raw, STATE.account, STATE.account), title: `withdraw ${symbol}` });
            withAmt.value = '';
            refreshStats();
          } catch (e) { withErr.textContent = describeError(e); withErr.classList.remove('hidden'); }
          withBtn.disabled = false;
        },
      }, 'Withdraw');

      body.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', {}, `Deposit ${symbol}`), depAmt, depErr),
          h('div', {}, depBtn)
        ),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', {}, `Withdraw ${symbol}`), withAmt, withHint, withErr),
          h('div', {}, withBtn)
        ),
        !STATE.account ? h('div', { class: 'notice' }, 'Connect a wallet to deposit or withdraw.') : null
      ));

      async function refreshStats() {
        try {
          const [totalAssetsData, liqData] = await Promise.all([
            ethCall(STATE.addresses.rpc, vault, encodeCall('totalAssets()')),
            ethCall(STATE.addresses.rpc, vault, encodeCall('liquidity()')),
          ]);
          if (mine.retired) return;
          totalEl.textContent = fmtToken(toBig(decodeWords(totalAssetsData)[0]), STOCK_DECIMALS, 2) + ' ' + symbol;
          liqEl.textContent = fmtToken(toBig(decodeWords(liqData)[0]), STOCK_DECIMALS, 2) + ' ' + symbol;
          if (isDeployed(m)) {
            const d = await loadMarketOnchain(m);
            if (!mine.retired && d) apyEl.textContent = fmtPct(d.supplyApy);
          }
          if (STATE.account) {
            const [maxWData, balData] = await Promise.all([
              ethCall(STATE.addresses.rpc, vault, encodeCall('maxWithdraw(address)', STATE.account)),
              ethCall(STATE.addresses.rpc, vault, encodeCall('balanceOf(address)', STATE.account)),
            ]);
            if (mine.retired) return;
            maxWithdrawRaw = toBig(decodeWords(maxWData)[0]);
            withHint.textContent = `max: ${fmtToken(maxWithdrawRaw, STOCK_DECIMALS, 4)} ${symbol}`;
            const shares = toBig(decodeWords(balData)[0]);
            const assetsData = await ethCall(STATE.addresses.rpc, vault, encodeCall('convertToAssets(uint256)', shares));
            if (mine.retired) return;
            const assets = toBig(decodeWords(assetsData)[0]);
            posEl.textContent = fmtToken(assets, STOCK_DECIMALS, 4) + ' ' + symbol;
          }
        } catch (e) { if (!mine.retired) console.warn('lend stats failed', e); }
      }
      refreshStats();
    }
    paint();
    return () => { if (paint._retire) paint._retire(); };
  }

  // ================================================================== Short view
  function renderShort(view) {
    view.appendChild(h('div', { class: 'view-head' }, h('h2', {}, 'Short'), h('div', { class: 'desk-note' }, 'Post USDG, borrow the stock, sell it on the DEX. hf = collateral·price·LLTV / borrow, scaled per SPEC §2 — liquidation at hf < 1.')));
    const picker = h('div', { class: 'field' }, h('label', {}, 'Stock'));
    let symbol = STATE.markets[0].symbol;
    const body = h('div');
    picker.appendChild(stockSelect((s) => { symbol = s; paint(); }, symbol));
    view.appendChild(picker);
    view.appendChild(body);

    function paint() {
      clear(body);
      const m = STATE.markets.find((x) => x.symbol === symbol);
      const deployed = isDeployed(m);
      const priceLine = h('div', { class: 'dim', style: 'margin-bottom:10px;font-size:12px' }, 'reference price: …');
      body.appendChild(priceLine);

      let refPrice = null;
      const calc = h('div', { class: 'panel' });
      calc.appendChild(h('h3', {}, 'Size calculator'));
      const collIn = h('input', { type: 'text', placeholder: '10000' });
      const modeSel = h('select', {}, h('option', { value: 'hf' }, 'target health factor'), h('option', { value: 'borrow' }, `target borrow (${symbol})`));
      const targetIn = h('input', { type: 'text', placeholder: '1.5' });
      const borrowEl = h('div', { class: 'value small' }, '—');
      const hfEl = h('div', { class: 'value' }, '—');
      const liqEl = h('div', { class: 'value small' }, '—');
      const out = h('div', { class: 'grid-3' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Borrow'), borrowEl),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Health factor'), hfEl),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Liquidation price'), liqEl)
      );
      calc.appendChild(h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', {}, 'Collateral (USDG)'), collIn),
        h('div', { class: 'field' }, h('label', {}, 'Mode'), modeSel),
        h('div', { class: 'field' }, h('label', {}, 'Target'), targetIn)
      ));
      calc.appendChild(out);
      body.appendChild(calc);

      function recompute() {
        const coll = parseFloat(collIn.value);
        const target = parseFloat(targetIn.value);
        hfEl.classList.remove('red');
        if (!refPrice || !isFinite(coll) || coll <= 0 || !isFinite(target) || target <= 0) {
          borrowEl.textContent = '—';
          hfEl.textContent = '—';
          liqEl.textContent = '—';
          return;
        }
        const lltv = m.lltvBps / 10000;
        const maxBorrowAtLtv = (coll * lltv) / refPrice.value; // SPEC §2: collateral*price/1e36*lltv/1e18, in human units
        let borrow, hf;
        if (modeSel.value === 'hf') { hf = target; borrow = maxBorrowAtLtv / hf; }
        else { borrow = target; hf = borrow > 0 ? maxBorrowAtLtv / borrow : Infinity; }
        const liq = hf * refPrice.value; // liqPrice = hf_current * currentPrice; matches LocateRouter.positionOf's own collateral*lltv*1e12/borrowAssets identically (see its NatSpec)
        borrowEl.textContent = fmtNum(borrow, 4) + ' ' + symbol;
        hfEl.textContent = isFinite(hf) ? hf.toFixed(3) : '∞';
        if (hf < 1.2) hfEl.classList.add('red');
        liqEl.textContent = fmtUsd(liq);
      }
      [collIn, targetIn, modeSel].forEach((elm) => elm.addEventListener('input', recompute));

      const mine = { retired: false };
      if (paint._retire) paint._retire();
      paint._retire = () => { mine.retired = true; };
      (async () => {
        const rp = await getReferencePrice(m);
        if (mine.retired) return;
        refPrice = rp;
        priceLine.textContent = rp ? `reference price: ${fmtUsd(rp.value)} (source: ${rp.source}${rp.source !== 'oracle' ? ' — oracle not deployed yet' : ''})` : 'reference price unavailable';
        recompute();
      })();

      // ---- action panel ----
      const actions = h('div', { class: 'panel' });
      actions.appendChild(h('h3', {}, 'Open'));
      if (!deployed) {
        actions.appendChild(h('div', { class: 'notice' }, h('strong', {}, `${symbol} market not created yet. `), 'Router and oracle addresses are empty in config/addresses.json — see locate/scripts/create-markets.js.'));
      } else if (!STATE.addresses.router) {
        actions.appendChild(h('div', { class: 'notice' }, h('strong', {}, 'Router not deployed yet. ')));
      } else {
        const openErr = h('div', { class: 'inline-error hidden' });
        const openBtn = h('button', {
          onclick: async () => {
            openErr.classList.add('hidden');
            if (!STATE.account) { openErr.textContent = 'connect wallet first'; openErr.classList.remove('hidden'); return; }
            const collRaw = parseAmount(collIn.value, STATE.addresses.usdgDecimals);
            const borrowText = borrowEl.textContent.split(' ')[0].replace(/,/g, '');
            const borrowRaw = parseAmount(borrowText, STOCK_DECIMALS);
            if (!collRaw || collRaw <= 0n || !borrowRaw || borrowRaw <= 0n) { openErr.textContent = 'set a collateral amount and target above'; openErr.classList.remove('hidden'); return; }
            openBtn.disabled = true;
            try { await doOpenShort(m, collRaw, borrowRaw); loadPositionPanel(); }
            catch (e) { openErr.textContent = describeError(e); openErr.classList.remove('hidden'); }
            openBtn.disabled = false;
          },
        }, `Authorize + Approve + Open ${symbol} short`);
        actions.appendChild(openBtn);
        actions.appendChild(openErr);
        actions.appendChild(h('div', { class: 'hint' }, 'One button does three steps if needed: setAuthorization(router, true) on Morpho, approve(router, collateral) on USDG, then openShort.'));
      }
      body.appendChild(actions);

      // ---- position panel ----
      const posPanel = h('div', { class: 'panel' }, h('h3', {}, 'Your position'));
      const posBody = h('div');
      posPanel.appendChild(posBody);
      body.appendChild(posPanel);

      async function loadPositionPanel() {
        clear(posBody);
        if (!deployed || !STATE.addresses.router) { posBody.appendChild(h('div', { class: 'dim' }, 'unavailable — market or router not deployed')); return; }
        if (!STATE.account) { posBody.appendChild(h('div', { class: 'dim' }, 'connect wallet to see your position')); return; }
        posBody.appendChild(h('div', { class: 'dim' }, 'loading…'));
        try {
          const mp = mpFor(m);
          const data = await ethCall(STATE.addresses.rpc, STATE.addresses.router, encodeCall('positionOf((address,address,address,address,uint256),address)', marketParamsTuple(mp), STATE.account));
          const w = decodeWords(data);
          const pos = { collateral: toBig(w[0]), borrowAssets: toBig(w[1]), maxBorrow: toBig(w[2]), healthFactorWad: toBig(w[3]), liquidationPrice: toBig(w[4]) };
          clear(posBody);
          const dex = await ensureDexData([m.token]);
          const pairUrl = dex.get(m.token.toLowerCase())?.url;
          posBody.appendChild(h('div', { class: 'grid-3' },
            h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Collateral'), h('div', { class: 'value small' }, fmtToken(pos.collateral, STATE.addresses.usdgDecimals, 2) + ' USDG')),
            h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Borrowed'), h('div', { class: 'value small' }, fmtToken(pos.borrowAssets, STOCK_DECIMALS, 4) + ' ' + symbol)),
            h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Health factor'), h('div', { class: `value${pos.healthFactorWad < (12n * 10n ** 17n) ? ' red' : ''}` }, fmtHf(pos.healthFactorWad)))
          ));
          posBody.appendChild(h('div', { class: 'dim', style: 'margin:8px 0;font-size:11px' }, `Max borrow ${fmtToken(pos.maxBorrow, STOCK_DECIMALS, 4)} ${symbol} · liquidation price ${fmtUsd(Number(pos.liquidationPrice) / 1e18)} USDG/share`));
          if (pairUrl) posBody.appendChild(h('div', { style: 'margin-bottom:10px' }, h('a', { href: pairUrl, target: '_blank', rel: 'noopener' }, `sell / buy back ${symbol} on DEX →`)));

          const addIn = h('input', { type: 'text', placeholder: '0.0' });
          const addErr = h('div', { class: 'inline-error hidden' });
          const addBtn = h('button', { class: 'ghost', onclick: async () => {
            addErr.classList.add('hidden');
            const raw = parseAmount(addIn.value, STATE.addresses.usdgDecimals);
            if (!raw || raw <= 0n) { addErr.textContent = 'enter an amount'; addErr.classList.remove('hidden'); return; }
            addBtn.disabled = true;
            try { await doAddCollateral(m, raw); addIn.value = ''; loadPositionPanel(); }
            catch (e) { addErr.textContent = describeError(e); addErr.classList.remove('hidden'); }
            addBtn.disabled = false;
          } }, 'Add collateral');

          const repayIn = h('input', { type: 'text', placeholder: '0.0' });
          const repayErr = h('div', { class: 'inline-error hidden' });
          const repayBtn = h('button', { class: 'ghost', onclick: async () => {
            repayErr.classList.add('hidden');
            const raw = parseAmount(repayIn.value, STOCK_DECIMALS);
            if (!raw || raw <= 0n) { repayErr.textContent = 'enter an amount'; repayErr.classList.remove('hidden'); return; }
            repayBtn.disabled = true;
            try { await doRepayAmount(m, raw); repayIn.value = ''; loadPositionPanel(); }
            catch (e) { repayErr.textContent = describeError(e); repayErr.classList.remove('hidden'); }
            repayBtn.disabled = false;
          } }, 'Repay');

          const closeErr = h('div', { class: 'inline-error hidden' });
          const closeBtn = h('button', { class: 'danger', onclick: async () => {
            closeErr.classList.add('hidden');
            closeBtn.disabled = true;
            try { await doCloseShort(m); loadPositionPanel(); }
            catch (e) { closeErr.textContent = describeError(e); closeErr.classList.remove('hidden'); }
            closeBtn.disabled = false;
          } }, `Close (repay all, withdraw all)`);

          posBody.appendChild(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Add collateral (USDG)'), addIn, addErr), h('div', {}, addBtn)));
          posBody.appendChild(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, `Repay (${symbol})`), repayIn, repayErr), h('div', {}, repayBtn)));
          posBody.appendChild(h('div', { class: 'actions' }, closeBtn, closeErr));
        } catch (e) {
          clear(posBody);
          posBody.appendChild(h('div', { class: 'dim' }, 'no position, or read failed: ' + describeError(e)));
        }
      }
      loadPositionPanel();
    }
    paint();
    return () => { if (paint._retire) paint._retire(); };
  }

  // ================================================================== Premium Board
  function renderPremium(view) {
    view.appendChild(h('div', { class: 'view-head' }, h('h2', {}, 'Premium Board'), h('div', { class: 'desk-note' }, 'Every Robinhood stock token with a live DEX pool on Robinhood Chain, DEX price vs the Robinhood 24/5 quote, sorted by |premium|.')));
    const status = h('div', { class: 'dim', style: 'margin-bottom:10px;font-size:12px' }, 'loading…');
    view.appendChild(status);
    const wrap = h('div', { class: 'table-wrap hidden' });
    const table = h('table');
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, 'Stock'), h('th', { class: 'num' }, 'DEX'), h('th', { class: 'num' }, 'Quote'),
      h('th', { class: 'num' }, 'Premium'), h('th', { class: 'num' }, '24h DEX vol'), h('th', {}, 'Status'), h('th', {}, '')
    )));
    const tbody = h('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    view.appendChild(wrap);

    let cancelled = false;
    (async () => {
      const quotes = await fetchQuotes();
      const assets = quotes.assets || [];
      if (STATE.quotesUnavailable || !assets.length) {
        clear(status);
        status.appendChild(h('div', { class: 'notice' },
          h('strong', {}, 'Robinhood registry unavailable. '),
          'The full board needs api/quotes.js (Vercel only) to list all Robinhood stock tokens — that API has no CORS for direct browser calls. Showing DEX data for the ten configured markets instead.'
        ));
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
        if (dep) bySymbolAddr.set(a.tokenSymbol, { addr: dep.contractAddress, name: a.tokenName });
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
      clear(status);
      status.appendChild(h('span', {}, `${rows.length} of ${bySymbolAddr.size} Robinhood-Chain tokens have a DEX pool. `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate(); } }, 'reload')));
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
      for (const r of withPrem) {
        const tr = h('tr', {},
          h('td', { class: 'sym' }, r.symbol, h('span', { class: 'name' }, r.name)),
          h('td', { class: 'num' }, fmtUsd(r.dex.priceUsd)),
          h('td', { class: 'num' }, r.q ? fmtUsd(r.q.mid) : '—'),
          h('td', { class: `num${r.prem !== null && Math.abs(r.prem) > 0.05 ? ' red' : ''}` }, r.prem !== null ? (r.prem >= 0 ? '+' : '') + fmtPct(r.prem) : '—'),
          h('td', { class: 'num' }, fmtUsd(r.dex.vol24, 0)),
          h('td', {}, r.q?.halted ? h('span', { class: 'badge halt' }, 'HALTED') : h('span', { class: 'badge live' }, 'live')),
          h('td', {}, h('a', { href: r.dex.url, target: '_blank', rel: 'noopener' }, 'pair →'))
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
        clear(el); el.appendChild(h('span', {}, 'block ', h('b', {}, BigInt(bn).toString())));
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
        el.appendChild(h('span', { class: STATE.quotesUnavailable ? 'red' : 'dim' }, STATE.quotesUnavailable ? 'feed unavailable' : 'feed —'));
        return;
      }
      const age = Math.max(0, Math.round(Date.now() / 1000 - STATE.quotesTs));
      el.appendChild(h('span', {}, 'feed ', h('b', {}, age + 's')));
    }, 1000);
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
    chainSeg.appendChild(h('span', {}, 'chain ', h('b', {}, `robinhood/${STATE.addresses.chainId}`)));

    document.getElementById('btn-connect').addEventListener('click', connectWallet);
    wireWalletEvents();
    startBlockPoller();
    startFeedTicker();
    fetchQuotes(); // warm the cache so the status bar's feed age has something to show quickly
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
