'use strict';
/**
 * Stonk Packs front end. Static, no build step, no dependencies.
 * Reads through the public RPC, writes through the injected wallet (EIP-1193).
 * With no contract configured it runs in demo mode: packs open locally with the
 * contract's exact randomness and odds code.
 */
(() => {
  const C = window.STONK_CONFIG;
  const SP = window.SP;
  const $ = (id) => document.getElementById(id);
  const MAX_UINT = (1n << 256n) - 1n;
  const TIER_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  const STATUS = ['none', 'sealed', 'opened', 'refunded'];

  const state = {
    contract: /^0x[0-9a-fA-F]{40}$/.test(C.contract || '') ? C.contract : null,
    account: null,
    tiers: null,
    price: null,
    pulls: C.pulls,
    locked: null,
    paused: null,
    chainHead: null,
    revealed: null,
    packCount: null,
    localPacks: [],
    demoCount: 0,
    current: null,
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rpc = (m, p) => SP.rpc(C.rpc, m, p);
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const view = async (to, sig, ...args) => SP.words(await call(to, SP.encodeCall(sig, ...args)));
  const viewBig = async (to, sig, ...args) => SP.toBig((await view(to, sig, ...args))[0]);
  const symbolOf = (addr) => C.symbols[addr.toLowerCase()] || SP.shortAddr(addr);
  const nameOf = (addr) => { for (const t of C.tiers) for (const x of t.tokens) if (x.address && x.address.toLowerCase() === addr.toLowerCase()) return x.name; return ''; };
  const fmtUsdg = (raw) => SP.fmtAmount(raw, C.usgdDecimals || C.usdgDecimals, 2);
  const fmtPct = (p) => { const x = p * 100; return (Number.isInteger(x) ? String(x) : x.toFixed(x >= 1 ? 1 : 2)) + '%'; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const logoImg = (symbol, cls) => /^[A-Z0-9.]{1,8}$/.test(symbol) ? `<img class="${cls}" src="${C.logoPath || 'logos/'}${esc(symbol)}.png" alt="" loading="lazy" onerror="this.remove()">` : '';

  // Some marks are white on transparent and vanish on paper. Measure each logo once and put
  // the light ones on ink. Same-origin images, so the canvas stays readable.
  const logoTone = new Map();
  function tuneLogo(img) {
    const apply = (dark) => { if (dark) img.classList.add('on-dark'); };
    const key = img.getAttribute('src');
    if (logoTone.has(key)) return apply(logoTone.get(key));
    const measure = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 40) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; } }
        const dark = n > 0 && sum / n > 190;
        logoTone.set(key, dark);
        apply(dark);
      } catch { /* leave as is */ }
    };
    if (img.complete && img.naturalWidth) measure(); else img.addEventListener('load', measure, { once: true });
  }
  const tuneLogosIn = (root) => root.querySelectorAll('img.logo, img.mini-logo').forEach(tuneLogo);

  let toastTimer;
  function toast(msg, err) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle('err', !!err);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), err ? 7000 : 4000);
  }

  const tiersFromConfig = () => C.tiers.map((t) => ({ name: t.name, weight: t.weight, usdCents: t.usd * 100, tokens: t.tokens.map((x) => ({ symbol: x.symbol, address: x.address, name: x.name })) }));

  // ---------------------------------------------------------------------------
  // Chain state
  // ---------------------------------------------------------------------------
  async function loadContract() {
    state.tiers = tiersFromConfig();
    state.price = BigInt(C.packPriceUsd) * 10n ** BigInt(C.usdgDecimals);
    if (!state.contract) return;
    try {
      const n = Number(await viewBig(state.contract, 'tierCount()'));
      const tiers = [];
      for (let i = 0; i < n; i++) {
        const t = SP.decodeTier(await call(state.contract, SP.encodeCall('tier(uint8)', i)));
        tiers.push({ name: TIER_NAMES[i] || `Tier ${i + 1}`, weight: t.weight, usdCents: t.usdCents, tokens: t.tokens.map((a) => ({ symbol: symbolOf(a), address: a, name: nameOf(a) })) });
      }
      if (tiers.length) state.tiers = tiers;
      state.price = await viewBig(state.contract, 'packPrice()');
      state.pulls = Number(await viewBig(state.contract, 'pullsPerPack()'));
      state.locked = (await viewBig(state.contract, 'oddsLocked()')) === 1n;
      state.paused = (await viewBig(state.contract, 'paused()')) === 1n;
      state.chainHead = SP.bytesToHex((await view(state.contract, 'chainHead()'))[0]);
      state.revealed = await viewBig(state.contract, 'revealed()');
      state.packCount = await viewBig(state.contract, 'packCount()');
    } catch (e) {
      console.warn('contract read failed', e);
      toast('Could not read the contract; showing the published table.', true);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderMode() {
    const priceUsd = Number(state.price) / 10 ** C.usdgDecimals;
    $('price-label').textContent = `${priceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDG`;
    const launch = C.launch || {};
    const social = C.social || {};
    const live = !!(state.contract || launch.live);

    // Hero CTAs: live keeps today's buy-primary layout; not-live swaps the roles so the
    // working demo button carries the solid style and the buy button becomes an inert stamp.
    const buyBtn = $('btn-buy');
    const demoBtn = $('btn-demo');
    buyBtn.classList.toggle('btn-solid', live);
    buyBtn.classList.toggle('btn-soon', !live);
    buyBtn.setAttribute('aria-disabled', String(!live));
    if (live) buyBtn.removeAttribute('title'); else buyBtn.title = launch.label || 'Launching soon';
    demoBtn.classList.toggle('btn-line', live);
    demoBtn.classList.toggle('btn-solid', !live);
    $('buy-soon-stamp').hidden = live;
    $('mode-line').classList.toggle('note-serif', !live);

    if (state.contract) {
      $('mode-line').textContent = state.paused ? 'Sales are paused right now.' : state.locked === false ? 'The operator has not locked the odds yet. Nothing sells until they do.' : `Live on ${C.chainName}. Pay in USDG, prizes land as stock tokens in your wallet.`;
      const a = document.createElement('a');
      a.href = `${C.explorer}/address/${state.contract}`; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Contract';
      a.title = `${SP.shortAddr(state.contract)} on ${C.chainName}`;
      $('foot-contract').replaceChildren(a);
    } else if (live) {
      $('mode-line').textContent = launch.label || `Launching soon on ${C.chainName}.`;
      $('foot-contract').textContent = 'Not deployed yet.';
    } else {
      $('mode-line').textContent = 'Demo packs open right here with the same code the contract will run.';
      $('foot-contract').textContent = 'Not deployed yet.';
    }

    // Social chips: the hero's "follow the launch" row only makes sense pre-launch; the
    // footer row is permanent and just reflects whichever links are configured.
    const chipLink = (id, url) => {
      const el = $(id);
      if (!el) return false;
      if (url) { el.href = url; el.hidden = false; return true; }
      el.hidden = true;
      el.removeAttribute('href');
      return false;
    };
    const heroSocial = [
      chipLink('social-x', social.x),
      chipLink('social-telegram', social.telegram),
      chipLink('social-discord', social.discord),
    ].some(Boolean);
    $('social-row').hidden = live || !heroSocial;
    chipLink('foot-x', social.x);
    chipLink('foot-telegram', social.telegram);
    chipLink('foot-discord', social.discord);

    renderTape();
  }

  function renderTape() {
    const items = [];
    state.tiers.forEach((t) => t.tokens.forEach((x) => items.push(`<span>${esc(x.symbol)} <b>${SP.fmtUsd(t.usdCents)}</b> ${esc(t.name.toLowerCase())}</span>`)));
    items.push(`<span>ONE PACK IN 2,000 <b>HOLDS A SHARE OF LLY</b></span>`);
    const half = items.join('');
    $('tape').innerHTML = half + half;
  }

  function renderOdds() {
    const tiers = state.tiers;
    const total = tiers.reduce((sum, t) => sum + t.weight, 0);
    const wrap = $('tiers');
    wrap.innerHTML = '';
    let evCents = 0;
    tiers.forEach((t, i) => {
      const p = t.weight / total;
      evCents += p * t.usdCents;
      const oneIn = Math.round(total / t.weight);
      const r = Math.min(i, 5);
      const el = document.createElement('div');
      el.className = 'tier';
      el.style.setProperty('--r', `var(--r-${r})`);
      el.dataset.tier = String(r);
      const worth = t.usdCents % 100 === 0 ? '$' + (t.usdCents / 100).toLocaleString('en-US') : SP.fmtUsd(t.usdCents);
      el.innerHTML =
        `<div class="tier-meta">` +
          `<div class="tier-name">${esc(t.name)}</div>` +
          `<div class="tier-nums">` +
            `<div class="tier-odds"><b>${fmtPct(p)}</b><span>${oneIn >= 5 ? `1 in ${oneIn.toLocaleString('en-US')} pulls` : 'of all pulls'}</span></div>` +
            `<div class="tier-worth"><b>${worth}</b><span>${t.usdCents >= 100000 ? 'one whole share' : 'of stock per pull'}</span></div>` +
          `</div>` +
        `</div>` +
        `<div class="tier-set">` +
          t.tokens.map((x) => `<div class="mini" title="${esc(x.name || x.symbol)}"><div class="mini-band"></div>${logoImg(x.symbol, 'mini-logo')}<div class="mini-sym">${esc(x.symbol)}</div></div>`).join('') +
          (i === tiers.length - 1 && t.tokens.length === 1 ? `<p class="tier-note">A whole share of ${esc(t.tokens[0].name || t.tokens[0].symbol)}, worth about ${worth} today. Every pack has five shots at it; one pack in ${Math.round(1 / (1 - Math.pow(1 - p, state.pulls))).toLocaleString('en-US')} lands one.</p>` : '') +
        `</div>`;
      wrap.appendChild(el);
    });
    tuneLogosIn(wrap);
    const evPack = (evCents * state.pulls) / 100;
    const priceUsd = Number(state.price) / 10 ** C.usdgDecimals;
    const top = tiers[tiers.length - 1];
    const mythicOdds = Math.round(1 / (1 - Math.pow(1 - top.weight / total, state.pulls)));
    const stats = [
      ['Expected value', `${SP.fmtUsd(Math.round(evPack * 100))} per ${SP.fmtUsd(Math.round(priceUsd * 100))} pack`],
      ['Return to player', `${((100 * evPack) / priceUsd).toFixed(1)}%`],
      [`${esc(top.name)} odds`, `1 pack in ${mythicOdds.toLocaleString('en-US')}`],
      ['Pulls per pack', String(state.pulls)],
    ];
    $('odds-ev').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v v-big">${v}</div></div>`).join('');
    $('odds-lock').textContent = state.contract ? (state.locked ? 'Locked on-chain' : 'Not locked yet') : 'Published table';
    $('odds-lock').classList.toggle('ok', !!state.locked);
  }

  function renderFair() {
    const el = $('fair-state');
    el.innerHTML = '';
    const stats = state.contract
      ? [['Contract', state.contract], ['Chain root', C.chainRoot || 'published with the deployment'], ['Chain head now', state.chainHead || '…'], ['Packs sold', String(state.packCount ?? '…')], ['Packs settled', String(state.revealed ?? '…')]]
      : [['Status', 'Demo mode. The verifier below recomputes real packs from their transactions once the contract is live; for now it shows the inputs of your last demo pack.']];
    for (const [k, v] of stats) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`;
      el.appendChild(d);
    }
  }

  function setStatus(text, live) {
    const s = $('stage-status');
    s.textContent = text;
    s.classList.toggle('live', !!live);
  }

  const TIER_COLORS = ['#6b665e', '#2f7d4f', '#2b5fa8', '#6f3fa3', '#c25a12', '#b8891b'];
  const PAPER = '#f4efe4';
  const PAPER2 = '#ebe4d3';
  const INK = '#141311';
  const GOLD = ['#c9a227', '#fff2c8', '#e9c96a', '#b8891b'];
  const SITE_URL = C.siteUrl || 'stonk-packs.vercel.app';
  let sharePreview = null;
  let skipRequested = false;
  const wait = (ms) => sleep(skipRequested ? Math.min(ms, 40) : ms);

  function showStage(pack) {
    state.current = pack;
    skipRequested = false;
    $('stage').hidden = false;
    $('stage-title').textContent = `Pack #${pack.id}${pack.demo ? ' · demo' : ''}`;
    setStatus(pack.statusText || 'sealed', pack.live);
    $('stage-sub').textContent = pack.sub || '';
    $('stage-result').hidden = true;
    $('stage-result').classList.remove('show');
    hideSharePreview();
    $('stage-refund').hidden = true;
    $('big-stamp').hidden = true;
    $('skip-hint').hidden = true;
    $('btn-again').classList.remove('pulse');
    FX.clear();
    const packEl = $('stage-pack');
    packEl.hidden = false;
    packEl.classList.remove('torn', 'rumble');
    packEl.classList.add('wobble');
    const c = $('cards');
    c.innerHTML = '';
    const mid = (state.pulls - 1) / 2;
    for (let i = 0; i < state.pulls; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.setProperty('--dx', `calc(${mid - i} * 108%)`);
      slot.style.setProperty('--dy', '-150px');
      slot.style.setProperty('--rot', `${Math.round((i - mid) * 9)}deg`);
      slot.innerHTML = '<div class="card"><div class="face front"><span>STONK PACKS</span></div><div class="face back"></div></div>';
      c.appendChild(slot);
    }
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function stamp(text, color, ms) {
    const el = $('big-stamp');
    el.textContent = text;
    el.style.setProperty('--stamp', color);
    el.classList.remove('out');
    el.hidden = false;
    void el.offsetWidth;
    clearTimeout(stamp.timer);
    stamp.timer = setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.hidden = true; }, 360); }, ms);
  }

  function fillCard(card, p, pack, i) {
    const tierIdx = Math.min(p.tier, 5);
    card.dataset.tier = String(tierIdx);
    card.style.setProperty('--r', `var(--r-${tierIdx})`);
    card.parentElement.style.setProperty('--r', `var(--r-${tierIdx})`);
    card.querySelector('.face.back').innerHTML =
      `<div class="card-band"><span>${esc(state.tiers[p.tier]?.name || TIER_NAMES[tierIdx])}</span><span>No. ${pack.id}-${i + 1}</span></div>` +
      `<div class="card-body">${p.symbol === 'USDG' ? '<div class="logo logo-cash">$</div>' : logoImg(p.symbol, 'logo')}<div class="sym">${esc(p.symbol)}<small>${esc(p.name || '')}</small></div></div>` +
      `<div class="card-foot"><div class="usd">$0.00</div><div class="amt">${esc(p.amountText || '')}</div><div class="barcode"></div></div>`;
    tuneLogosIn(card);
    return card.querySelector('.usd');
  }

  // The whole show: rumble, tear, deal, then five flips with suspense that grows with rarity.
  async function playOpening(pack) {
    const stage = $('stage');
    const packEl = $('stage-pack');
    const slots = [...$('cards').children];
    skipRequested = false;
    FX.prepare($('fx'));
    setStatus('opening', true);
    $('stage-sub').textContent = pack.demo ? 'Demo pack. Same formula, same table, no chain.' : 'Seed revealed. Opening.';
    $('skip-hint').hidden = false;

    packEl.classList.remove('wobble');
    packEl.classList.add('rumble');
    FX.sound('rumble', 0.75);
    await wait(700);
    packEl.classList.remove('rumble');
    packEl.classList.add('torn');
    FX.sound('tear');
    FX.shake(stage, 1, 350);
    FX.burst(packEl, { n: 40, colors: [PAPER, PAPER2, INK, '#8ee3a8'], speed: [3, 10], size: [4, 11], life: [40, 75], gravity: 0.28 });
    await wait(430);
    packEl.hidden = true;
    FX.resize(); // the arena just lost the wrapper; keep the particle canvas inside it

    for (const slot of slots) {
      slot.classList.add('dealt');
      FX.sound('deal');
      await wait(110);
    }
    await wait(450);
    FX.resize();

    let total = 0;
    for (let i = 0; i < pack.pulls.length && i < slots.length; i++) {
      const p = pack.pulls[i];
      const slot = slots[i];
      const card = slot.querySelector('.card');
      const tier = Math.min(p.tier, 5);
      const usdEl = fillCard(card, p, pack, i);
      slot.classList.add('arm');
      FX.sound('tick');
      const suspense = [0, 250, 750, 1150, 1600, 2300][tier];
      if (suspense && !skipRequested) {
        slot.classList.add(tier >= 4 ? 'tease-hard' : 'tease');
        FX.sound('riser', suspense / 1000);
        await wait(suspense);
        slot.classList.remove('tease', 'tease-hard');
      }
      await wait(140);
      card.classList.add('flipped');
      FX.sound('flip');
      await wait(380);
      slot.classList.remove('arm');
      slot.classList.add('pop');
      FX.sound('hit', tier);
      FX.ring(slot, { color: TIER_COLORS[tier], speed: 8 + tier * 2.5, width: 3 + tier * 1.5, life: 24 + tier * 4 });
      FX.burst(slot, {
        n: [12, 20, 34, 55, 90, 150][tier],
        colors: tier === 5 ? GOLD : [TIER_COLORS[tier], INK, PAPER2, TIER_COLORS[tier]],
        speed: [2, 5 + tier * 1.6], size: [3, 6 + tier], life: [40, 70 + tier * 10], gravity: 0.24,
        shapes: tier >= 3 ? ['rect', 'dot'] : ['rect'], foil: tier === 5,
      });
      if (tier >= 3) FX.shake(stage, tier - 2, 320 + tier * 110);
      if (tier >= 3) stamp(state.tiers[p.tier]?.name || TIER_NAMES[tier], TIER_COLORS[tier], tier === 5 ? 1700 : 950);
      if (tier === 5) FX.rain({ duration: 3800, rate: 7, colors: GOLD, foil: true });
      await FX.countUp(usdEl, p.usdCents, 280 + tier * 130, SP.fmtUsd, false);
      total += p.usdCents;
      await wait([380, 480, 650, 900, 1150, 1700][tier]);
      slot.classList.remove('pop');
    }

    $('skip-hint').hidden = true;
    pack.totalCents = total;
    const priceCents = pack.demo ? C.packPriceUsd * 100 : Math.round((Number(state.price) / 10 ** C.usdgDecimals) * 100);
    $('result-usd').textContent = '$0.00';
    $('result-note').textContent = pack.demo
      ? `Demo. randomness = keccak(operator seed, your seed, pack id, block hash) = ${pack.randomness.slice(0, 18)}… Amounts use approximate prices; the contract sizes them by Chainlink at open time.`
      : `${pack.late ? 'Settled late: the price was refunded and the prizes were paid anyway. ' : ''}Recompute this pack any time under the rules (pack #${pack.id}).`;
    $('btn-again').textContent = pack.demo ? 'Rip another demo' : 'Rip another';
    $('stage-result').hidden = false;
    $('stage-result').classList.add('show');
    await FX.countUp($('result-usd'), total, Math.max(500, Math.min(1400, 400 + total / 4)), SP.fmtUsd, true);
    if (total >= priceCents) {
      FX.sound('cash');
      const gain = total - priceCents;
      stamp(gain > 0 ? `+${gain % 100 === 0 ? '$' + (gain / 100).toLocaleString('en-US') : SP.fmtUsd(gain)} profit` : 'Broke even', '#0a5a2c', 1500);
      FX.burst($('cards'), { n: 90, colors: ['#0f7a3d', '#8ee3a8', ...GOLD], speed: [3, 10], size: [4, 9], life: [45, 85], spread: Math.PI * 1.4 });
      FX.shake(stage, 1, 300);
    } else {
      FX.sound('sad');
      $('btn-again').classList.add('pulse');
    }
    setStatus(pack.late ? 'settled late' : 'opened', false);
    window.dispatchEvent(new CustomEvent('stonk:opened', { detail: pack }));
  }

  // ---------------------------------------------------------------------------
  // Demo packs: identical maths, local entropy
  // ---------------------------------------------------------------------------
  function openDemo() {
    const id = ++state.demoCount;
    let seed = SP.randomBytes32();
    const buyerSeed = SP.randomBytes32();
    const bh = SP.randomBytes32();
    let randomness = SP.packRandomness(seed, buyerSeed, id, bh);
    let raw = SP.pullsFrom(randomness, state.pulls, state.tiers);
    // ?demo=Mythic (or any tier name) re-rolls the demo until that rarity appears: for looking at the show, not for the odds.
    const wantName = new URLSearchParams(location.search).get('demo');
    const want = wantName ? state.tiers.findIndex((t) => t.name.toLowerCase() === wantName.toLowerCase()) : -1;
    for (let tries = 0; want >= 0 && !raw.some((r) => r.tier === want) && tries < 8000; tries++) {
      seed = SP.randomBytes32();
      randomness = SP.packRandomness(seed, buyerSeed, id, bh);
      raw = SP.pullsFrom(randomness, state.pulls, state.tiers);
    }
    const pulls = raw.map((r) => {
      const t = state.tiers[r.tier];
      const tok = t.tokens[r.tokenIndex];
      const px = C.demoPrices[tok.symbol];
      return { tier: r.tier, symbol: tok.symbol, name: tok.name, usdCents: t.usdCents, amountText: px ? `~${(t.usdCents / 100 / px).toFixed(4)} ${tok.symbol}` : '' };
    });
    const pack = { id, demo: true, pulls, seed, buyerSeed, bh, randomness: SP.bytesToHex(randomness), statusText: 'sealed', live: true, sub: 'Demo pack. Same formula, same table, no chain.' };
    showStage(pack);
    setTimeout(() => { if (state.current === pack) playOpening(pack); }, 800);
  }

  // ---------------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------------
  async function connect() {
    if (state.account) return state.account;
    if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or Rabby, or open this page inside a wallet browser.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    state.account = accounts[0];
    $('btn-connect').textContent = SP.shortAddr(state.account);
    $('mine').hidden = false;
    $('menu-mine').hidden = false;
    refreshMine().catch(() => {});
    return state.account;
  }

  async function ensureChain() {
    const cid = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(cid, 16) === C.chainId) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: C.chainIdHex }] });
    } catch (e) {
      if (e && (e.code === 4902 || /unrecognized|not added|Unrecognized chain/i.test(e.message || ''))) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: C.chainIdHex, chainName: C.chainName, rpcUrls: [C.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [C.explorer] }] });
      } else throw e;
    }
  }

  const sendTx = (to, data) => window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: state.account, to, data }] });

  async function waitReceipt(hash) {
    for (let i = 0; i < 200; i++) {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (r) return r;
      await sleep(1500);
    }
    throw new Error('Transaction is taking too long; check the explorer.');
  }

  // ---------------------------------------------------------------------------
  // Buying and watching a real pack
  // ---------------------------------------------------------------------------
  async function buyReal() {
    const btn = $('btn-buy');
    btn.disabled = true;
    try {
      await connect();
      await ensureChain();
      if (state.paused) throw new Error('Sales are paused right now.');
      if (state.locked === false) throw new Error('The operator has not locked the odds yet; nothing sells until then.');
      const bal = await viewBig(C.usdg, 'balanceOf(address)', state.account);
      if (bal < state.price) throw new Error(`You need ${fmtUsdg(state.price)} USDG on ${C.chainName}; you have ${fmtUsdg(bal)}.`);
      const allowance = await viewBig(C.usdg, 'allowance(address,address)', state.account, state.contract);
      if (allowance < state.price) {
        toast('Approve USDG once, then the pack.');
        const h = await sendTx(C.usdg, SP.encodeCall('approve(address,uint256)', state.contract, MAX_UINT));
        await waitReceipt(h);
      }
      const buyerSeed = SP.randomBytes32();
      const hash = await sendTx(state.contract, SP.encodeCall('buy(bytes32)', buyerSeed));
      toast('Pack bought. Waiting for the chain…');
      const rcpt = await waitReceipt(hash);
      if (rcpt.status !== '0x1') throw new Error('The purchase reverted. Nothing was charged beyond gas.');
      const bought = rcpt.logs.map(SP.decodeLog).find((l) => l && l.name === 'Bought');
      if (!bought) throw new Error('Bought event missing from the receipt.');
      const pack = { id: Number(bought.packId), demo: false, buyerSeed, tx: hash, block: parseInt(rcpt.blockNumber, 16), boughtAt: Date.now(), pulls: null, statusText: 'sealed', live: true, sub: 'Sealed. The chain needs two Ethereum blocks before anyone can open it, about 20 seconds.' };
      state.localPacks.push({ id: pack.id, buyerSeed, tx: hash, block: pack.block, boughtAt: pack.boughtAt });
      saveLocal();
      showStage(pack);
      watchPack(pack);
    } catch (e) {
      toast(e && e.message ? e.message : String(e), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function watchPack(pack) {
    for (;;) {
      if (state.current !== pack) return;
      let st;
      try { st = await view(state.contract, 'packState(uint256)', pack.id); } catch (e) { await sleep(3000); continue; }
      const status = Number(SP.toBig(st[0]));
      const openable = SP.toBig(st[1]) === 1n;
      const expired = SP.toBig(st[2]) === 1n;
      if (status === 2) { await revealFromChain(pack); return; }
      if (status === 3) { setStatus('refunded', false); $('stage-sub').textContent = 'Refunded. The prizes arrive when the seed surfaces; this pack stays listed under "Your packs".'; return; }
      const age = (Date.now() - pack.boughtAt) / 1000;
      if (expired) { setStatus('expired', false); $('stage-sub').textContent = ''; $('stage-refund').hidden = false; return; }
      if (openable) {
        setStatus('opening', true);
        $('stage-sub').textContent = age > 120 ? 'The operator is late. Any pack not opened within 40 minutes becomes refundable, and still pays its prizes.' : 'The chain is ready. Waiting for the operator to reveal the seed…';
      } else {
        $('stage-sub').textContent = `Sealed. Opens in about ${Math.max(3, Math.round(24 - age))} seconds.`;
      }
      await sleep(3000);
    }
  }

  async function revealFromChain(pack) {
    const from = '0x' + Math.max(0, (pack.block || C.deployBlock) - 1).toString(16);
    const logs = await rpc('eth_getLogs', [{ address: state.contract, fromBlock: from, toBlock: 'latest', topics: [[SP.EVENTS.Opened, SP.EVENTS.Pull], SP.topicWord(BigInt(pack.id))] }]);
    const dec = logs.map(SP.decodeLog).filter(Boolean);
    const opened = dec.find((l) => l.name === 'Opened');
    pack.pulls = dec.filter((l) => l.name === 'Pull').sort((a, b) => a.index - b.index).map((p) => ({
      tier: p.tier,
      symbol: p.cash ? 'USDG' : symbolOf(p.token),
      name: p.cash ? 'paid in cash' : nameOf(p.token),
      usdCents: p.usdCents,
      amountText: p.cash ? `${SP.fmtAmount(p.amount, C.usdgDecimals, 2)} USDG` : `${SP.fmtAmount(p.amount, 18, 5)} ${symbolOf(p.token)}`,
    }));
    pack.randomness = opened ? opened.randomness : null;
    pack.late = opened ? opened.late : false;
    await playOpening(pack);
  }

  async function refundCurrent() {
    const pack = state.current;
    if (!pack || pack.demo) return;
    try {
      const h = await sendTx(state.contract, SP.encodeCall('refundExpired(uint256)', pack.id));
      await waitReceipt(h);
      toast('Refunded. The prizes follow when the seed surfaces.');
      $('stage-refund').hidden = true;
      setStatus('refunded', false);
      refreshMine().catch(() => {});
    } catch (e) { toast(e.message || String(e), true); }
  }

  // ---------------------------------------------------------------------------
  // Your packs (this browser's purchases) and IOUs
  // ---------------------------------------------------------------------------
  const storeKey = () => `stonkpacks:${C.chainId}:${state.contract || 'demo'}`;
  function loadLocal() { try { state.localPacks = JSON.parse(localStorage.getItem(storeKey()) || '[]'); } catch { state.localPacks = []; } }
  function saveLocal() { try { localStorage.setItem(storeKey(), JSON.stringify(state.localPacks)); } catch { /* private mode */ } }

  const mkBtn = (label, primary) => { const b = document.createElement('button'); b.className = `btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}`; b.textContent = label; return b; };

  async function refreshMine() {
    const list = $('mine-list');
    if (!state.contract) { list.innerHTML = '<p class="fine">Demo mode has no on-chain packs.</p>'; return; }
    if (!state.account) return;
    try {
      const owed = await viewBig(state.contract, 'owed(address)', state.account);
      const line = $('owed-line');
      if (owed > 0n) {
        line.hidden = false;
        line.innerHTML = `<span>The treasury owes you <strong>${fmtUsdg(owed)} USDG</strong> (an IOU from a pull it could not deliver).</span>`;
        const b = mkBtn('Claim', true);
        b.onclick = async () => { try { const h = await sendTx(state.contract, SP.encodeCall('claimOwed()')); await waitReceipt(h); toast('Claimed what the treasury had.'); refreshMine(); } catch (e) { toast(e.message || String(e), true); } };
        line.appendChild(b);
      } else line.hidden = true;
    } catch { /* ignore */ }
    list.innerHTML = '';
    const packs = state.localPacks.slice().reverse();
    if (!packs.length) { list.innerHTML = '<p class="fine">Packs you buy in this browser show up here.</p>'; return; }
    for (const p of packs) {
      let status = 0, expired = false;
      try { const st = await view(state.contract, 'packState(uint256)', p.id); status = Number(SP.toBig(st[0])); expired = SP.toBig(st[2]) === 1n; } catch { /* leave unknown */ }
      const row = document.createElement('div');
      row.className = 'pack-row';
      row.innerHTML = `<div><strong>Pack #${p.id}</strong> <span class="meta">${STATUS[status] || 'unknown'}${status === 1 && expired ? ' · expired' : ''}</span></div><div class="actions"></div>`;
      const actions = row.querySelector('.actions');
      const mkPack = (extra) => ({ id: p.id, demo: false, block: p.block, boughtAt: p.boughtAt, buyerSeed: p.buyerSeed, pulls: null, ...extra });
      if (status === 2) { const b = mkBtn('Show pulls'); b.onclick = () => { const pk = mkPack({ statusText: 'opened', live: false }); showStage(pk); revealFromChain(pk).catch((e) => toast(e.message, true)); }; actions.appendChild(b); }
      if (status === 1 && expired) { const b = mkBtn('Refund', true); b.onclick = () => { const pk = mkPack({ statusText: 'expired', live: false }); showStage(pk); $('stage-refund').hidden = false; }; actions.appendChild(b); }
      if (status === 1 && !expired) { const b = mkBtn('Watch'); b.onclick = () => { const pk = mkPack({ statusText: 'sealed', live: true }); showStage(pk); watchPack(pk); }; actions.appendChild(b); }
      const a = document.createElement('a');
      a.href = `${C.explorer}/tx/${p.tx}`; a.target = '_blank'; a.rel = 'noopener'; a.className = 'meta'; a.textContent = 'tx';
      actions.appendChild(a);
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Verifier: recompute a pack from its transactions
  // ---------------------------------------------------------------------------
  const seedFromInput = (input) => '0x' + input.slice(2 + 8 + 64, 2 + 8 + 128);

  async function verify(id) {
    const out = $('verify-out');
    out.hidden = false;
    const lines = [];
    const print = () => { out.innerHTML = lines.join('\n'); };
    if (!state.contract) {
      lines.push('Demo mode: there is no chain to read. Once the contract is live this recomputes a pack from its transactions.');
      const p = state.current && state.current.demo ? state.current : null;
      if (p) {
        lines.push('', `Demo pack #${p.id}:`, `  operator seed  ${p.seed}`, `  your seed      ${p.buyerSeed}`, `  block hash     ${p.bh}`, `  randomness     ${p.randomness}`);
        const again = SP.bytesToHex(SP.packRandomness(p.seed, p.buyerSeed, p.id, p.bh));
        lines.push(`  recomputed     ${again}  ${again === p.randomness ? '<span class="ok">✓ keccak(abi.encode(seed, yourSeed, packId, blockHash))</span>' : '<span class="bad">✗</span>'}`);
      }
      print();
      return;
    }
    lines.push(`Pack #${id}: reading its events…`);
    print();
    try {
      const pw = await view(state.contract, 'packs(uint256)', id);
      const status = Number(SP.toBig(pw[2]));
      if (status === 0) throw new Error('No such pack.');
      if (status !== 2) throw new Error(`Pack #${id} is ${STATUS[status]}; nothing to verify until it has been opened.`);
      const latest = parseInt(await rpc('eth_blockNumber'), 16);
      const findLogs = async (topics) => {
        const CHUNK = 50000;
        for (let to = latest, n = 0; to >= C.deployBlock && n < 80; to -= CHUNK, n++) {
          const from = Math.max(C.deployBlock, to - CHUNK + 1);
          const logs = await rpc('eth_getLogs', [{ address: state.contract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics }]);
          if (logs.length) return logs;
        }
        return [];
      };
      const openedLog = (await findLogs([SP.EVENTS.Opened, SP.topicWord(BigInt(id))]))[0];
      if (!openedLog) throw new Error('Opened event not found in the last 4M blocks. Set deployBlock in config.js for older packs.');
      const ev = SP.decodeLog(openedLog);
      const pulls = (await rpc('eth_getLogs', [{ address: state.contract, fromBlock: openedLog.blockNumber, toBlock: openedLog.blockNumber, topics: [SP.EVENTS.Pull, SP.topicWord(BigInt(id))] }])).map(SP.decodeLog).sort((a, b) => a.index - b.index);
      const tx = await rpc('eth_getTransactionByHash', [openedLog.transactionHash]);
      const seed = seedFromInput(tx.input);
      const boughtLog = (await findLogs([SP.EVENTS.Bought, SP.topicWord(BigInt(id))]))[0];
      if (!boughtLog) throw new Error('Bought event not found.');
      const bought = SP.decodeLog(boughtLog);
      const rand = SP.bytesToHex(SP.packRandomness(seed, bought.buyerSeed, id, ev.blockHash));
      lines.length = 0;
      lines.push(
        `Pack #${id}${ev.late ? ' (settled late: refunded, then paid anyway)' : ''}`,
        `  operator seed   ${seed}  (calldata of ${esc(openedLog.transactionHash)})`,
        `  buyer seed      ${bought.buyerSeed}  (Bought event)`,
        `  block hash      ${ev.blockHash}  (Opened event)`,
        `  randomness      ${ev.randomness}`,
        `  recomputed      ${rand}  ${rand === ev.randomness ? '<span class="ok">✓ matches</span>' : '<span class="bad">✗ MISMATCH</span>'}`,
      );
      let prevSeed = null;
      if (id > 1) {
        const prev = (await findLogs([SP.EVENTS.Opened, SP.topicWord(BigInt(id - 1))]))[0];
        if (prev) prevSeed = seedFromInput((await rpc('eth_getTransactionByHash', [prev.transactionHash])).input);
      } else if (C.chainRoot) prevSeed = C.chainRoot;
      if (prevSeed) {
        const h = SP.bytesToHex(SP.keccak256(SP.hexToBytes(seed)));
        lines.push(`  keccak(seed)    ${h}`, `  ${id > 1 ? 'previous seed ' : 'published root'}  ${prevSeed}  ${h === prevSeed ? '<span class="ok">✓ chain link holds</span>' : '<span class="bad">✗ BROKEN CHAIN</span>'}`);
      }
      const mirror = SP.pullsFrom(SP.hexToBytes(ev.randomness), pulls.length || state.pulls, state.tiers);
      lines.push('', 'Pulls, event vs recomputed:');
      mirror.forEach((m, i) => {
        const p = pulls[i];
        const t = state.tiers[m.tier];
        const tok = t.tokens[m.tokenIndex];
        const same = p && p.tier === m.tier && (p.cash || p.token.toLowerCase() === (tok.address || '').toLowerCase());
        lines.push(`  ${i}: ${esc(t.name)} ${SP.fmtUsd(t.usdCents)} of ${esc(tok.symbol)}${p && p.cash ? ' (paid in cash)' : ''}  ${same ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}`);
      });
    } catch (e) {
      lines.push(`<span class="bad">${esc(e.message || String(e))}</span>`);
    }
    print();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function shareText() {
    const p = state.current;
    if (!p || !p.pulls) return '';
    const syms = p.pulls.map((x) => x.symbol).join(', ');
    return `I ripped a Stonk Pack on ${C.chainName} and pulled ${SP.fmtUsd(p.totalCents || 0)} in stocks: ${syms}. ${location.href.split('#')[0]}`;
  }

  // The pack, drawn as a 1200x630 card you can post. Native share sheet where there is
  // one, a download plus the words on the clipboard where there is not.
  function hideSharePreview() {
    if (!sharePreview) return;
    sharePreview.hidden = true;
    sharePreview.removeAttribute('src');
    if (sharePreview.dataset.url) { URL.revokeObjectURL(sharePreview.dataset.url); delete sharePreview.dataset.url; }
  }

  function showSharePreview(blob) {
    if (!sharePreview) {
      sharePreview = document.createElement('img');
      sharePreview.className = 'share-preview';
      sharePreview.alt = 'The pack as a card, ready to post';
      sharePreview.hidden = true;
      $('stage-result').appendChild(sharePreview);
    } else if (sharePreview.dataset.url) {
      URL.revokeObjectURL(sharePreview.dataset.url);
    }
    const url = URL.createObjectURL(blob);
    sharePreview.dataset.url = url;
    sharePreview.src = url;
    sharePreview.hidden = false;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  async function shareCard() {
    const pack = state.current;
    const btn = $('btn-share');
    if (!pack || !pack.pulls || !pack.pulls.length || $('stage-result').hidden) { toast('Open a pack first.'); return; }
    if (!window.SHARE) { copyShareText(); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Drawing the card…';
    try {
      const blob = await SHARE.renderCard(pack, { tiers: state.tiers, tierColors: TIER_COLORS, siteUrl: SITE_URL });
      showSharePreview(blob);
      const name = `stonk-pack-${pack.id}${pack.demo ? '-demo' : ''}.png`;
      const text = shareText();
      let file = null;
      try { file = new File([blob], name, { type: 'image/png' }); } catch { /* no File constructor: download it */ }
      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text });
          toast('Shared.');
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return; // they closed the sheet
          throw e;
        }
      } else {
        download(blob, name);
        let copied = false;
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard permission */ }
        toast(copied ? 'Card saved to your downloads, words copied. Go post it.' : 'Card saved to your downloads. Go post it.');
      }
    } catch (e) {
      console.warn('share card failed', e);
      let copied = false;
      try { await navigator.clipboard.writeText(shareText()); copied = true; } catch { /* nothing left to try */ }
      toast(copied ? 'Could not draw the card; copied the words instead.' : 'Could not draw the card.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function copyShareText() {
    const text = shareText();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('Copied. Go post it.'); } catch { toast(text); }
  }

  async function init() {
    $('foot-github').href = C.github;
    loadLocal();
    await loadContract();
    renderMode();
    renderOdds();
    renderFair();

    $('btn-demo').onclick = () => { FX.unlock(); openDemo(); };
    $('btn-buy').onclick = () => {
      if ($('btn-buy').getAttribute('aria-disabled') === 'true') return;
      FX.unlock();
      if (state.contract) buyReal(); else { toast('Demo mode: opening a demo pack instead.'); openDemo(); }
    };
    $('btn-again').onclick = () => { FX.unlock(); if (state.current && !state.current.demo) buyReal(); else openDemo(); };
    const soundBtn = $('btn-sound');
    const syncSound = () => { soundBtn.textContent = FX.isMuted() ? 'Sound off' : 'Sound on'; soundBtn.setAttribute('aria-pressed', String(!FX.isMuted())); };
    syncSound();
    soundBtn.onclick = () => { FX.setMuted(!FX.isMuted()); FX.unlock(); syncSound(); if (!FX.isMuted()) FX.sound('hit', 1); };
    $('arena').addEventListener('click', () => { skipRequested = true; });
    window.addEventListener('resize', () => FX.resize());
    const heroWrapper = $('hero-wrapper');
    const heroArt = heroWrapper.parentElement;
    heroArt.addEventListener('mousemove', (e) => {
      const r = heroArt.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      heroWrapper.classList.add('tilting');
      heroWrapper.style.transform = `rotate(-4deg) rotateY(${(x * 22).toFixed(1)}deg) rotateX(${(-y * 16).toFixed(1)}deg)`;
    });
    heroArt.addEventListener('mouseleave', () => { heroWrapper.classList.remove('tilting'); heroWrapper.style.transform = ''; });
    $('btn-share').onclick = () => shareCard();
    $('btn-refund').onclick = refundCurrent;
    $('btn-connect').onclick = () => connect().catch((e) => toast(e.message || String(e), true));
    $('btn-verify').onclick = () => { const id = Number($('verify-id').value); if (!state.contract || id >= 1) verify(id); };
    $('verify-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-verify').click(); });
    $('btn-refresh').onclick = () => refreshMine().catch((e) => toast(e.message || String(e), true));

    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on('accountsChanged', (accounts) => {
        state.account = accounts[0] || null;
        $('btn-connect').textContent = state.account ? SP.shortAddr(state.account) : 'Connect wallet';
        if (state.account) refreshMine().catch(() => {});
      });
      window.ethereum.on('chainChanged', () => { /* reads go through the public RPC; nothing to redo */ });
    }
  }

  init().catch((e) => { console.error(e); toast('The page failed to initialise: ' + (e.message || e), true); });
})();
