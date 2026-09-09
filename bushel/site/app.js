'use strict';
/**
 * whatever.fun — the front end.
 *
 * A launchpad where the pairing asset is a real thing: gold, treasuries, an index, a single name.
 * In this first version whatever.fun does not deploy contracts of its own — it launches through Pons V2's
 * factory, which already accepts those assets and which nobody has built a front end for that treats
 * them as the point. What whatever.fun adds is the part that is missing: the menu, priced and ranked; the
 * opening valuation of a launch in dollars, so a launch against gold and a launch against a dollar
 * can be compared; and the honest labelling of assets whose market is too thin to price a coin
 * against at all.
 *
 * No build step, no framework, no dependencies. Chain reads are eth_call against the endpoints in
 * config/addresses.json, rotated because the official one rate-limits. Selectors are written out as
 * constants beside their signatures rather than hashed at run time, so nothing here needs a keccak.
 * site/launch.js owns everything to do with signing; this file never builds calldata itself.
 */
(function () {
  const SEL = {
    approvedPairTokens: '0x9831705e',      // approvedPairTokens(address)
    pairTokenEconomics: '0x31082134',      // pairTokenEconomics(address)
    getLaunchConfig: '0x1cad862d',         // getLaunchConfig(uint256)
    launchFee: '0xcf3cf573',               // launchFee()
    launchEnabled: '0x236a4afb',           // launchEnabled()
    symbol: '0x95d89b41',                  // symbol()
    decimals: '0x313ce567',                // decimals()
  };
  const TOPIC_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
  const CHAIN_ID_HEX = '0x1237';           // 4663
  const DEX_PAIRS = 'https://api.dexscreener.com/latest/dex/pairs/robinhood/';
  const REFRESH_MS = 45000;
  // Under this much of its own liquidity, an asset is priced thinly enough that a launch against
  // it is priced against a number one trade can move. Same threshold scripts/prices.js uses.
  const THIN_USD = 100000;

  const STATE = { cfg: null, menu: null, account: null, route: '', q: '', endpoint: 0, sel: null };
  window.BUSHEL_STATE = STATE;             // a harmless inspection hook

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
  const $ = (id) => document.getElementById(id);
  const UI = () => window.WhateverUI || null;         // the shared component kit, if it loaded

  // `compact` marks a SIZE — a valuation, a pool's depth — as opposed to a PRICE. The difference is
  // how many decimals are meaningful: USDG at $0.9991 needs four, and an opening valuation of
  // $8.2693 needs none of them and reads as noise beside the $21.9K in the row above it.
  const fmtUsd = (n, compact) => {
    if (!Number.isFinite(n)) return '—';
    if (compact) {
      if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
      if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
      return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 });
  };
  // A rate per day derived from a 2.8-hour window carries three decimals of false precision;
  // nobody launches a third of a coin.
  const fmtNum = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');

  // ============================================================================ chain reads
  /**
   * Many eth_calls in one HTTP request. Reading a symbol for each of sixty coins is sixty calls and
   * one round trip this way, or sixty round trips the other way — and these endpoints rate-limit.
   * A call that fails comes back as null rather than throwing, because one missing symbol should
   * cost that row its name and nothing else.
   */
  async function rpcBatch(calls, attempt = 0) {
    if (!calls.length) return [];
    const eps = (STATE.cfg && STATE.cfg.rpcs) || [STATE.cfg && STATE.cfg.rpc].filter(Boolean);
    if (!eps.length) throw new Error('no rpc configured');
    const url = eps[STATE.endpoint++ % eps.length];
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))),
      });
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error((j && j.error && j.error.message) || 'batch refused');
      const out = new Array(calls.length).fill(null);
      for (const r of j) if (r && typeof r.id === 'number' && !r.error) out[r.id] = r.result;
      return out;
    } catch (e) {
      if (attempt >= eps.length) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpcBatch(calls, attempt + 1);
    }
  }

  async function rpc(method, params, attempt = 0) {
    const eps = (STATE.cfg && STATE.cfg.rpcs) || [STATE.cfg && STATE.cfg.rpc].filter(Boolean);
    if (!eps.length) throw new Error('no rpc configured');
    const url = eps[STATE.endpoint++ % eps.length];
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      // A transport failure is not an answer: try the next endpoint before giving up.
      if (attempt >= eps.length) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpc(method, params, attempt + 1);
    }
  }
  const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
  const callRaw = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

  /**
   * An ABI-encoded `string` return -> the text, or null. Tolerant on purpose: this decodes whatever
   * a stranger's freshly deployed token returns from symbol(), which may be a bytes32 rather than a
   * string, may be empty, and may be deliberate nonsense. A row losing its ticker is not worth an
   * exception, so anything unparseable comes back null and the caller shows the address instead.
   */
  function decodeString(hex) {
    if (!hex || hex === '0x' || hex.length < 130) return null;
    try {
      const body = hex.slice(2);
      const len = Number(BigInt('0x' + body.slice(64, 128)));
      if (!len || len > 128 || body.length < 128 + len * 2) return null;
      const bytes = [];
      for (let i = 0; i < len; i++) bytes.push(parseInt(body.slice(128 + i * 2, 130 + i * 2), 16));
      const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
      // Control characters mean this was not a string; a very long one is not a ticker either.
      const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      return clean && clean.length <= 32 ? clean : null;
    } catch (e) { return null; }
  }

  // ============================================================================ the menu
  /** The menu is built off chain by scripts/menu.js so the first paint costs nothing; prices are
   *  then refreshed live, because a dollar figure that is an hour old is worse than no figure. */
  async function loadMenu() {
    const res = await fetch('./data/menu.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('the menu has not been built yet');
    return normalise(await res.json());
  }

  /**
   * scripts/menu.js groups each asset's fields by where they came from — identity, `market` from
   * DexScreener, `launch` from the factory, `demand` from the logs — which is the right shape for a
   * file somebody reads. The renderers want one flat record per row. This is the seam between the
   * two, and it accepts either shape so that neither file has to change when the other does.
   */
  function normalise(raw) {
    const m = raw || {};
    const cfg = m.launchConfig || m.config || {};
    const assets = (m.assets || []).map((a) => {
      const mk = a.market || {}, la = a.launch || {}, de = a.demand || {};
      const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
      return {
        symbol: a.symbol, name: a.name, address: a.address, decimals: a.decimals,
        kind: a.kind, logo: pick(a.logo, a.logoUrl) || null,
        usd: pick(a.usd, mk.usd) || null,
        liquidity: pick(a.liquidity, mk.liquidity) || 0,
        vol: pick(a.vol, a.vol24, mk.vol24, mk.vol) || 0,
        venue: pick(a.venue, mk.venue) || null,
        pairAddress: pick(a.pairAddress, mk.pairAddress) || null,
        phantomQuote: pick(a.phantomQuote, la.phantomQuote) || null,
        openingUsd: pick(a.openingUsd, la.openingUsd) || null,
        // set only where the factory never wrote a row and the terms were read from what it did
        derived: pick(a.derived, la.derived) || null,
        graduationUsd: pick(a.graduationUsd, la.graduationUsd) || null,
        launches: pick(a.launches, de.launches) || 0,
        // perDay is null when the window could not be measured — which is not the same as zero, and
        // the difference shows: a null column reads as "unknown", a zero column reads as "nobody".
        launchesPerDay: pick(a.launchesPerDay, de.perDay),
        tradeable: !!a.tradeable, thin: !!a.thin,
      };
    });
    const spanHours = (m.window || {}).spanHours;
    return {
      readAt: m.readAt || m.generatedAt || null,
      chainId: m.chainId, factory: m.factory,
      launchFeeEth: m.launchFeeEth || null,
      openingSpread: m.openingSpread || null,
      config: {
        supply: cfg.supply, curveFeeBps: cfg.curveFeeBps, tokensOnCurve: cfg.tokensOnCurve,
        id: cfg.id != null ? cfg.id : 0,
      },
      // The chain-wide rate, from the same window the per-asset counts came from.
      launchesPerDay: m.launchesPerDay != null ? m.launchesPerDay
        : (m.totalLaunches && spanHours ? Math.round(m.totalLaunches * 24 / spanHours) : null),
      totalLaunches: m.totalLaunches || null,
      window: m.window || null,
      assets,
    };
  }

  // opening valuation = (phantomQuote / tokensOnCurve) x supply x the asset's dollar price. The
  // first two come from the launch config the menu was built against, so this is only defined once
  // that config is present; without it the cell stays a dash rather than showing a guess.
  function openingUsd(menu, a, usd) {
    const c = menu.config || {};
    if (!a.phantomQuote || !c.supply || !c.tokensOnCurve) return null;
    const supply = Number(c.supply) / 1e18, onCurve = Number(c.tokensOnCurve) / 1e18;
    if (!(onCurve > 0)) return null;
    return (a.phantomQuote / onCurve) * supply * usd;
  }

  async function refreshPrices() {
    const menu = STATE.menu;
    if (!menu || !menu.assets || !menu.assets.length) return;
    // Refresh by POOL, not by token. DexScreener's /tokens/<addresses> endpoint caps its answer at
    // thirty pairs however many addresses are asked for — a batch of thirty comes back covering
    // thirteen of them — so asking it about a 57-asset menu silently leaves most of the table
    // stale. /pairs/<chain>/<ids> returns every id it is given. menu.js records the deepest pool
    // for each asset precisely so this call can be made.
    const pools = menu.assets.map((a) => a.pairAddress).filter(Boolean);
    if (!pools.length) return;
    const batches = [];
    for (let i = 0; i < pools.length; i += 25) batches.push(pools.slice(i, i + 25));
    try {
      const answers = await Promise.all(batches.map(async (b) => {
        const res = await fetch(DEX_PAIRS + b.join(','), { headers: { accept: 'application/json' } });
        return res.ok ? res.json() : { pairs: [] };
      }));
      const byPool = new Map();
      for (const p of answers.flatMap((j) => j.pairs || [])) {
        const usd = Number(p.priceUsd);
        if (!(usd > 0) || !p.pairAddress) continue;
        byPool.set(p.pairAddress.toLowerCase(), { usd, liquidity: Number((p.liquidity || {}).usd) || 0, vol: Number((p.volume || {}).h24) || 0 });
      }
      let moved = false;
      for (const a of menu.assets) {
        const live = a.pairAddress ? byPool.get(a.pairAddress.toLowerCase()) : null;
        if (!live) continue;
        if (!a.usd || Math.abs(live.usd - a.usd) / a.usd > 1e-9) moved = true;
        // The opening valuation is a function of the asset's price, so it moves with it. An asset
        // the menu found no market for has no prior price to scale from, so it is computed from the
        // factory's own per-asset number instead — the same arithmetic scripts/opening.js does.
        if (a.usd && a.openingUsd) a.openingUsd = a.openingUsd * (live.usd / a.usd);
        else if (!a.usd) a.openingUsd = openingUsd(menu, a, live.usd);
        if (a.usd && a.graduationUsd) a.graduationUsd = a.graduationUsd * (live.usd / a.usd);
        a.usd = live.usd; a.liquidity = live.liquidity; a.vol = live.vol;
        // The menu is a snapshot; this read is now. An asset that has acquired a market since the
        // menu was built must stop being labelled as having none, or the row contradicts itself.
        a.tradeable = true;
        a.thin = live.liquidity < THIN_USD;
      }
      if (moved && STATE.route === 'menu') renderRoute();
    } catch (e) { /* a stale price is survivable; a broken page is not */ }
  }

  // ============================================================================ chrome
  function startBlockPoller() {
    const el = $('chip-block');
    if (!el) return;
    const tick = async () => {
      try { el.textContent = 'block ' + Number(BigInt(await rpc('eth_blockNumber', []))).toLocaleString('en-US'); }
      catch { el.textContent = 'block —'; }
    };
    tick();
    setInterval(tick, 10000);
  }

  function paintTicker() {
    const el = $('ticker');
    const menu = STATE.menu;
    if (!el) return;
    // "reading the chain" is the markup's placeholder and stops being true the moment the read
    // finishes, whatever it found. A ticker stuck on it forever reads as a hang.
    if (!menu) { clear(el); el.appendChild(h('span', { class: 'tk-empty' }, 'no menu built yet')); return; }
    const busiest = menu.assets.filter((a) => a.launchesPerDay > 0).sort((a, b) => b.launchesPerDay - a.launchesPerDay).slice(0, 12);
    clear(el);
    if (!busiest.length) { el.appendChild(h('span', { class: 'tk-empty' }, 'nothing launched in the window')); return; }
    const u = UI();
    const item = (a) => h('span', { class: 'tk-item' },
      u && u.coinAvatar ? u.coinAvatar(a.symbol, a.logo, 18) : null,
      h('span', { class: 'tk-sym' }, a.symbol),
      h('span', { class: 'tk-px' }, fmtNum(a.launchesPerDay) + '/day'),
      h('span', { class: 'tk-chg dim' }, a.usd ? fmtUsd(a.usd) : ''));

    // The track carries the set twice and slides by exactly half its width, so the second copy is
    // where the first was at the moment it resets and the loop has no seam. Animating the items
    // themselves — the obvious thing — slides them all off and snaps them back, which reads as a
    // fault. The copy is aria-hidden so a screen reader is not told the same twelve assets twice.
    const track = h('div', { class: 'tk-track' });
    for (const a of busiest) track.appendChild(item(a));
    const echo = h('div', { class: 'tk-track', 'aria-hidden': 'true' });
    for (const a of busiest) echo.appendChild(item(a));
    el.appendChild(h('div', { class: 'tk-rail' }, track, echo));
  }

  function initSearch() {
    const slot = $('search-slot');
    if (!slot) return;
    const onInput = (v) => { STATE.q = String(v || '').trim().toLowerCase(); if (STATE.route === 'menu') renderRoute(); };
    const u = UI();
    if (u && u.searchBox) { slot.appendChild(u.searchBox('Search the menu', onInput).el); return; }
    const input = h('input', { type: 'text', placeholder: 'Search the menu', 'aria-label': 'Search the menu' });
    input.addEventListener('input', () => onInput(input.value));
    slot.appendChild(input);
  }

  // ============================================================================ wallet
  async function connect() {
    if (!window.ethereum) { toast('No wallet found', 'Install a browser wallet to launch.'); return null; }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    STATE.account = accounts && accounts[0];
    await ensureChain();
    paintWallet();
    return STATE.account;
  }
  async function ensureChain() {
    try {
      const current = await window.ethereum.request({ method: 'eth_chainId' });
      if (current === CHAIN_ID_HEX) return true;
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
      return true;
    } catch (e) {
      if (e && e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX, chainName: 'Robinhood Chain',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [STATE.cfg.rpc], blockExplorerUrls: [STATE.cfg.explorer],
          }],
        });
        return true;
      }
      throw e;
    }
  }
  function paintWallet() {
    const slot = $('wallet-slot');
    if (!slot) return;
    clear(slot);
    if (!STATE.account) { slot.appendChild(h('button', { class: 'btn btn-primary btn-sm', onclick: connect }, 'Connect wallet')); return; }
    slot.appendChild(h('span', { class: 'wallet-addr' }, shortAddr(STATE.account)));
  }

  function toast(title, body, kind) {
    const box = $('toasts');
    if (!box) return;
    const el = h('div', { class: 'toast ' + (kind || '') }, h('div', { class: 't-title' }, title), body ? h('div', {}, body) : null);
    box.appendChild(el);
    setTimeout(() => el.remove(), 9000);
    return el;
  }

  // ============================================================================ pages
  const ROUTES = ['home', 'menu', 'new', 'recent', 'about'];
  // Full <title> strings, not just labels — the crumb used to say where you were, and now the
  // title bar does instead. An empty or unknown hash falls back to 'home', so TITLES.home also
  // stands in whenever STATE.route somehow lands on something this map does not name.
  const TITLES = {
    home: 'whatever.fun — price a coin in a real thing',
    menu: 'The menu — whatever.fun',
    new: 'Launch a coin — whatever.fun',
    recent: 'Recent launches — whatever.fun',
    about: 'How this works — whatever.fun',
  };

  function tile(label, value, sub, icon) {
    const u = UI();
    if (u && u.statTile) return u.statTile({ label, value, sub, icon });
    return h('div', { class: 'stat-tile' }, h('div', { class: 'st-label' }, label), h('div', { class: 'st-value' }, value), sub ? h('div', { class: 'st-sub' }, sub) : null);
  }

  function renderMenu(view) {
    const menu = STATE.menu;
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, '57 ASSETS · READ FROM THE CHAIN'),
      h('h1', {}, 'What you can price a coin in'),
      h('p', { class: 'page-lede' }, 'Every asset this chain will let a coin be paired against, what it costs, how deep its own market is, and what a launch against it opens at.')));

    if (!menu) { view.appendChild(notice('The menu has not been built yet. Run node scripts/menu.js.')); return; }

    const tradeable = menu.assets.filter((a) => a.tradeable);
    const spread = menu.openingSpread || {};
    view.appendChild(h('div', { class: 'stat-grid page-tiles' },
      tile('On the menu', fmtNum(menu.assets.length), tradeable.length + ' with a real market', 'coins'),
      tile('Launches a day', menu.launchesPerDay != null ? fmtNum(menu.launchesPerDay) : '—', 'across the whole chain', 'chart'),
      tile('Opening spread', spread.ratio ? spread.ratio.toFixed(2) + '×' : '—', spread.min && spread.max ? fmtUsd(spread.min, true) + ' to ' + fmtUsd(spread.max, true) + ' for the same launch' : null, 'flame'),
      tile('Launch fee', menu.launchFeeEth ? menu.launchFeeEth + ' ETH' : '—', 'paid to Pons, not to us', 'wallet')));

    const q = STATE.q;
    const rows = menu.assets.filter((a) => !q || (a.symbol + ' ' + (a.name || '') + ' ' + (a.kind || '')).toLowerCase().includes(q));
    const u = UI();
    const tbody = h('tbody', {});
    for (const a of rows) {
      const flag = !a.tradeable ? h('span', { class: 'badge badge-off', title: 'No pool quotes this asset on this chain' }, 'no market')
        : a.thin ? h('span', { class: 'badge badge-hold', title: 'Under $100k of its own liquidity' }, 'thin') : null;
      tbody.appendChild(h('tr', { class: a.tradeable ? 'clickable' : '', onclick: a.tradeable ? () => { location.hash = '#/new?pair=' + a.symbol; } : null },
        h('td', {}, h('div', { class: 'coin-cell' },
          u && u.coinAvatar ? u.coinAvatar(a.symbol, a.logo, 26) : null,
          h('div', {}, h('span', { class: 'cc-sym' }, a.symbol, flag ? ' ' : null, flag), h('span', { class: 'cc-name' }, a.name || '')))),
        h('td', {}, h('span', { class: 'dim' }, a.kind || '—')),
        h('td', { class: 'num' }, a.usd ? fmtUsd(a.usd) : '—'),
        h('td', { class: 'num' }, a.liquidity ? fmtUsd(a.liquidity, true) : '—'),
        h('td', { class: 'num' }, a.derived ? h('span', { title: a.derived, class: 'derived' }, a.openingUsd ? fmtUsd(a.openingUsd, true) : '—') : (a.openingUsd ? fmtUsd(a.openingUsd, true) : '—')),
        // null is "the window could not be measured", which is not the same claim as zero.
        h('td', { class: 'num' }, a.launchesPerDay == null ? '—' : fmtNum(a.launchesPerDay))));
    }
    const head = h('thead', {}, h('tr', {},
      h('th', {}, 'Asset'), h('th', {}, 'Kind'), h('th', { class: 'num' }, 'Price'),
      h('th', { class: 'num' }, 'Its own liquidity'), h('th', { class: 'num' }, 'A launch opens at'),
      h('th', { class: 'num' }, 'Launches / day')));
    view.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mkt-table' }, head, tbody)));

    view.appendChild(h('p', { class: 'small', style: 'margin-top:14px' },
      'Opening valuations are the incumbent\'s own numbers: a per-asset figure set by hand, times the asset\'s live price. '
      + 'They differ by ' + (spread.ratio ? spread.ratio.toFixed(2) + '×' : 'a lot') + ' across the menu for no reason to do with the assets — which is the thing worth fixing.'));
  }

  function renderNew(view) {
    const menu = STATE.menu;
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'PICK WHAT IT IS PRICED IN'),
      h('h1', {}, 'Launch a coin'),
      h('p', { class: 'page-lede' }, 'Pick what it is priced in, name it, and launch. The coin is sold on a bonding curve denominated in that asset, and graduates to a pool when the curve is bought out.')));

    if (!menu) { view.appendChild(notice('The menu has not been built yet. Run node scripts/menu.js.')); return; }
    if (!window.WhateverLaunch) { view.appendChild(notice('The launch module has not loaded, so nothing here can be signed yet.', 'warn')); }

    const tradeable = menu.assets.filter((a) => a.tradeable);
    const wanted = (location.hash.split('?')[1] || '').replace('pair=', '').toUpperCase();
    // Ether is the deepest market on the menu and so sorts first, but it is also the one thing on
    // this list that is not a real thing — and this site's whole argument is that a coin does not
    // have to be priced in it. So a launch that names no pair starts on gold, and falls back to
    // whatever has the most depth only if gold is not on the menu.
    const DEFAULT_PAIR = 'GLD';
    let picked = tradeable.find((a) => a.symbol.toUpperCase() === wanted)
      || tradeable.find((a) => a.symbol.toUpperCase() === DEFAULT_PAIR && a.openingUsd)
      || tradeable.find((a) => a.openingUsd)
      || tradeable[0];

    const grid = h('div', { class: 'page-grid' });
    const left = h('div', { class: 'col' });
    const rail = h('div', { class: 'rail-col' });
    grid.appendChild(left); grid.appendChild(rail);
    view.appendChild(grid);

    const preview = h('div', { class: 'card ticket' });
    rail.appendChild(preview);

    const field = (label, id, opts) => {
      const input = h('input', Object.assign({ type: 'text', id, 'data-field': id }, opts || {}));
      return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), input) };
    };
    const name = field('Name', 'f-name', { placeholder: 'Gold Standard' });
    const symbol = field('Symbol', 'f-symbol', { placeholder: 'GOLDS', maxlength: '11' });
    const logo = field('Logo URL', 'f-logo', { placeholder: 'https://…' });
    const desc = field('Description', 'f-desc', { placeholder: 'What is it?' });
    const tax = field('Creator tax (bps)', 'f-tax', { placeholder: '0', inputmode: 'numeric' });

    const chooser = h('div', { class: 'field' },
      h('label', { for: 'f-pair' }, 'Priced in'),
      h('select', { id: 'f-pair', onchange: (e) => { picked = tradeable.find((a) => a.symbol === e.target.value) || picked; paintPreview(); } },
        tradeable.map((a) => h('option', { value: a.symbol, selected: a === picked ? true : null },
          a.symbol + ' — ' + (a.name || '') + (a.usd ? '  (' + fmtUsd(a.usd) + ')' : '')))));

    const launchBtn = h('button', { class: 'btn btn-primary btn-block', onclick: () => doLaunch() }, 'Launch');
    const hint = h('p', { class: 'hint' }, '');

    left.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'The coin')),
      name.el, symbol.el, logo.el, desc.el,
      h('div', { class: 'divider' }),
      chooser, tax.el, hint));

    function paintPreview() {
      clear(preview);
      const u = UI();
      preview.appendChild(h('div', { class: 'ticket-head' },
        h('h3', { class: 'ticket-title' }, 'What this opens at'),
        u && u.coinAvatar && picked ? u.coinAvatar(picked.symbol, picked.logo, 26) : null));
      if (!picked) { preview.appendChild(notice('No asset with a real market to price against.')); return; }
      const rows = h('div', { class: 'rows' });
      const row = (k, v) => rows.appendChild(h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)));
      row('Priced in', picked.symbol + (picked.usd ? ' at ' + fmtUsd(picked.usd) : ''));
      row('Opens at', picked.openingUsd ? fmtUsd(picked.openingUsd) : '—');
      row('Graduates at', picked.graduationUsd ? fmtUsd(picked.graduationUsd) : '—');
      row('Its own liquidity', picked.liquidity ? fmtUsd(picked.liquidity, true) : '—');
      row('Launches a day', picked.launchesPerDay != null ? fmtNum(picked.launchesPerDay) : '—');
      row('Launch fee', (STATE.menu.launchFeeEth || '0.0005') + ' ETH');
      preview.appendChild(rows);
      preview.appendChild(h('p', { class: 'ticket-note' },
        'The opening figure is the incumbent factory\'s own per-asset number times ' + picked.symbol + '\'s live price. '
        + 'It is not the same across assets, which is the honest thing to know before you pick one.'));
      // Native ether has no row in the factory's table, so its terms are read from its own launches
      // instead. A figure that came from somewhere different should say so where it is shown.
      if (picked.derived) preview.appendChild(h('p', { class: 'ticket-note dim' }, 'For ' + picked.symbol + ', ' + picked.derived + '.'));
      preview.appendChild(launchBtn);
    }
    paintPreview();

    async function doLaunch() {
      const L = window.WhateverLaunch;
      if (!L) { toast('Not ready', 'The launch module has not loaded.', 'error'); return; }
      if (!STATE.account && !(await connect())) return;
      const form = {
        name: name.input.value.trim(), symbol: symbol.input.value.trim().toUpperCase(),
        logo: logo.input.value.trim(), description: desc.input.value.trim(),
        creatorTaxBps: Number(tax.input.value || 0) | 0,
        creatorFeeRecipient: STATE.account, pairToken: picked.address,
      };
      const problem = L.validate ? L.validate(form) : null;
      if (problem) { hint.textContent = problem; hint.classList.add('err'); return; }
      hint.textContent = ''; hint.classList.remove('err');
      launchBtn.disabled = true;
      const pending = toast('Launching…', 'Confirm in your wallet.', 'pending');
      try {
        const out = await L.launch({
          ethereum: window.ethereum, from: STATE.account, factory: STATE.cfg.pons.factory,
          launchConfigId: 0, pairToken: picked.address, form, rpc,
        });
        if (pending) pending.remove();
        toast(form.symbol + ' launched', shortAddr(out.token), 'success');
        location.hash = '#/recent';
      } catch (e) {
        if (pending) pending.remove();
        toast('Launch failed', (e && e.message ? e.message : String(e)).slice(0, 200), 'error');
      } finally { launchBtn.disabled = false; }
    }
  }

  async function renderRecent(view) {
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'LAUNCHED IN THE LAST FIVE MINUTES'),
      h('h1', {}, 'Recent launches'),
      h('p', { class: 'page-lede' }, 'What has been launched on this chain lately, and what each coin is priced in.')));
    const body = h('div', {}, notice('Reading the chain…', 'plain'));
    view.appendChild(body);

    try {
      const head = Number(BigInt(await rpc('eth_blockNumber', [])));
      // 3,000 blocks is about five minutes here, and about 150 launches — plenty to fill a page of
      // sixty, and a twentieth of the logs a wider window would pull down to throw most of away.
      const SPAN = 3000;
      const logs = await rpc('eth_getLogs', [{
        address: STATE.cfg.pons.factory, topics: [TOPIC_LAUNCHED],
        fromBlock: '0x' + Math.max(0, head - SPAN).toString(16), toBlock: 'latest',
      }]);
      const byAddr = new Map((STATE.menu ? STATE.menu.assets : []).map((a) => [a.address.toLowerCase(), a]));
      const rows = logs.slice(-60).reverse().map((log) => {
        const token = '0x' + log.topics[1].slice(26);
        const pairAddr = '0x' + log.data.slice(26, 66);
        return { token, pair: byAddr.get(pairAddr.toLowerCase()), pairAddr, block: Number(BigInt(log.blockNumber)) };
      });
      // One request for every coin's ticker, so the page reads as coins rather than as hex.
      const symbols = await rpcBatch(rows.map((r) => ({ method: 'eth_call', params: [{ to: r.token, data: SEL.symbol }, 'latest'] })))
        .catch(() => rows.map(() => null));
      rows.forEach((r, i) => { r.symbol = decodeString(symbols[i]); });

      clear(body);
      const u = UI();
      const tbody = h('tbody', {});
      for (const r of rows) {
        const a = r.pair;
        tbody.appendChild(h('tr', {},
          h('td', {}, h('a', { href: STATE.cfg.explorer + '/address/' + r.token, target: '_blank', rel: 'noopener', class: r.symbol ? '' : 'mono' },
            r.symbol || shortAddr(r.token))),
          h('td', {}, h('div', { class: 'coin-cell' },
            u && u.coinAvatar && a ? u.coinAvatar(a.symbol, a.logo, 22) : null,
            h('div', {}, h('span', { class: 'cc-sym' }, a ? a.symbol : (r.pairAddr === '0x0000000000000000000000000000000000000000' ? 'ETH' : shortAddr(r.pairAddr))),
              h('span', { class: 'cc-name' }, a ? (a.kind || '') : '')))),
          h('td', { class: 'num mono' }, fmtNum(r.block))));
      }
      body.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Coin'), h('th', {}, 'Priced in'), h('th', { class: 'num' }, 'Block'))), tbody)));
      body.appendChild(h('p', { class: 'small', style: 'margin-top:12px' }, fmtNum(logs.length) + ' launches in the last ' + fmtNum(SPAN) + ' blocks — about five minutes on this chain. The most recent ' + rows.length + ' are shown.'));
    } catch (e) {
      clear(body);
      body.appendChild(notice('Could not read recent launches: ' + (e && e.message ? e.message : e), 'warn'));
    }
  }

  function renderAbout(view) {
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'HOW THIS WORKS'),
      h('h1', {}, 'How this works')));
    const card = (title, body) => h('div', { class: 'card' }, h('h3', { class: 'card-title' }, title), h('p', { class: 'small', style: 'margin-top:8px' }, body));
    view.appendChild(h('div', { class: 'stack' },
      card('whatever.fun does not have contracts yet',
        'This version launches through Pons V2\'s factory, which is somebody else\'s code and which already accepts these '
        + 'assets. whatever.fun takes no fee: the 0.0005 ETH launch fee is theirs, and so is the 1% curve fee. What this adds is '
        + 'the menu, the dollar comparison, and the labelling of assets whose market is too thin to price against.'),
      card('Why an opening valuation differs by asset',
        'The factory holds a per-asset number that sets where a launch opens. It was typed by hand and is not refreshed, so '
        + 'the same one-click launch opens at meaningfully different sizes depending on which asset you pick and when that '
        + 'number was last touched. The menu shows what each one actually opens at today.'),
      card('Some assets are on the list but have no market',
        'Silver and oil are approved as pairing assets and no pool on this chain quotes them. A coin priced in them would be '
        + 'priced in something nobody can buy or sell, so they are labelled rather than hidden.'),
      card('What can go wrong',
        'A memecoin can go to zero and most do. The curve is the incumbent\'s, unaudited by us, and it permanently locks part '
        + 'of every token\'s supply at graduation. Nothing here is financial advice, and a launch is irreversible.')));
  }

  const notice = (text, kind) => h('div', { class: 'notice ' + (kind ? kind : '') }, text);

  // A short date a stranger can read at a glance, from menu.json's ISO readAt. Returns null
  // rather than "Invalid Date" if the menu is somehow malformed — the caller drops it rather
  // than print a broken date.
  function fmtReadDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // The mono line under the spread card's serif note — every figure in it comes from
  // menu.openingSpread and menu.readAt, never typed, so it can only ever say what the last read
  // of the chain actually found.
  function spreadMetaText(spread, readAt) {
    spread = spread || {};
    const lo = spread.minSymbol && Number.isFinite(spread.min) ? spread.minSymbol + ' ' + fmtUsd(spread.min, true) : null;
    const hi = spread.maxSymbol && Number.isFinite(spread.max) ? spread.maxSymbol + ' ' + fmtUsd(spread.max, true) : null;
    const range = lo && hi ? lo + ' → ' + hi : (lo || hi);
    const ratio = Number.isFinite(spread.ratio) ? spread.ratio.toFixed(2) + '×' : null;
    const read = fmtReadDate(readAt);
    const parts = [range, ratio, read ? 'read ' + read : null].filter(Boolean);
    return parts.length ? parts.join('  ·  ') : '—';
  }

  /**
   * The hero's spread card — the site's whole argument built out of divs. Every row comes from
   * STATE.menu: the assets with an openingUsd, sorted, then the cheapest, the dearest, and six
   * spread evenly between them (fewer than eight if the menu itself has fewer priced assets).
   * With no menu built, or nothing on it priced yet, this is the same "not built yet" notice
   * every other route falls back to — never an invented figure.
   */
  function heroSpreadCard(menu) {
    const priced = menu && menu.assets ? menu.assets.filter((a) => Number.isFinite(a.openingUsd) && a.openingUsd > 0) : [];
    if (!menu || !priced.length) return notice('The menu has not been built yet. Run node scripts/menu.js.');
    priced.sort((a, b) => a.openingUsd - b.openingUsd);
    const want = Math.min(8, priced.length);
    const picks = [];
    for (let i = 0; i < want; i++) {
      const idx = want === 1 ? 0 : Math.round((i * (priced.length - 1)) / (want - 1));
      if (!picks.includes(priced[idx])) picks.push(priced[idx]);
    }
    const max = picks[picks.length - 1].openingUsd;
    const rows = picks.map((a) => {
      const fill = h('i', {});
      // --w is a fraction of the dearest pick's opening valuation, which is what .sp-bar's CSS
      // turns into the bar's width — the same number the row's own $ figure states.
      fill.style.setProperty('--w', max > 0 ? String(a.openingUsd / max) : '0');
      return h('div', { class: 'sp-row' },
        h('span', { class: 'sp-sym' }, a.symbol),
        h('div', { class: 'sp-bar' }, fill),
        h('span', { class: 'sp-usd' }, fmtUsd(a.openingUsd, true)));
    });
    // No label inside the card: homeSpread() already puts that exact line above the whole band, and
    // printing it twice in one screen reads as a mistake rather than as emphasis.
    return h('div', { class: 'spread-card' },
      rows,
      h('p', { class: 'sp-note' }, 'Nothing about the assets explains this.'),
      h('p', { class: 'sp-meta mono' }, spreadMetaText(menu.openingSpread, menu.readAt)));
  }

  /**
   * The only route with a hero. Two voices stacked over a ruled paper ground (the ruling is
   * CSS-only, drawn on .hero-field by style.css) with the spread card beside them as furniture,
   * not an illustration — the 2×-ish argument made out of divs while the copy makes it in words.
   */
  /**
   * The mascot. A blank with a face: a soft ink-drawn body whose whole front is a label, because
   * the product's claim is that a coin can be priced in whatever you can name and the character is
   * literally waiting to be told what. It is drawn flat — outline, one fill, a hard shadow — which
   * is this identity's own register and is deliberately nothing like the airbrushed 3D blob the
   * competitor uses. The label's word is swapped by the same timer that drives the headline.
   */
  function mascot() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 220 210');
    svg.setAttribute('class', 'mascot');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = [
      // the hard offset, drawn as a second body behind the first rather than as a filter
      '<path class="m-shadow" d="M28 74c0-30 24-52 82-52s82 22 82 52v62c0 30-24 52-82 52s-82-22-82-52z" transform="translate(7 7)"/>',
      '<path class="m-body" d="M28 74c0-30 24-52 82-52s82 22 82 52v62c0 30-24 52-82 52s-82-22-82-52z"/>',
      // two antennae, because a face needs somewhere for the eyes to be surprised towards
      '<path class="m-line" d="M74 24 62 4M146 24l12-20"/>',
      '<circle class="m-dot" cx="61" cy="3" r="6"/><circle class="m-dot" cx="159" cy="3" r="6"/>',
      // eyes
      '<circle class="m-eye" cx="84" cy="66" r="9"/><circle class="m-eye" cx="136" cy="66" r="9"/>',
      // the label: a blank card across the belly, which is where the cycling word lands
      '<rect class="m-card" x="46" y="92" width="128" height="52" rx="6"/>',
      '<text class="m-word" x="110" y="126" text-anchor="middle">whatever</text>',
    ].join('');
    return svg;
  }

  // What the headline and the mascot's label cycle through. Every one of these is a real pairing
  // asset on this chain except the last, which is the point being made.
  const CYCLE = ['oil', 'gold', 'treasuries', 'silver', 'SpaceX', 'whatever'];

  /**
   * Swaps one word in the headline, and the same word on the mascot's label, every few seconds.
   * The word is the product's whole claim, so it is the one thing on the page that moves.
   * A reader who has asked for less motion gets the last word in the list and no timer at all —
   * "whatever", which is the name and reads correctly as a fixed headline.
   */
  function startCycle(slot, label) {
    const quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (quiet) { slot.textContent = 'whatever'; if (label) label.textContent = 'whatever'; return; }
    let i = 0;
    const paint = () => {
      const word = CYCLE[i % CYCLE.length];
      slot.textContent = word;
      if (label) label.textContent = word;
      slot.classList.remove('swap');
      void slot.offsetWidth;                       // restart the animation rather than queue it
      slot.classList.add('swap');
      i++;
    };
    paint();
    const timer = setInterval(() => { if (STATE.route === 'home' && document.body.contains(slot)) paint(); else clearInterval(timer); }, 2200);
  }

  function renderHome(view) {
    const word = h('span', { class: 'cycle' }, 'oil');
    // The figure slot. app.js always draws the SVG mascot into it, and site/model.js swaps in the
    // animated model on top once it has a working WebGL context and a decoded file — so the slot is
    // never empty, on any machine, at any point in the load.
    const figure = h('div', { class: 'stage-figure' }, mascot());
    const stage = h('div', { class: 'hero-stage' }, figure,
      h('p', { class: 'hero-aside mono' }, 'gold \u00b7 crude \u00b7 treasuries \u00b7 whatever'));
    view.appendChild(h('div', { class: 'hero' },
      h('div', { class: 'hero-field', 'aria-hidden': 'true' }),
      h('div', { class: 'hero-copy' },
        h('div', { class: 'label' }, 'WHAT YOU CAN PRICE A COIN IN'),
        // The word and its full stop are one unbreakable unit. Set apart they orphan: "treasuries"
        // fills the line and the period wraps onto the next one on its own, which looks like a
        // typo. It only shows up on the longer words in the cycle, so it is easy to miss.
        h('h1', {},
          'Price a coin in ',
          h('span', { class: 'cycle-wrap' }, word, '.'),
          ' ',
          h('em', {}, 'Almost nobody does.')),
        h('p', { class: 'page-lede' },
          '57 assets on Robinhood Chain will take a new coin as a pair. '
          + '56% of launches pick NVIDIA anyway, 29% pick ether, and silver got none at all in the window we measured.'),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn btn-primary', href: '#/menu' }, 'Open the menu'),
          h('a', { class: 'btn btn-ghost', href: '#/new?pair=GLD' }, 'Price one in gold'))),
      stage));
    startCycle(word, stage.querySelector('.m-word'));
    view.appendChild(homeSpread(STATE.menu));
    view.appendChild(homePicks(STATE.menu));
  }

  /**
   * The spread argument, as its own band under the hero rather than as a card wedged beside it.
   * It used to be the hero's sidecar and it was always the wrong shape for that: eight rows of
   * numbers and a footnote is something you read, not something you glance at over a headline.
   * Given the width it gets to state the case in a sentence beside the bars.
   */
  function homeSpread(menu) {
    const section = h('section', { class: 'spread-band' });
    section.appendChild(h('div', { class: 'label label--accent' }, 'THE SAME LAUNCH, PRICED 57 WAYS'));
    const spread = (menu && menu.openingSpread) || {};
    section.appendChild(h('div', { class: 'spread-grid' },
      h('div', { class: 'spread-say' },
        h('h2', {}, 'Pick a different asset and the same launch opens at a different price.'),
        h('p', { class: 'page-lede' },
          'Same supply, same curve, same fee. The opening price is set by a per-asset number somebody '
          + 'typed by hand and has not revisited since, so what you get depends on which row of a table '
          + 'was last thought about\u2014not on what the asset is worth.'),
        spread.ratio ? h('p', { class: 'spread-figure' },
          h('b', {}, spread.ratio.toFixed(2) + '\u00d7'),
          h('span', {}, ' between the cheapest and the dearest')) : null),
      heroSpreadCard(menu)));
    return section;
  }

  /**
   * The six deepest pairing assets, under the hero, so the landing page shows the actual menu
   * rather than only arguing about it. Depth is the honest ranking here: an asset's own liquidity
   * is what decides whether a coin priced in it can be traded at all, and it is the one number a
   * launcher cannot get from the asset's name.
   */
  function homePicks(menu) {
    const wrap = h('section', { class: 'picks' });
    if (!menu || !menu.assets) return wrap;
    const deep = menu.assets
      .filter((a) => a.tradeable && a.openingUsd && a.liquidity)
      .sort((x, y) => y.liquidity - x.liquidity)
      .slice(0, 6);
    if (!deep.length) return wrap;

    wrap.appendChild(h('div', { class: 'picks-head' },
      h('div', { class: 'label' }, 'DEEPEST MARKETS ON THE MENU'),
      h('a', { class: 'picks-all', href: '#/menu' }, 'All ' + fmtNum(menu.assets.length) + ' \u2192')));

    const u = UI();
    const grid = h('div', { class: 'picks-grid' });
    for (const a of deep) {
      grid.appendChild(h('a', { class: 'pick', 'data-kind': a.kind || '', href: '#/new?pair=' + a.symbol },
        h('div', { class: 'pick-top' },
          u && u.coinAvatar ? u.coinAvatar(a.symbol, a.logo, 28) : null,
          h('div', {},
            h('span', { class: 'cc-sym' }, a.symbol),
            h('span', { class: 'cc-name' }, a.name || ''))),
        h('div', { class: 'pick-rows' },
          h('div', { class: 'pick-row' }, h('span', {}, 'Opens at'), h('b', { class: 'num' }, fmtUsd(a.openingUsd, true))),
          h('div', { class: 'pick-row' }, h('span', {}, 'Its own depth'), h('b', { class: 'num' }, fmtUsd(a.liquidity, true))))));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  const RENDERERS = { home: renderHome, menu: renderMenu, new: renderNew, recent: renderRecent, about: renderAbout };

  function renderRoute() {
    const view = $('view');
    clear(view);
    view.scrollTop = 0;
    (RENDERERS[STATE.route] || renderHome)(view);
  }

  function navigate() {
    const raw = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
    STATE.route = ROUTES.includes(raw) ? raw : 'home';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === STATE.route));
    // index.html no longer has a #crumb — the title bar names the route instead, which is where a
    // reader would look for it anyway if they had ten tabs open.
    document.title = TITLES[STATE.route] || TITLES.home;
    // The box filters the menu table and nothing else, so it belongs on the one route that has one.
    const search = $('search-slot');
    if (search) search.hidden = STATE.route !== 'menu';
    renderRoute();
  }

  // ============================================================================ boot
  async function boot() {
    try {
      STATE.cfg = await fetch('./config/addresses.json', { cache: 'no-store' }).then((r) => r.json());
    } catch (e) {
      const view = $('view');
      if (view) view.appendChild(notice('Could not load configuration. Serve this directory over HTTP rather than opening the file directly.', 'error'));
      return;
    }
    try { STATE.menu = await loadMenu(); } catch (e) { STATE.menu = null; }

    const chain = $('chip-chain');
    if (chain) chain.textContent = 'Robinhood Chain · ' + STATE.cfg.chainId;
    const toggle = $('nav-toggle'), nav = $('nav');
    if (toggle && nav) toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => nav.classList.remove('open')));

    initSearch();
    paintWallet();
    paintTicker();
    startBlockPoller();
    window.addEventListener('hashchange', navigate);
    navigate();

    if (window.ethereum) {
      try {
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs.length) { STATE.account = accs[0]; paintWallet(); }
      } catch { /* an unavailable wallet is not an error here */ }
      if (typeof window.ethereum.on === 'function') {
        window.ethereum.on('accountsChanged', (accs) => { STATE.account = accs && accs[0]; paintWallet(); });
        window.ethereum.on('chainChanged', () => location.reload());
      }
    }

    refreshPrices();
    setInterval(refreshPrices, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
