'use strict';
/**
 * Manna — app shell, router, wallet, and the five desks (plus the hero).
 * No build step, no framework. All chain reads/writes go through window.MANNA (lib.js).
 *
 * Organisation: constants + state, DOM helpers, toasts, chain-read primitives (chainCall/
 * multicall), wallet + transaction helpers, small UI builders shared by pages, the hash router,
 * one render function per page (each returns a cleanup callback clearing its own timers), boot().
 */
(function () {
  const M = window.MANNA;
  const enc = M.encodeCall;

  // ============================================================================ constants
  const ROUTES = ['storehouses', 'slings', 'tape', 'manna', 'sunday'];
  const CHAIN_ID_HEX = '0x1237'; // 4663
  const REFRESH_MS = 20000; // on-chain data poll
  const LOOKBACK_BLOCKS = 50000; // best-effort eth_getLogs window

  const TOPIC_DAWN = M.topic('Dawn(uint256,address,uint256,uint256,uint256,uint256,uint256)');
  const TOPIC_FALLEN = M.topic('Fallen(uint256,uint256,uint256,uint256,uint256)');
  const TOPIC_LIQUIDATE = M.topic('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');

  const VERSE_TEXT = '“Be not one of those who give pledges, who put up security for debts. '
    + 'If you have nothing with which to pay, why should your bed be taken from under you?”';

  const STATE = {
    addresses: null,
    markets: null,
    account: null,
    rpc: null,
    route: '',
    nextDawnTs: null, // cached from chain (or estimated locally pre-deploy)
    dawnOpen: false,
  };
  window.MANNA_STATE = STATE; // harmless inspection hook

  // ============================================================================ DOM helpers
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const spanClass = (text, cls) => h('span', { class: cls || '' }, text);

  /** One label/value line. `value` is a string or a Node; null/undefined renders as the dash. */
  function rowEl(label, value) {
    const v = h('span', { class: 'v' });
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = (value === null || value === undefined || value === '') ? M.DASH : String(value);
    return h('div', { class: 'row' }, h('span', { class: 'k' }, label), v);
  }
  const skelRow = (label) => rowEl(label, h('span', { class: 'skel' }));
  const notice = (text, kind) => h('div', { class: 'notice' + (kind ? ' ' + kind : '') }, text);
  const connectPrompt = (label) => h('button', { class: 'btn btn-ghost btn-block', onclick: connectWallet }, label || 'Connect wallet');

  /** Preserves the value (and focus) of any `[data-field]` input under `container` across a rebuild. */
  function withPreservedInputs(container, rebuild) {
    const saved = {};
    container.querySelectorAll('[data-field]').forEach((el) => {
      saved[el.dataset.field] = { value: el.value, focus: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd };
    });
    rebuild();
    container.querySelectorAll('[data-field]').forEach((el) => {
      const s = saved[el.dataset.field];
      if (!s) return;
      el.value = s.value;
      if (s.focus) { el.focus(); try { el.setSelectionRange(s.start, s.end); } catch { /* not a text-ish input */ } }
    });
  }

  // ============================================================================ toasts
  let toastSeq = 0;
  function renderToastBody(box, { kind, title, body, link, linkText }) {
    box.className = 'toast' + (kind ? ' ' + kind : '');
    clear(box);
    box.appendChild(h('div', { class: 't-title' }, title));
    if (body) box.appendChild(h('div', {}, body));
    if (link) box.appendChild(h('div', {}, h('a', { href: link, target: '_blank', rel: 'noopener' }, linkText || 'view on explorer')));
  }
  function toast(opts) {
    const id = ++toastSeq;
    const box = h('div', { id: 'toast-' + id });
    renderToastBody(box, opts);
    const host = document.getElementById('toasts');
    if (host) host.appendChild(box);
    if (opts.kind !== 'pending') setTimeout(() => box.remove(), opts.kind === 'error' ? 9000 : 6000);
    return id;
  }
  function updateToast(id, opts) {
    const box = document.getElementById('toast-' + id);
    if (!box) { toast(opts); return; }
    renderToastBody(box, opts);
    if (opts.kind !== 'pending') setTimeout(() => box.remove(), opts.kind === 'error' ? 9000 : 6000);
  }

  // ============================================================================ chain read primitives
  /** One ad-hoc eth_call. Returns raw hex, or null on any failure (bad address, revert, RPC error). */
  async function chainCall(to, sig, args) {
    if (!to) return null;
    try { return await STATE.rpc.call(to, enc(sig, ...(args || []))); }
    catch (e) { return null; }
  }
  /** Decodes raw hex against `types` (a single type or an array); null in, or a bad shape, is null out. */
  function safeDecode(raw, types) {
    if (raw === null || raw === undefined) return null;
    try { return M.decode(raw, types); } catch { return null; }
  }
  /**
   * Batched reads: specs = [{key, to, sig, args, types}]. Entries with a falsy `to` (not deployed)
   * resolve to null without being sent. Returns {key: decodedValueOrNull}.
   */
  async function multicall(specs) {
    const active = specs.filter((s) => s.to);
    const calls = active.map((s) => ({ to: s.to, data: enc(s.sig, ...(s.args || [])) }));
    const results = calls.length ? await STATE.rpc.callMany(calls) : [];
    const out = {};
    let i = 0;
    for (const s of specs) {
      if (!s.to) { out[s.key] = null; continue; }
      const r = results[i++];
      out[s.key] = (r && r.ok) ? safeDecode(r.result, s.types) : null;
    }
    return out;
  }
  const marketObjFromArr = (a) => (a ? {
    totalSupplyAssets: a[0], totalSupplyShares: a[1], totalBorrowAssets: a[2],
    totalBorrowShares: a[3], lastUpdate: a[4], fee: a[5],
  } : null);

  // ---- deployment gates -------------------------------------------------------------------
  const vaultAddrFor = (m) => ((STATE.addresses.vaults || {})[m.symbol] || '');
  const marketReady = (m) => !!(m.token && m.oracle && m.marketId);
  function marketParamsFor(m) {
    if (!m.token || !m.oracle) return null;
    const lltvBps = m.lltvBps != null ? m.lltvBps : STATE.addresses.lltvBps;
    return { loanToken: m.token, collateralToken: STATE.addresses.usdg, oracle: m.oracle, irm: STATE.addresses.adaptiveCurveIrm, lltv: M.lltvWad(lltvBps) };
  }

  /** Per-market Giant/vault decimals, fetched once and cached (defaults 18 / 24 until known). */
  const metaCache = new Map();
  function ensureMeta(m) {
    if (metaCache.has(m.symbol)) return metaCache.get(m.symbol);
    const p = (async () => {
      const vaultAddr = vaultAddrFor(m);
      const specs = [];
      if (m.token) specs.push({ key: 'gd', to: m.token, sig: 'decimals()', types: 'uint256' });
      if (vaultAddr) specs.push({ key: 'vd', to: vaultAddr, sig: 'decimals()', types: 'uint256' });
      const out = specs.length ? await multicall(specs) : {};
      return {
        vaultAddr,
        giantDecimals: out.gd != null ? Number(out.gd) : 18,
        vaultDecimals: out.vd != null ? Number(out.vd) : 24,
      };
    })();
    metaCache.set(m.symbol, p);
    return p;
  }

  /** Prophet price/spot, the Morpho market totals, and the IRM's current rate for one market. */
  async function loadMarketLive(m) {
    const out = { price: null, spot: null, market: null, rateWad: null, aprFrac: null, utilisation: null };
    if (!m.oracle) return out;
    const mp = marketParamsFor(m);
    const specs = [
      { key: 'price', to: m.oracle, sig: 'price()', types: 'uint256' },
      { key: 'spot', to: m.oracle, sig: 'spot()', types: 'uint256' },
    ];
    if (mp && m.marketId) {
      specs.push({
        key: 'marketData', to: STATE.addresses.morpho, sig: 'market(bytes32)', args: [m.marketId],
        types: ['uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128'],
      });
    }
    const res = await multicall(specs);
    out.price = res.price;
    out.spot = res.spot;
    const market = marketObjFromArr(res.marketData);
    if (market) {
      out.market = market;
      out.utilisation = market.totalSupplyAssets > 0n ? Number(market.totalBorrowAssets) / Number(market.totalSupplyAssets) : null;
      if (mp) {
        const rateRaw = await chainCall(
          STATE.addresses.adaptiveCurveIrm,
          'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
          [M.marketParamsTuple(mp), M.marketTuple(market)],
        );
        out.rateWad = safeDecode(rateRaw, 'uint256');
        out.aprFrac = out.rateWad != null ? M.aprFromRate(out.rateWad) : null;
      }
    }
    return out;
  }

  /** The Prophet vs spot, as a signed fraction in human USDG-per-Giant terms (positive = spot rich). */
  function lagFraction(priceRaw, spotRaw) {
    if (priceRaw === null || spotRaw === null || priceRaw <= 0n) return null;
    const hp = M.usdgPerGiant(priceRaw);
    const hs = M.usdgPerGiant(spotRaw);
    if (hp === null || hs === null || hp === 0) return null;
    return (hs - hp) / hp;
  }
  function lagNode(lag) {
    if (lag === null || lag === undefined || !isFinite(lag)) return M.DASH;
    const a = Math.abs(lag);
    const cls = a < 0.005 ? 'lag-ok' : a < 0.02 ? 'lag-warn' : 'lag-bad';
    return h('span', {}, h('span', { class: 'lag-dot ' + cls }), M.fmtSignedPct(lag));
  }
  function healthNode(hfWad) {
    if (hfWad === null || hfWad === undefined) return M.DASH;
    const str = M.fmtHf(hfWad);
    const cls = str === '∞' || hfWad >= 15n * 10n ** 17n ? 'health-good' : hfWad >= 11n * 10n ** 17n ? 'health-warn' : 'health-bad';
    return spanClass(str, cls);
  }

  // ============================================================================ event logs (best effort)
  async function fetchLogsSafe(address, topics) {
    try {
      const latest = await STATE.rpc.blockNumber();
      const from = Math.max(0, latest - LOOKBACK_BLOCKS);
      const logs = await STATE.rpc.getLogs({ address, fromBlock: '0x' + from.toString(16), toBlock: 'latest', topics });
      return { ok: true, logs: logs || [] };
    } catch (e) { return { ok: false, logs: [] }; }
  }
  function decodeDawnLog(log) {
    const day = M.decode(log.topics[1], 'uint256');
    const caller = M.decode(log.topics[2], 'address');
    const [income, toTreasury, toReserve, toCharity, spent] = M.decode(log.data, ['uint256', 'uint256', 'uint256', 'uint256', 'uint256']);
    return { day, caller, income, toTreasury, toReserve, toCharity, spent, blockNumber: log.blockNumber, txHash: log.transactionHash };
  }
  function decodeFallenLog(log) {
    const day = M.decode(log.topics[1], 'uint256');
    const [bought, tip, toStakers, toLenders] = M.decode(log.data, ['uint256', 'uint256', 'uint256', 'uint256']);
    return { day, bought, tip, toStakers, toLenders, blockNumber: log.blockNumber, txHash: log.transactionHash };
  }
  function decodeLiquidateLog(log) {
    const id = log.topics[1];
    const caller = M.decode(log.topics[2], 'address');
    const borrower = M.decode(log.topics[3], 'address');
    const [repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares] = M.decode(log.data, ['uint256', 'uint256', 'uint256', 'uint256', 'uint256']);
    return { id, caller, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares, blockNumber: log.blockNumber, txHash: log.transactionHash };
  }
  async function loadLastDawn() {
    if (!STATE.addresses.manna) return { state: 'nodeploy', dawn: null, fallen: null };
    const { ok, logs } = await fetchLogsSafe(STATE.addresses.manna, [[TOPIC_DAWN, TOPIC_FALLEN]]);
    if (!ok) return { state: 'unavailable', dawn: null, fallen: null };
    if (!logs.length) return { state: 'empty', dawn: null, fallen: null };
    logs.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
    let dawnLog = null, fallenLog = null;
    for (const log of logs) {
      const t0 = (log.topics[0] || '').toLowerCase();
      if (t0 === TOPIC_DAWN && !dawnLog) dawnLog = log;
      if (t0 === TOPIC_FALLEN && !fallenLog) fallenLog = log;
      if (dawnLog && fallenLog) break;
    }
    return { state: 'ok', dawn: dawnLog ? decodeDawnLog(dawnLog) : null, fallen: fallenLog ? decodeFallenLog(fallenLog) : null };
  }
  async function loadLiquidations() {
    if (!STATE.addresses.morpho) return { state: 'unavailable', items: [] };
    const ids = STATE.markets.filter((m) => m.marketId).map((m) => m.marketId);
    if (!ids.length) return { state: 'none', items: [] };
    const { ok, logs } = await fetchLogsSafe(STATE.addresses.morpho, [TOPIC_LIQUIDATE, ids]);
    if (!ok) return { state: 'unavailable', items: [] };
    const bySymbol = new Map(STATE.markets.filter((m) => m.marketId).map((m) => [m.marketId.toLowerCase(), m.symbol]));
    const items = logs.map(decodeLiquidateLog).map((x) => ({ ...x, symbol: bySymbol.get(String(x.id).toLowerCase()) || '?' }));
    items.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16));
    return { state: 'ok', items };
  }

  // ============================================================================ wallet
  async function ensureChain() {
    if (!window.ethereum) return false;
    try {
      const cur = await window.ethereum.request({ method: 'eth_chainId' });
      if (String(cur).toLowerCase() === CHAIN_ID_HEX) return true;
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
        return true;
      } catch (switchErr) {
        if (switchErr && switchErr.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: 'Robinhood Chain',
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [STATE.addresses.rpc],
              blockExplorerUrls: STATE.addresses.explorer ? [STATE.addresses.explorer] : [],
            }],
          });
          return true;
        }
        toast({ kind: 'error', title: 'Wrong network', body: M.describeError(switchErr) });
        return false;
      }
    } catch (e) {
      toast({ kind: 'error', title: 'Network check failed', body: M.describeError(e) });
      return false;
    }
  }
  async function connectWallet() {
    if (!window.ethereum) {
      toast({ kind: 'error', title: 'No wallet found', body: 'Install a browser wallet extension (e.g. MetaMask) and reload the page.' });
      return;
    }
    try {
      const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      STATE.account = accs && accs[0] ? accs[0] : null;
      await ensureChain();
      await updateWalletUI();
      refreshCurrentPage();
    } catch (e) {
      toast({ kind: 'error', title: 'Connect failed', body: M.describeError(e) });
    }
  }
  async function updateWalletUI() {
    const seg = document.getElementById('wallet-slot');
    if (!seg) return;
    clear(seg);
    if (!STATE.account) { seg.appendChild(h('button', { class: 'btn btn-primary btn-sm', onclick: connectWallet }, 'Connect wallet')); return; }
    const balSpan = h('span', { class: 'wallet-bal mono' }, '…');
    seg.appendChild(h('span', { class: 'wallet-addr' }, M.shortAddr(STATE.account)));
    seg.appendChild(balSpan);
    const raw = await chainCall(STATE.addresses.usdg, 'balanceOf(address)', [STATE.account]);
    const bal = safeDecode(raw, 'uint256');
    balSpan.textContent = bal !== null ? M.fmtUsdg(bal, 2) + ' USDG' : '';
  }
  function wireWalletEvents() {
    if (!window.ethereum || typeof window.ethereum.on !== 'function') return;
    window.ethereum.on('accountsChanged', (accs) => {
      STATE.account = accs && accs[0] ? accs[0] : null;
      updateWalletUI();
      refreshCurrentPage();
    });
    window.ethereum.on('chainChanged', () => location.reload());
  }

  // ============================================================================ transactions
  async function waitReceipt(hash) {
    for (let i = 0; i < 180; i++) {
      let r = null;
      try { r = await STATE.rpc.rpc('eth_getTransactionReceipt', [hash]); } catch { /* keep polling */ }
      if (r) return r;
      await M.sleep(2000);
    }
    throw new Error('Timed out waiting for a confirmation. Check the explorer.');
  }
  async function sendTx({ to, data, title }) {
    if (!STATE.account) { await connectWallet(); throw new Error('Connect your wallet first.'); }
    const id = toast({ kind: 'pending', title: title ? title + '…' : 'Sending…', body: 'Confirm in your wallet.' });
    try {
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: STATE.account, to, data }] });
      const link = STATE.addresses.explorer ? STATE.addresses.explorer + '/tx/' + hash : null;
      updateToast(id, { kind: 'pending', title: 'Submitted', body: M.shortAddr(hash), link, linkText: 'view transaction' });
      const receipt = await waitReceipt(hash);
      const ok = receipt && (receipt.status === '0x1' || receipt.status === 1);
      updateToast(id, { kind: ok ? 'success' : 'error', title: ok ? (title || 'Confirmed') + ' — confirmed' : 'Reverted', body: M.shortAddr(hash), link, linkText: 'view transaction' });
      if (!ok) throw new Error('Transaction reverted on-chain.');
      return receipt;
    } catch (e) {
      updateToast(id, { kind: 'error', title: 'Failed', body: M.describeError(e) });
      throw e;
    }
  }
  async function ensureAllowance(token, spender, neededRaw, label) {
    if (!neededRaw || neededRaw <= 0n) return;
    const cur = safeDecode(await chainCall(token, 'allowance(address,address)', [STATE.account, spender]), 'uint256');
    if (cur !== null && cur >= neededRaw) return;
    await sendTx({ to: token, data: enc('approve(address,uint256)', spender, neededRaw), title: 'Approve ' + (label || 'token') });
  }
  async function ensureMorphoAuth(spender) {
    const cur = safeDecode(await chainCall(STATE.addresses.morpho, 'isAuthorized(address,address)', [STATE.account, spender]), 'bool');
    if (cur === true) return;
    await sendTx({ to: STATE.addresses.morpho, data: enc('setAuthorization(address,bool)', spender, true), title: 'Authorize router on Morpho' });
  }
  /** Wires a click handler that disables the button and shows a spinner while `fn` runs. */
  function wireAction(btn, fn, pendingLabel) {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const label = btn.textContent;
      btn.disabled = true;
      clear(btn);
      btn.appendChild(h('span', { class: 'spinner' }));
      btn.appendChild(document.createTextNode(' ' + (pendingLabel || 'Working…')));
      try { await fn(); }
      catch (e) { /* sendTx / callers already toast details */ }
      finally { btn.disabled = false; clear(btn); btn.appendChild(document.createTextNode(label)); }
    });
  }

  // ============================================================================ shared UI builders
  /** A labeled amount input; `field` keys it for withPreservedInputs. An optional Max button fills it
   *  from `getMaxRaw()` (called lazily on click, so it always uses the freshest known balance). */
  function amountField({ label, field, decimals, placeholder, getMaxRaw }) {
    const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: placeholder || '0.0', 'data-field': field });
    const hint = h('div', { class: 'hint' });
    const maxBtn = getMaxRaw ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Max') : null;
    if (maxBtn) maxBtn.addEventListener('click', () => {
      const raw = getMaxRaw();
      if (raw === null || raw === undefined) return;
      input.value = M.fmtUnits(raw, decimals, decimals).replace(/,/g, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const wrap = h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'input-row' }, input, maxBtn), hint);
    return {
      wrap, input, hint,
      raw: () => M.parseAmount(input.value, decimals),
      setHint(text, err) { hint.textContent = text || ''; hint.classList.toggle('err', !!err); },
    };
  }

  /** The global autoStake toggle (Manna.autoStake / setAutoStake), reused on Storehouse cards and the Manna page. */
  function autoStakeToggle(current) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!current;
    const label = h('label', { class: 'toggle' }, input, h('span', { class: 'track' }), 'Auto-stake what you gather');
    if (!STATE.account || !STATE.addresses.manna) input.disabled = true;
    input.addEventListener('change', async () => {
      const want = input.checked;
      input.disabled = true;
      try {
        await sendTx({ to: STATE.addresses.manna, data: enc('setAutoStake(bool)', want), title: want ? 'Enable auto-stake' : 'Disable auto-stake' });
        refreshCurrentPage();
      } catch (e) {
        input.checked = !want;
        input.disabled = false;
      }
    });
    return label;
  }

  /** One numbered step in the Slings flow. state: 'todo' | 'active' | 'done'. */
  function stepRow(num, title, desc) {
    const numEl = h('div', { class: 'step-num' }, String(num));
    const body = h('div', { class: 'step-body' }, h('div', { class: 'step-title' }, title), h('div', { class: 'step-desc' }, desc));
    const action = h('div', { class: 'btn-row' });
    const el = h('div', { class: 'step' }, numEl, body, action);
    return {
      el, action,
      setState(state) {
        el.classList.remove('done', 'active');
        if (state === 'done') { el.classList.add('done'); numEl.textContent = '✓'; }
        else { numEl.textContent = String(num); if (state === 'active') el.classList.add('active'); }
      },
    };
  }

  const badgeFor = (m) => (m.hold ? h('span', { class: 'badge badge-hold' }, 'on hold') : null);
  const explorerAddrLink = (addr, label) => (STATE.addresses.explorer && addr
    ? h('a', { href: STATE.addresses.explorer + '/address/' + addr, target: '_blank', rel: 'noopener' }, label || M.shortAddr(addr))
    : spanClass(addr ? M.shortAddr(addr) : M.DASH, 'dim'));

  // ============================================================================ masthead
  function startBlockPoller() {
    const el = document.getElementById('chip-block');
    if (!el) return () => {};
    async function tick() {
      try { el.textContent = 'block ' + (await STATE.rpc.blockNumber()).toLocaleString('en-US'); }
      catch { el.textContent = 'block ' + M.DASH; }
    }
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }
  /** Refreshes the cached nextDawn/dawnOpen from chain every 30s (or estimates locally pre-deploy), and
   *  ticks the masthead chip every second from that cache. */
  function startDawnChip() {
    const el = document.getElementById('chip-dawn');
    if (!el) return () => {};
    async function refresh() {
      if (STATE.addresses.manna) {
        const out = await multicall([
          { key: 'next', to: STATE.addresses.manna, sig: 'nextDawn()', types: 'uint256' },
          { key: 'open', to: STATE.addresses.manna, sig: 'dawnOpen()', types: 'bool' },
        ]);
        STATE.nextDawnTs = out.next !== null ? Number(out.next) : null;
        STATE.dawnOpen = !!out.open;
      } else {
        STATE.nextDawnTs = M.localNextDawn();
        STATE.dawnOpen = false;
      }
    }
    function tick() {
      el.classList.toggle('warn', STATE.dawnOpen);
      if (STATE.dawnOpen) { el.textContent = 'dawn is open'; return; }
      if (STATE.nextDawnTs === null) { el.textContent = 'dawn —'; return; }
      el.textContent = 'dawn in ' + M.fmtCountdown(STATE.nextDawnTs - M.nowSec());
    }
    refresh().then(tick);
    const slow = setInterval(() => refresh().then(tick), 30000);
    const fast = setInterval(tick, 1000);
    return () => { clearInterval(slow); clearInterval(fast); };
  }
  function initMasthead() {
    const chainSeg = document.getElementById('chip-chain');
    if (chainSeg) chainSeg.textContent = 'Robinhood Chain · ' + STATE.addresses.chainId;
    const footChain = document.getElementById('foot-chain');
    if (footChain) footChain.textContent = 'Robinhood Chain · ' + STATE.addresses.chainId;
    const footExplorer = document.getElementById('foot-explorer');
    if (footExplorer && STATE.addresses.explorer) footExplorer.href = STATE.addresses.explorer;
    const toggle = document.getElementById('nav-toggle');
    const nav = document.getElementById('nav');
    if (toggle && nav) toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => nav.classList.remove('open')));
    startBlockPoller();
    startDawnChip();
    updateWalletUI();
  }

  // ============================================================================ router
  const RENDERERS = {
    hero: renderHero, storehouses: renderStorehouses, slings: renderSlings,
    tape: renderTape, manna: renderManna, sunday: renderSunday,
  };
  let cleanupFn = null;
  function setActiveNav(route) {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  }
  function renderRoute() {
    const view = document.getElementById('view');
    clear(view);
    view.scrollTop = 0;
    cleanupFn = RENDERERS[STATE.route](view) || null;
  }
  function navigate() {
    if (cleanupFn) { try { cleanupFn(); } catch { /* noop */ } cleanupFn = null; }
    const raw = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
    STATE.route = (raw === '' || !ROUTES.includes(raw)) ? (raw === '' ? 'hero' : 'hero') : raw;
    setActiveNav(STATE.route);
    renderRoute();
  }
  /** Re-renders the current page in place (after a tx, an account switch, etc.) without touching the hash. */
  function refreshCurrentPage() {
    if (cleanupFn) { try { cleanupFn(); } catch { /* noop */ } cleanupFn = null; }
    renderRoute();
  }

  // ============================================================================ page: hero (#/)
  function renderHero(view) {
    view.appendChild(h('div', { class: 'hero' },
      h('h1', {}, 'Manna'),
      h('p', { class: 'lede' },
        'The short desk for memecoins on Robinhood Chain. Lend a Giant and earn what the shorts pay. '
        + 'Sling a Giant. Every morning, Manna falls.'),
      h('div', { class: 'hero-actions' },
        h('a', { class: 'btn btn-primary', href: '#/storehouses' }, 'Enter a Storehouse'),
        h('a', { class: 'btn btn-ghost', href: '#/slings' }, 'Sling a Giant'),
        h('a', { class: 'btn btn-ghost', href: '#/tape' }, 'Watch the Tape')),
      h('p', { class: 'hero-foot' }, 'A memecoin with a product — unaudited and leveraged. See the footer before you use it.')));
    return null;
  }

  // ============================================================================ page: storehouses
  function renderStorehouses(view) {
    view.appendChild(h('div', { class: 'page-head' },
      h('h1', {}, 'Storehouses'),
      h('p', { class: 'page-lede' }, 'Lend a Giant into its Storehouse and earn the borrow rate the shorts pay, in the Giant itself, plus Manna every morning.')));
    if (!STATE.markets || !STATE.markets.length) { view.appendChild(notice('No markets configured.')); return null; }
    const grid = h('div', { class: 'cards-grid' });
    view.appendChild(grid);
    const cards = STATE.markets.map((m) => buildStorehouseCard(m));
    cards.forEach((c) => grid.appendChild(c.el));
    const run = () => cards.forEach((c) => c.load());
    run();
    const id = setInterval(run, REFRESH_MS);
    return () => clearInterval(id);
  }

  /** Builds one Storehouse card's static shell; `load()` is safe to call repeatedly on a timer. */
  function buildStorehouseCard(m) {
    const vaultAddr = vaultAddrFor(m);
    const body = h('div', {}, skelRow('Borrow rate (APR)'), skelRow('Utilisation'), skelRow('Short interest'));
    const el = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, m.symbol, badgeFor(m)), h('span', { class: 'card-sub' }, m.name)),
      body);

    async function load() {
      if (!m.token) { clear(body); body.appendChild(notice(m.symbol + ' has no token yet — not deployed.')); return; }
      if (!vaultAddr) { clear(body); body.appendChild(notice('Storehouse not deployed yet for ' + m.symbol + '.')); return; }

      const meta = await ensureMeta(m);
      const specs = [
        { key: 'totalAssets', to: vaultAddr, sig: 'totalAssets()', types: 'uint256' },
        { key: 'liquidity', to: vaultAddr, sig: 'liquidity()', types: 'uint256' },
      ];
      if (STATE.addresses.manna) specs.push({ key: 'feeShares', to: STATE.addresses.manna, sig: 'feeShares(address)', args: [vaultAddr], types: 'uint256' });
      if (STATE.account && STATE.addresses.manna) {
        specs.push({ key: 'lenderOf', to: STATE.addresses.manna, sig: 'lenderOf(address,address)', args: [vaultAddr, STATE.account], types: ['uint256', 'uint256', 'uint256', 'uint256'] });
        specs.push({ key: 'autoStake', to: STATE.addresses.manna, sig: 'autoStake(address)', args: [STATE.account], types: 'bool' });
        specs.push({ key: 'giantBal', to: m.token, sig: 'balanceOf(address)', args: [STATE.account], types: 'uint256' });
      }
      const [out, live] = await Promise.all([multicall(specs), marketReady(m) ? loadMarketLive(m) : null]);

      let titheAssets = null;
      if (out.feeShares !== null) titheAssets = safeDecode(await chainCall(vaultAddr, 'convertToAssets(uint256)', [out.feeShares]), 'uint256');
      let yourShares = null, yourFresh = null, yourSpoiled = null, yourAssets = null;
      if (out.lenderOf) {
        [yourShares, yourFresh, yourSpoiled] = out.lenderOf;
        if (yourShares > 0n) yourAssets = safeDecode(await chainCall(vaultAddr, 'convertToAssets(uint256)', [yourShares]), 'uint256');
      }
      const shortInterest = (out.totalAssets !== null && out.liquidity !== null && out.totalAssets > out.liquidity) ? out.totalAssets - out.liquidity : (out.totalAssets !== null ? 0n : null);
      const shortInterestUsd = (shortInterest !== null && live && live.price !== null) ? M.giantToUsd(shortInterest, live.price) : null;

      withPreservedInputs(body, () => {
        clear(body);
        const rows = h('div', { class: 'rows' });
        rows.appendChild(rowEl('Borrow rate (APR)', marketReady(m) ? (live.aprFrac !== null ? spanClass(M.fmtPct(live.aprFrac), 'pos') : M.DASH) : 'market not created yet'));
        rows.appendChild(rowEl('Utilisation', marketReady(m) && live.utilisation !== null ? M.fmtPct(live.utilisation) : M.DASH));
        rows.appendChild(rowEl('Short interest', shortInterest !== null ? M.fmtUnits(shortInterest, meta.giantDecimals, 4) + ' ' + m.symbol : M.DASH));
        rows.appendChild(rowEl('Short interest (USD)', shortInterestUsd !== null ? M.fmtUsd(shortInterestUsd) : M.DASH));
        rows.appendChild(rowEl('Cap left (liquidity)', out.totalAssets !== null && out.liquidity !== null
          ? M.fmtUnits(out.liquidity, meta.giantDecimals, 2) + ' of ' + M.fmtUnits(out.totalAssets, meta.giantDecimals, 2) + ' ' + m.symbol
          : M.DASH));
        rows.appendChild(rowEl('Tithe waiting (10%)', STATE.addresses.manna ? (titheAssets !== null ? M.fmtUnits(titheAssets, meta.giantDecimals, 4) + ' ' + m.symbol : M.DASH) : 'Manna not deployed yet'));
        body.appendChild(rows);
        body.appendChild(h('div', { class: 'divider' }));
        body.appendChild(h('p', { class: 'small' }, 'Lenders earn the borrow rate in ' + m.symbol + ', plus Manna every morning.'));

        const posWrap = h('div', {});
        body.appendChild(posWrap);
        if (!STATE.addresses.manna) {
          posWrap.appendChild(notice('The Manna contract is not deployed yet — deposits open once it is.'));
        } else if (!STATE.account) {
          posWrap.appendChild(connectPrompt('Connect wallet to lend'));
        } else {
          const posRows = h('div', { class: 'rows' });
          posRows.appendChild(rowEl('Your position', yourAssets !== null ? M.fmtUnits(yourAssets, meta.giantDecimals, 4) + ' ' + m.symbol : (yourShares === 0n ? 'none yet' : M.DASH)));
          posRows.appendChild(rowEl('Gatherable now', yourFresh !== null ? M.fmtToken(yourFresh, 4) + ' MANNA' : M.DASH));
          posRows.appendChild(rowEl('Spoiled next gather', yourSpoiled !== null ? M.fmtToken(yourSpoiled, 4) + ' MANNA' : M.DASH));
          posWrap.appendChild(posRows);

          const enterF = amountField({ label: 'Enter ' + m.symbol, field: 'enter-' + m.symbol, decimals: meta.giantDecimals, getMaxRaw: () => out.giantBal });
          const enterBtn = h('button', { class: 'btn btn-primary btn-sm' }, 'Enter');
          wireAction(enterBtn, async () => {
            const raw = enterF.raw();
            if (!raw || raw <= 0n) { enterF.setHint('Enter an amount.', true); return; }
            await ensureAllowance(m.token, STATE.addresses.manna, raw, m.symbol);
            await sendTx({ to: STATE.addresses.manna, data: enc('enter(address,uint256)', vaultAddr, raw), title: 'Enter ' + m.symbol });
            refreshCurrentPage();
          }, 'Entering…');
          enterF.wrap.appendChild(h('div', { class: 'btn-row' }, enterBtn));
          posWrap.appendChild(enterF.wrap);

          const leaveF = amountField({ label: 'Leave (shares)', field: 'leave-' + m.symbol, decimals: meta.vaultDecimals, getMaxRaw: () => yourShares });
          const leaveBtn = h('button', { class: 'btn btn-ghost btn-sm' }, 'Leave');
          wireAction(leaveBtn, async () => {
            const raw = leaveF.raw();
            if (!raw || raw <= 0n) { leaveF.setHint('Enter a share amount, or Max.', true); return; }
            if (yourShares !== null && raw > yourShares) { leaveF.setHint('More than you hold.', true); return; }
            await sendTx({ to: STATE.addresses.manna, data: enc('leave(address,uint256)', vaultAddr, raw), title: 'Leave ' + m.symbol });
            refreshCurrentPage();
          }, 'Leaving…');
          leaveF.wrap.appendChild(h('div', { class: 'btn-row' }, leaveBtn));
          posWrap.appendChild(leaveF.wrap);

          const gatherBtn = h('button', { class: 'btn btn-ghost btn-sm', disabled: !yourFresh && !yourSpoiled }, 'Gather');
          wireAction(gatherBtn, async () => { await sendTx({ to: STATE.addresses.manna, data: enc('gather(address)', vaultAddr), title: 'Gather ' + m.symbol }); refreshCurrentPage(); }, 'Gathering…');
          posWrap.appendChild(h('div', { class: 'btn-row', style: 'margin-top:8px' }, gatherBtn));
          posWrap.appendChild(h('div', { class: 'divider' }));
          posWrap.appendChild(autoStakeToggle(out.autoStake));
        }
      });
    }
    return { el, load };
  }

  // ============================================================================ page: slings
  function renderSlings(view) {
    view.appendChild(h('div', { class: 'page-head' },
      h('h1', {}, 'Slings'),
      h('p', { class: 'page-lede' }, 'Post USDG as collateral, borrow a Giant, and sell it — the only bear trade on the chain.')));
    if (!STATE.markets || !STATE.markets.length) { view.appendChild(notice('No markets configured.')); return null; }

    const select = h('select', {}, ...STATE.markets.map((m) => h('option', { value: m.symbol, disabled: !marketReady(m) },
      m.symbol + (marketReady(m) ? '' : ' — market not created yet') + (m.hold ? ' (on hold)' : ''))));
    const firstReady = STATE.markets.find(marketReady) || STATE.markets[0];
    select.value = firstReady.symbol;

    const panel = h('div', { class: 'stack' });
    view.appendChild(h('div', { class: 'stack' }, h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', {}, 'Giant'), select)), panel));

    let panelCleanup = null;
    function load(symbol) {
      if (panelCleanup) { try { panelCleanup(); } catch { /* noop */ } }
      clear(panel);
      const m = STATE.markets.find((x) => x.symbol === symbol) || firstReady;
      panelCleanup = buildSlingsPanel(panel, m);
    }
    select.addEventListener('change', () => load(select.value));
    load(select.value);
    return () => { if (panelCleanup) try { panelCleanup(); } catch { /* noop */ } };
  }

  function buildSlingsPanel(container, m) {
    if (!m.token) { container.appendChild(notice(m.symbol + ' has not launched a token yet.')); return null; }
    if (!marketReady(m)) {
      container.appendChild(notice('The ' + m.symbol + ' market has not been created on Morpho yet. Check back after listing.' + (m.hold ? ' (' + m.symbol + ' is currently on hold.)' : '')));
      return null;
    }
    const mp = marketParamsFor(m);
    let meta = { giantDecimals: 18, vaultDecimals: 24 };
    let cache = { price: null, spot: null, market: null, aprFrac: null };
    let usdgBal = null, giantBal = null;

    const collat = amountField({ label: 'Collateral (USDG)', field: 'sling-collateral', decimals: 6, getMaxRaw: () => usdgBal });
    const verse = h('div', { class: 'verse' }, VERSE_TEXT, h('cite', {}, 'Proverbs 22:26–27'));
    const borrowF = amountField({ label: 'Borrow (' + m.symbol + ')', field: 'sling-borrow', decimals: meta.giantDecimals });
    const liveRows = h('div', { class: 'rows' });
    const formCard = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Open a sling'), collat.wrap, verse, borrowF.wrap, h('div', { class: 'divider' }), liveRows);

    const step1 = stepRow(1, 'Authorize the router', 'One-time: let LocateRouter act for you on Morpho.');
    const step2 = stepRow(2, 'Approve USDG', 'Let the router pull your collateral.');
    const step3 = stepRow(3, 'Open the short', 'Post collateral, borrow ' + m.symbol + ', send it to your wallet.');
    const stepsCard = STATE.addresses.router
      ? h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Steps'), h('div', { class: 'steps' }, step1.el, step2.el, step3.el))
      : notice('LocateRouter is not deployed yet — slings open once it is.');

    const sellCard = h('div', { class: 'card' });
    sellCard.hidden = true;

    const posRows = h('div', { class: 'rows' });
    const posCard = h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Your position'), posRows);

    container.appendChild(formCard);
    container.appendChild(stepsCard);
    container.appendChild(sellCard);
    container.appendChild(posCard);

    function recomputeLive() {
      clear(liveRows);
      const collRaw = collat.raw() || 0n;
      const borrowRaw = borrowF.raw() || 0n;
      const price = cache.price;
      const maxBorrow = price !== null ? M.maxBorrowRaw(collRaw, price, mp.lltv) : null;
      const liq = borrowRaw > 0n ? M.liqPriceWad(collRaw, mp.lltv, borrowRaw) : null;
      const health = (maxBorrow !== null && borrowRaw > 0n) ? M.healthWad(maxBorrow, borrowRaw) : null;
      liveRows.appendChild(rowEl('Prophet price (30m TWAP)', price !== null ? M.fmtPrice(M.usdgPerGiant(price)) + ' / ' + m.symbol : M.DASH));
      liveRows.appendChild(rowEl('Spot vs Prophet', lagNode(lagFraction(cache.price, cache.spot))));
      liveRows.appendChild(rowEl('Borrow rate (APR)', cache.aprFrac !== null ? M.fmtPct(cache.aprFrac) : M.DASH));
      liveRows.appendChild(rowEl('Max borrow at this collateral', maxBorrow !== null ? M.fmtUnits(maxBorrow, meta.giantDecimals, 4) + ' ' + m.symbol : M.DASH));
      liveRows.appendChild(rowEl('Liquidation price', liq !== null && liq > 0n ? M.fmtPrice(M.toNumber(liq, 18)) + ' / ' + m.symbol : M.DASH));
      liveRows.appendChild(rowEl('Health factor', borrowRaw > 0n ? healthNode(health) : M.DASH));
    }
    collat.input.addEventListener('input', recomputeLive);
    borrowF.input.addEventListener('input', recomputeLive);

    async function refreshSteps() {
      if (!STATE.addresses.router) return;
      if (!STATE.account) {
        step1.setState('todo'); clear(step1.action); step1.action.appendChild(connectPrompt('Connect wallet'));
        step2.setState('todo'); clear(step2.action);
        step3.setState('todo'); clear(step3.action);
        return;
      }
      const authed = safeDecode(await chainCall(STATE.addresses.morpho, 'isAuthorized(address,address)', [STATE.account, STATE.addresses.router]), 'bool');
      const collRaw = collat.raw() || 0n;
      const allowance = safeDecode(await chainCall(STATE.addresses.usdg, 'allowance(address,address)', [STATE.account, STATE.addresses.router]), 'uint256');

      clear(step1.action);
      if (authed) { step1.setState('done'); }
      else {
        step1.setState('active');
        const b = h('button', { class: 'btn btn-primary btn-sm' }, 'Authorize');
        wireAction(b, async () => { await ensureMorphoAuth(STATE.addresses.router); await refreshSteps(); }, 'Authorizing…');
        step1.action.appendChild(b);
      }

      clear(step2.action);
      const covered = allowance !== null && collRaw > 0n && allowance >= collRaw;
      if (covered) { step2.setState('done'); }
      else {
        step2.setState(authed ? 'active' : 'todo');
        const b = h('button', { class: 'btn btn-primary btn-sm', disabled: !authed }, 'Approve USDG');
        wireAction(b, async () => {
          const raw = collat.raw();
          if (!raw || raw <= 0n) { collat.setHint('Enter collateral first.', true); return; }
          await ensureAllowance(STATE.addresses.usdg, STATE.addresses.router, raw, 'USDG');
          await refreshSteps();
        }, 'Approving…');
        step2.action.appendChild(b);
      }

      clear(step3.action);
      const borrowRaw = borrowF.raw() || 0n;
      const ready3 = authed && covered && borrowRaw > 0n;
      step3.setState(ready3 ? 'active' : 'todo');
      const b3 = h('button', { class: 'btn btn-primary btn-sm', disabled: !ready3 }, 'Open short');
      wireAction(b3, async () => {
        const cRaw = collat.raw(), bRaw = borrowF.raw();
        if (!cRaw || cRaw <= 0n || !bRaw || bRaw <= 0n) { toast({ kind: 'error', title: 'Enter both collateral and a borrow amount.' }); return; }
        await sendTx({
          to: STATE.addresses.router,
          data: enc('openShort((address,address,address,address,uint256),uint256,uint256,address)', M.marketParamsTuple(mp), cRaw, bRaw, STATE.account),
          title: 'Open ' + m.symbol + ' short',
        });
        clear(sellCard); sellCard.hidden = false;
        sellCard.appendChild(h('h3', { class: 'card-title' }, 'Sell it'));
        sellCard.appendChild(h('p', {}, 'You now hold ' + m.symbol + '. Sell it on the open market to complete the short — closing the sling later means buying it back.'));
        const link = m.pool && STATE.addresses.explorer ? STATE.addresses.explorer + '/address/' + m.pool : null;
        sellCard.appendChild(link ? h('a', { class: 'btn btn-ghost btn-sm', href: link, target: '_blank', rel: 'noopener' }, 'View ' + m.symbol + ' pool ↗') : notice('No pool link configured for ' + m.symbol + ' yet.'));
        await refreshSteps();
        await refreshPosition();
      }, 'Opening…');
      step3.action.appendChild(b3);
    }

    async function refreshPosition() {
      const saved = {};
      posRows.querySelectorAll('[data-field]').forEach((el) => { saved[el.dataset.field] = { value: el.value, focus: document.activeElement === el }; });
      clear(posRows);
      if (!STATE.addresses.router) { posRows.appendChild(rowEl('Position', 'router not deployed yet')); return; }
      if (!STATE.account) { posRows.appendChild(rowEl('Position', 'connect wallet')); return; }
      const raw = await chainCall(STATE.addresses.router, 'positionOf((address,address,address,address,uint256),address)', [M.marketParamsTuple(mp), STATE.account]);
      const dec = safeDecode(raw, ['uint256', 'uint256', 'uint256', 'uint256', 'uint256']);
      if (!dec) { posRows.appendChild(rowEl('Position', M.DASH)); return; }
      const [collateral, borrowAssets, maxBorrow, healthFactorWad, liquidationPrice] = dec;
      posRows.appendChild(rowEl('Collateral posted', M.fmtUsdg(collateral, 2) + ' USDG'));
      posRows.appendChild(rowEl('Borrowed', M.fmtUnits(borrowAssets, meta.giantDecimals, 4) + ' ' + m.symbol));
      posRows.appendChild(rowEl('Max borrow at current price', M.fmtUnits(maxBorrow, meta.giantDecimals, 4) + ' ' + m.symbol));
      posRows.appendChild(rowEl('Health factor', borrowAssets > 0n ? healthNode(healthFactorWad) : spanClass('no borrow', 'dim')));
      posRows.appendChild(rowEl('Liquidation price', borrowAssets > 0n ? M.fmtPrice(M.toNumber(liquidationPrice, 18)) + ' / ' + m.symbol : M.DASH));

      if (collateral === 0n && borrowAssets === 0n) { posRows.appendChild(notice('No open sling in this market yet.', 'plain')); return; }

      const repayF = amountField({ label: 'Repay (' + m.symbol + ')', field: 'sling-repay', decimals: meta.giantDecimals, getMaxRaw: () => borrowAssets });
      const repayBtn = h('button', { class: 'btn btn-ghost btn-sm' }, 'Repay');
      wireAction(repayBtn, async () => {
        const raw2 = repayF.raw();
        if (!raw2 || raw2 <= 0n) { repayF.setHint('Enter an amount.', true); return; }
        await ensureAllowance(m.token, STATE.addresses.router, raw2, m.symbol);
        await sendTx({ to: STATE.addresses.router, data: enc('repay((address,address,address,address,uint256),uint256,uint256)', M.marketParamsTuple(mp), raw2, 0n), title: 'Repay ' + m.symbol });
        await refreshPosition();
      }, 'Repaying…');
      repayF.wrap.appendChild(h('div', { class: 'btn-row' }, repayBtn));
      posRows.appendChild(repayF.wrap);

      const closeBtn = h('button', { class: 'btn btn-danger btn-sm' }, 'Close (repay all, withdraw all)');
      wireAction(closeBtn, async () => {
        // Interest keeps accruing until the tx lands, so approve a small buffer over the last-read amount.
        const buffer = borrowAssets + (borrowAssets / 200n) + 1n; // +0.5%
        await ensureAllowance(m.token, STATE.addresses.router, buffer, m.symbol);
        await sendTx({ to: STATE.addresses.router, data: enc('closeShort((address,address,address,address,uint256),uint256,uint256,address)', M.marketParamsTuple(mp), 0n, 0n, STATE.account), title: 'Close ' + m.symbol + ' short' });
        await refreshPosition();
      }, 'Closing…');
      posRows.appendChild(h('div', { class: 'btn-row', style: 'margin-top:8px' }, closeBtn));

      const addF = amountField({ label: 'Add collateral (USDG)', field: 'sling-addcol', decimals: 6, getMaxRaw: () => usdgBal });
      const addBtn = h('button', { class: 'btn btn-ghost btn-sm' }, 'Add collateral');
      wireAction(addBtn, async () => {
        const raw2 = addF.raw();
        if (!raw2 || raw2 <= 0n) { addF.setHint('Enter an amount.', true); return; }
        await ensureAllowance(STATE.addresses.usdg, STATE.addresses.router, raw2, 'USDG');
        await sendTx({ to: STATE.addresses.router, data: enc('addCollateral((address,address,address,address,uint256),uint256)', M.marketParamsTuple(mp), raw2), title: 'Add collateral' });
        await refreshPosition();
      }, 'Adding…');
      addF.wrap.appendChild(h('div', { class: 'btn-row' }, addBtn));
      posRows.appendChild(h('div', { class: 'divider' }));
      posRows.appendChild(addF.wrap);

      posRows.querySelectorAll('[data-field]').forEach((el) => {
        const s = saved[el.dataset.field];
        if (s) { el.value = s.value; if (s.focus) el.focus(); }
      });
    }

    async function refreshAll() {
      meta = await ensureMeta(m);
      cache = await loadMarketLive(m);
      if (STATE.account) {
        const bals = await multicall([
          { key: 'usdg', to: STATE.addresses.usdg, sig: 'balanceOf(address)', args: [STATE.account], types: 'uint256' },
          { key: 'giant', to: m.token, sig: 'balanceOf(address)', args: [STATE.account], types: 'uint256' },
        ]);
        usdgBal = bals.usdg; giantBal = bals.giant;
      }
      withPreservedInputs(container, recomputeLive);
      if (STATE.addresses.router) { await refreshSteps(); await refreshPosition(); }
    }
    refreshAll();
    const id = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(id);
  }
