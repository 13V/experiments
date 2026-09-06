'use strict';
/**
 * Manna browser library. No dependencies, no build step.
 *
 * keccak256, a static-ABI encoder/decoder (every call the desk makes takes and returns
 * statically-sized words; the only dynamic return we read is a bytes32[]), revert decoding for
 * the desk's custom errors, JSON-RPC over fetch with batching and a 429 retry, number formatting
 * for USDG (6 dp), Giants and MANNA (18 dp) and Storehouse shares (24 dp), and the arithmetic of
 * a sling as LocateRouter documents it.
 *
 * Exposed as `window.MANNA` in the browser and as `module.exports` under Node (for tests).
 */
(function (root) {
  // =========================================================================================
  // keccak256 (BigInt lanes: slow, and irrelevant for a few dozen hashes per page)
  // =========================================================================================
  const MASK64 = (1n << 64n) - 1n;
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64);

  function permute(A) {
    for (let round = 0; round < 24; round++) {
      const C = [0n, 0n, 0n, 0n, 0n];
      for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
      const D = [0n, 0n, 0n, 0n, 0n];
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B = [[], [], [], [], []];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & MASK64) & B[(x + 2) % 5][y]);
      A[0][0] ^= RC[round];
    }
  }

  /** keccak256 of a Uint8Array or a utf8 string. Returns 32 bytes. */
  function keccak256(input) {
    const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const RATE = 136;
    const padLen = RATE - (msg.length % RATE);
    const padded = new Uint8Array(msg.length + padLen);
    padded.set(msg);
    padded[msg.length] = 0x01;
    padded[padded.length - 1] |= 0x80;
    const A = [];
    for (let x = 0; x < 5; x++) A.push([0n, 0n, 0n, 0n, 0n]);
    const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    for (let off = 0; off < padded.length; off += RATE) {
      for (let i = 0; i < RATE / 8; i++) A[i % 5][Math.floor(i / 5)] ^= dv.getBigUint64(off + i * 8, true);
      permute(A);
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) odv.setBigUint64(i * 8, A[i % 5][Math.floor(i / 5)], true);
    return out;
  }
  const keccakHex = (input) => bytesToHex(keccak256(input));

  // =========================================================================================
  // Bytes and words
  // =========================================================================================
  const TWO256 = 1n << 256n;
  const strip = (h) => String(h).replace(/^0x/i, '');
  const isHex = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]*$/.test(v);
  const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

  function hexToBytes(h) {
    let s = strip(h);
    if (s.length % 2) s = '0' + s;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(b) {
    let s = '0x';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function concat(...arrs) {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  /**
   * One 32-byte ABI word from a bigint, number, boolean, hex string (address, bytes32, uint) or bytes.
   * Negative integers (int24 ticks) are two's-complemented over 256 bits.
   */
  function word(v) {
    if (typeof v === 'boolean') v = v ? 1n : 0n;
    if (typeof v === 'number') v = BigInt(v);
    if (typeof v === 'bigint') {
      if (v < 0n) v = TWO256 + v;
      if (v < 0n || v >= TWO256) throw new Error('word out of range');
      return hexToBytes(v.toString(16).padStart(64, '0'));
    }
    if (typeof v === 'string') {
      if (!isHex(v)) throw new Error('not hex: ' + v);
      v = hexToBytes(v);
    }
    if (!(v instanceof Uint8Array)) throw new Error('cannot encode ' + typeof v);
    if (v.length > 32) throw new Error('word overflow');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  }
  const toBig = (w) => BigInt(bytesToHex(w));
  const toInt = (w) => { const b = toBig(w); return b >= (1n << 255n) ? b - TWO256 : b; };
  const toBool = (w) => toBig(w) !== 0n;
  const toAddrRaw = (w) => bytesToHex(w.subarray(12));
  function toChecksum(addr) {
    const a = strip(addr).toLowerCase();
    const hsh = keccakHex(a).slice(2);
    let out = '0x';
    for (let i = 0; i < a.length; i++) out += parseInt(hsh[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
    return out;
  }
  const toAddr = (w) => toChecksum(toAddrRaw(w));
  const sameAddr = (a, b) => !!a && !!b && strip(a).toLowerCase() === strip(b).toLowerCase();
  const isZeroAddr = (a) => !a || /^0x0{40}$/i.test(a);
  function words(data) {
    const b = typeof data === 'string' ? hexToBytes(data) : data;
    const out = [];
    for (let i = 0; i + 32 <= b.length; i += 32) out.push(b.subarray(i, i + 32));
    return out;
  }

  // =========================================================================================
  // ABI: static words only, tuples inline (no offsets). Types we decode:
  //   uint8..uint256, int24/int256, address, bool, bytes32. Plus one dynamic shape: bytes32[].
  // =========================================================================================
  const selector = (sig) => keccak256(sig).subarray(0, 4);
  const selectorHex = (sig) => bytesToHex(selector(sig));
  function flatten(args, out = []) {
    for (const a of args) Array.isArray(a) ? flatten(a, out) : out.push(a);
    return out;
  }
  /** encodeCall('lenderOf(address,address)', vault, user); a static tuple is passed as an array. */
  const encodeCall = (sig, ...args) => bytesToHex(concat(selector(sig), ...flatten(args).map(word)));

  function decodeWord(w, type) {
    if (type === 'address') return toAddr(w);
    if (type === 'bool') return toBool(w);
    if (type === 'bytes32') return bytesToHex(w);
    if (type.startsWith('int')) return toInt(w);
    if (type.startsWith('uint')) return toBig(w);
    throw new Error('unknown type ' + type);
  }
  /** decode('0x…', ['uint256','address']) -> [bigint, string]; decode('0x…', 'uint256') -> bigint. */
  function decode(data, types) {
    const single = typeof types === 'string';
    const list = single ? [types] : types;
    if (!data || data === '0x') throw new Error('empty return data');
    const ws = words(data);
    if (ws.length < list.length) throw new Error('short return data');
    const out = list.map((t, i) => decodeWord(ws[i], t));
    return single ? out[0] : out;
  }
  /** A `bytes32[]` return: offset word, length word, then the items. */
  function decodeBytes32Array(data) {
    const ws = words(data);
    if (ws.length < 2) return [];
    const off = Number(toBig(ws[0])) / 32;
    const len = Number(toBig(ws[off]));
    return ws.slice(off + 1, off + 1 + len).map(bytesToHex);
  }

  /** MarketParams as the flat five-word tuple Morpho, the router and the IRM take. */
  const marketParamsTuple = (mp) => [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv];
  /** keccak256 of the 160-byte MarketParams encoding: the Morpho market Id. */
  const marketId = (mp) => keccakHex(concat(...marketParamsTuple(mp).map(word)));
  /** Morpho's Market struct as the six-word tuple the IRM takes. */
  const marketTuple = (m) => [m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee];
  /** Event topic0 for a signature like 'Dawn(uint256,address,uint256,...)'. */
  const topic = (sig) => keccakHex(sig);

  // =========================================================================================
  // Reverts: Error(string), Panic(uint256) and the desk's parameterless custom errors
  // =========================================================================================
  const CUSTOM_ERRORS = {
    // Manna
    'Sabbath()': 'It is Sunday. Nothing falls and no dial turns.',
    'NotYetDawn()': 'Dawn opens at 12:00 UTC.',
    'AlreadyFell()': 'Manna already fell today.',
    'StorehouseInactive()': 'This Storehouse is not taking new lenders.',
    'InsufficientShares()': 'You do not hold that many shares in this Storehouse.',
    'InsufficientStake()': 'You do not have that much staked.',
    'NothingToRestore()': 'Nothing to restore: the Storehouse is at its high-water mark, or the Reserve is empty.',
    'NotJubileeYet()': 'It is not Jubilee yet.',
    'NoCharity()': 'No charity address is set on the contract.',
    'TokenNotSet()': 'The MANNA token is not set on the contract yet.',
    'TokenAlreadySet()': 'The token is already set.',
    'UnknownStorehouse()': 'That vault is not registered as a Storehouse.',
    'StorehouseExists()': 'That Storehouse is already registered.',
    'NotFeeRecipient()': 'The vault does not name Manna as its fee recipient.',
    'BadDial()': 'Those dial settings are out of range.',
    'NoSeller()': 'No seller adapter is set.',
    'NotOwner()': 'Only the owner may do that.',
    'ZeroAddress()': 'A zero address was given.',
    'ZeroAmount()': 'The amount must be more than zero.',
    'Reentrancy()': 'Reentrant call.',
    'TransferFailed()': 'A token transfer failed. Check your balance and allowance.',
    // LocateVault
    'ZeroAssets()': 'The amount must be more than zero.',
    'ZeroShares()': 'That amount rounds to zero shares.',
    'FeeTooHigh()': 'Fee too high.',
    'InsufficientBalance()': 'Insufficient balance.',
    'InsufficientAllowance()': 'Insufficient allowance.',
    'InsufficientLiquidity()': 'The Storehouse has no unborrowed balance for that. Try less, or wait for repayments.',
    'LoanTokenMismatch()': 'Loan token mismatch.',
    'MarketNotOnMorpho()': 'That market does not exist on Morpho.',
    'UnknownMarket()': 'Unknown market.',
    'MarketInUse()': 'Market in use.',
    'CapExceeded()': 'That would exceed the market cap.',
    // MemeTwapOracle
    'OracleUnavailable()': 'The Prophet is silent: the pools cannot supply the TWAP window.',
    'InvalidWindow()': 'Invalid oracle window.',
    'TokenNotInPool()': 'Token not in pool.',
  };
  const ERROR_STRING_SEL = selectorHex('Error(string)');
  const PANIC_SEL = selectorHex('Panic(uint256)');
  const customBySelector = new Map(Object.keys(CUSTOM_ERRORS).map((sig) => [selectorHex(sig), sig]));
  const PANIC_CODES = {
    0x01: 'assertion failed', 0x11: 'arithmetic overflow', 0x12: 'division by zero', 0x21: 'invalid enum value',
    0x22: 'invalid storage byte array', 0x31: 'pop on empty array', 0x32: 'out-of-bounds array access',
    0x41: 'out of memory', 0x51: 'call to uninitialized function',
  };
  function decodeABIString(hexAfterSelector) {
    try {
      const ws = words(hexAfterSelector);
      const len = Number(toBig(ws[1]));
      return new TextDecoder().decode(hexToBytes(hexAfterSelector).subarray(64, 64 + len));
    } catch { return null; }
  }
  /** Revert data (hex) -> a sentence, or null when there is nothing to decode. */
  function decodeRevert(data) {
    if (typeof data !== 'string' || data.length < 10 || !isHex(data)) return null;
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === ERROR_STRING_SEL) return decodeABIString('0x' + data.slice(10)) || 'reverted';
    if (sel === PANIC_SEL) {
      const code = Number(toBig(words('0x' + data.slice(10))[0] || new Uint8Array(32)));
      return 'panic: ' + (PANIC_CODES[code] || '0x' + code.toString(16));
    }
    const sig = customBySelector.get(sel);
    if (sig) return sig.slice(0, -2) + ': ' + CUSTOM_ERRORS[sig];
    return 'reverted (selector ' + sel + ')';
  }
  /** Wallets and RPCs nest revert data in different places; try the common ones. */
  function extractRevertData(err) {
    const paths = [
      (e) => e && e.data,
      (e) => e && e.data && e.data.data,
      (e) => e && e.data && e.data.originalError && e.data.originalError.data,
      (e) => e && e.error && e.error.data,
      (e) => e && e.cause && e.cause.data,
      (e) => e && e.info && e.info.error && e.info.error.data,
    ];
    for (const get of paths) {
      try {
        const v = get(err);
        if (typeof v === 'string' && isHex(v) && v.length >= 10) return v;
      } catch { /* next */ }
    }
    if (err && typeof err.message === 'string') {
      const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m && customBySelector.has(m[0].slice(0, 10).toLowerCase())) return m[0];
    }
    return null;
  }
  /** A human sentence for anything a wallet, the RPC or our own code throws. */
  function describeError(err) {
    if (!err) return 'unknown error';
    const data = extractRevertData(err);
    const decoded = data ? decodeRevert(data) : null;
    if (decoded && !decoded.startsWith('reverted (selector')) return decoded;
    if (err.code === 4001 || /user rejected|user denied/i.test(String(err.message))) return 'Rejected in the wallet.';
    if (err.code === -32002) return 'The wallet already has a request open. Check it.';
    if (decoded) return decoded;
    const msg = (err.shortMessage || err.reason || err.message || String(err)).replace(/\s+/g, ' ');
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
  }

  // =========================================================================================
  // JSON-RPC over fetch. Batches eth_call when the node allows it, falls back to one at a time,
  // and retries once after a 429.
  // =========================================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeRpc(url) {
    let nextId = 1;
    let batchSupported = null; // unknown until the first batch reply

    function rpcError(e) {
      const err = new Error((e && e.message) || 'rpc error');
      err.code = e && e.code;
      err.data = e && e.data;
      return err;
    }
    async function post(payload) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.status === 429 && attempt === 0) { await sleep(1500); continue; }
        if (!res.ok) throw new Error('RPC HTTP ' + res.status);
        return res.json();
      }
    }
    async function rpc(method, params = []) {
      const j = await post({ jsonrpc: '2.0', id: nextId++, method, params });
      if (!j || typeof j !== 'object') throw new Error('bad RPC reply');
      if (j.error) throw rpcError(j.error);
      return j.result;
    }
    const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

    /** [{to,data}] -> [{ok:true,result} | {ok:false,error}], one HTTP request per 25 calls when batching works. */
    async function callMany(calls) {
      const out = new Array(calls.length);
      const CHUNK = 25;
      for (let i = 0; i < calls.length; i += CHUNK) {
        const slice = calls.slice(i, i + CHUNK);
        let done = false;
        if (batchSupported !== false) {
          try {
            const base = nextId;
            nextId += slice.length;
            const payload = slice.map((c, k) => ({ jsonrpc: '2.0', id: base + k, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }));
            const j = await post(payload);
            if (Array.isArray(j)) {
              const byId = new Map(j.map((r) => [r.id, r]));
              slice.forEach((c, k) => {
                const r = byId.get(base + k);
                out[i + k] = !r ? { ok: false, error: new Error('missing batch reply') }
                  : r.error ? { ok: false, error: rpcError(r.error) }
                    : { ok: true, result: r.result };
              });
              batchSupported = true;
              done = true;
            } else {
              batchSupported = false;
            }
          } catch (e) {
            if (batchSupported === null) batchSupported = false;
          }
        }
        if (!done) {
          for (let k = 0; k < slice.length; k++) {
            try { out[i + k] = { ok: true, result: await call(slice[k].to, slice[k].data) }; }
            catch (e) { out[i + k] = { ok: false, error: e }; }
          }
        }
      }
      return out;
    }
    const getLogs = (filter) => rpc('eth_getLogs', [filter]);
    const blockNumber = async () => Number(BigInt(await rpc('eth_blockNumber', [])));
    return { rpc, call, callMany, getLogs, blockNumber, url };
  }

  // =========================================================================================
  // Formatting. Every function returns '—' rather than 'NaN' or 'undefined'.
  // =========================================================================================
  const DASH = '—';
  const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);

  function toBigOrNull(raw) {
    if (raw === null || raw === undefined) return null;
    try { return BigInt(raw); } catch { return null; }
  }
  /** raw integer units at `decimals` -> Number (precision loss beyond 2^53 is fine for display). */
  function toNumber(raw, decimals) {
    const b = toBigOrNull(raw);
    if (b === null) return null;
    return Number(b) / Math.pow(10, decimals);
  }
  /** raw units -> exact decimal string, grouped, at most `maxFrac` fraction digits (truncated). */
  function fmtUnits(raw, decimals, maxFrac = 4, minFrac = 0) {
    let b = toBigOrNull(raw);
    if (b === null) return DASH;
    const neg = b < 0n;
    if (neg) b = -b;
    const s = b.toString().padStart(decimals + 1, '0');
    const int = s.slice(0, s.length - decimals) || '0';
    let frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, '');
    if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
    return (neg ? '-' : '') + group(int) + (frac ? '.' + frac : '');
  }
  /** A small positive number with `sig` significant digits and no exponent (0.00001234). */
  function fmtSig(a, sig = 4) {
    if (!finite(a)) return DASH;
    if (a === 0) return '0';
    if (a >= 1) return trimZeros(a.toFixed(Math.max(0, sig - Math.floor(Math.log10(a)) - 1)));
    const places = Math.min(18, Math.ceil(-Math.log10(a)) + sig - 1);
    if (places > 14) return a.toExponential(sig - 1);
    return trimZeros(a.toFixed(places));
  }
  /** 1234567 -> 1.23M; 0.000012 -> 0.000012; null -> —. */
  function fmtCompact(n, dp = 2) {
    if (!finite(n)) return DASH;
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [v, s] of units) if (a >= v) return sign + trimZeros((a / v).toFixed(dp)) + s;
    if (a >= 1) return sign + trimZeros(a.toFixed(dp));
    return sign + fmtSig(a, 4);
  }
  const fmtCompactUnits = (raw, decimals, dp = 2) => fmtCompact(toNumber(raw, decimals), dp);
  const fmtNum = (n, dp = 2) => (finite(n) ? group(n.toFixed(dp)) : DASH);
  /** Dollar amount from a Number; compact above a million. */
  function fmtUsd(n, compact = false) {
    if (!finite(n)) return DASH;
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (compact || a >= 1e6) return sign + '$' + fmtCompact(a, 2);
    if (a >= 1) return sign + '$' + group(a.toFixed(2));
    return sign + '$' + fmtSig(a, 3);
  }
  const fmtUsdRaw = (raw6, compact = false) => fmtUsd(toNumber(raw6, 6), compact);
  /** A fraction (0.162) -> "16.20%". */
  const fmtPct = (frac, dp = 2) => (finite(frac) ? (frac * 100).toFixed(dp) + '%' : DASH);
  const fmtSignedPct = (frac, dp = 2) => (finite(frac) ? (frac >= 0 ? '+' : '') + (frac * 100).toFixed(dp) + '%' : DASH);
  /** A price in USDG per Giant: grouped above 1,000, four places above 1, four significant digits below. */
  function fmtPrice(n) {
    if (!finite(n)) return DASH;
    if (n >= 1000) return '$' + group(n.toFixed(2));
    if (n >= 1) return '$' + trimZeros(n.toFixed(4));
    return '$' + fmtSig(n, 4);
  }
  const shortAddr = (a) => (typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || DASH);
  /** A WAD health factor -> "1.42", "∞" when there is no borrow. */
  function fmtHf(wad) {
    const b = toBigOrNull(wad);
    if (b === null) return DASH;
    if (b > (1n << 200n)) return '∞';
    return (Number(b) / 1e18).toFixed(2);
  }
  /** Seconds -> "hh:mm:ss", or "2d 03:04:05". Never negative. */
  function fmtCountdown(sec) {
    if (!finite(sec)) return DASH;
    let s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const hh = Math.floor(s / 3600); s -= hh * 3600;
    const mm = Math.floor(s / 60); s -= mm * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (d > 0 ? d + 'd ' : '') + pad(hh) + ':' + pad(mm) + ':' + pad(s);
  }
  /** Seconds -> "3d 4h", "2h 05m", "45s": for "spoils in", "ago". */
  function fmtDuration(sec) {
    if (!finite(sec)) return DASH;
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }
  const dateFmt = typeof Intl !== 'undefined'
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : null;
  const dayFmt = typeof Intl !== 'undefined'
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  /** Unix seconds -> "Sun, 13 Sep 2026, 12:00 UTC". */
  function fmtDate(unix) {
    const n = typeof unix === 'bigint' ? Number(unix) : unix;
    if (!finite(n) || n <= 0) return DASH;
    return (dateFmt ? dateFmt.format(new Date(n * 1000)) : new Date(n * 1000).toISOString()) + ' UTC';
  }
  /** A day index (unix days) -> "Sun, 13 Sep 2026". */
  function fmtDay(day) {
    const n = typeof day === 'bigint' ? Number(day) : day;
    if (!finite(n) || n <= 0) return DASH;
    return dayFmt ? dayFmt.format(new Date(n * 86400 * 1000)) : new Date(n * 86400 * 1000).toISOString().slice(0, 10);
  }
  /** "12.5" at 18 decimals -> 12500000000000000000n; null when unparsable. */
  function parseAmount(str, decimals) {
    if (typeof str !== 'string') return null;
    const s = str.trim().replace(/,/g, '');
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [intPart, fracPart = ''] = s.split('.');
    const frac = fracPart.length > decimals ? fracPart.slice(0, decimals) : fracPart.padEnd(decimals, '0');
    return BigInt((intPart || '0') + frac);
  }
  /** 0.162 -> 16.2 and the sign class for CSS ('pos' | 'neg' | ''). */
  const signClass = (n) => (!finite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');

  // =========================================================================================
  // The arithmetic of a sling, in the Prophet's convention: price() is raw Giant units per raw
  // USDG unit, scaled 1e36 (Morpho's "1 unit of collateral in loan units"). USDG has 6 decimals,
  // every Giant 18, so human USDG-per-Giant = 1e48 / price.
  // =========================================================================================
  const E12 = 10n ** 12n, E18 = 10n ** 18n, E36 = 10n ** 36n;
  const SECONDS_PER_YEAR = 31536000;
  const usdgPerGiant = (price) => { const p = toBigOrNull(price); return p && p > 0n ? 1e48 / Number(p) : null; };
  /** Raw Giant -> raw USDG (6 dp) at the Prophet's price, as Manna._usdgFor does it. */
  const giantToUsdRaw = (assets, price) => { const p = toBigOrNull(price), a = toBigOrNull(assets); return p && p > 0n && a !== null ? (a * E36) / p : 0n; };
  const giantToUsd = (assets, price) => toNumber(giantToUsdRaw(assets, price), 6);
  /** Raw USDG -> raw Giant at the Prophet's price. */
  const usdToGiantRaw = (usdRaw, price) => { const p = toBigOrNull(price), u = toBigOrNull(usdRaw); return p && u !== null ? (u * p) / E36 : 0n; };
  /** Morpho's maxBorrow: collateral * price / 1e36 * lltv / 1e18, raw loan units. */
  const maxBorrowRaw = (collateral, price, lltv) => {
    const c = toBigOrNull(collateral), p = toBigOrNull(price), l = toBigOrNull(lltv);
    if (c === null || p === null || l === null) return 0n;
    return (((c * p) / E36) * l) / E18;
  };
  /** LocateRouter's liquidation price: collateral * lltv * 1e12 / borrowAssets, 1e18 = 1 USDG per Giant. */
  const liqPriceWad = (collateral, lltv, borrow) => {
    const c = toBigOrNull(collateral), l = toBigOrNull(lltv), b = toBigOrNull(borrow);
    if (c === null || l === null || !b || b <= 0n) return 0n;
    return (c * l * E12) / b;
  };
  const healthWad = (maxBorrow, borrow) => {
    const m = toBigOrNull(maxBorrow), b = toBigOrNull(borrow);
    if (m === null || !b || b <= 0n) return null;
    return (m * E18) / b;
  };
  const lltvWad = (bps) => BigInt(bps) * 10n ** 14n;
  /** Adaptive Curve IRM rate per second (WAD) -> simple APR as a fraction. */
  const aprFromRate = (rateWad) => { const n = toNumber(rateWad, 18); return n === null ? null : n * SECONDS_PER_YEAR; };
  const apyFromApr = (apr) => (finite(apr) ? Math.exp(apr) - 1 : null);

  // =========================================================================================
  // The calendar, as Manna.sol keeps it
  // =========================================================================================
  const DAY = 86400;
  const DAWN_SECONDS = 43200;
  const SPOIL_DAYS = 7;
  const JUBILEE_DAYS = 49;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const todayIndex = (t = nowSec()) => Math.floor(t / DAY);
  const isSunday = (day) => (Number(day) + 4) % 7 === 0;
  /** The next 12:00 UTC that is not a Sunday, for the masthead before the contract exists. */
  function localNextDawn(t = nowSec()) {
    let d = Math.floor(t / DAY);
    if (t % DAY >= DAWN_SECONDS) d += 1;
    while (isSunday(d)) d += 1;
    return d * DAY + DAWN_SECONDS;
  }

  const api = {
    keccak256, keccakHex, hexToBytes, bytesToHex, concat, word, words, toBig, toInt, toBool, toAddr, toAddrRaw, toChecksum, sameAddr, isZeroAddr, isAddress, isHex,
    selector, selectorHex, encodeCall, decode, decodeBytes32Array, marketParamsTuple, marketId, marketTuple, topic,
    CUSTOM_ERRORS, decodeRevert, extractRevertData, describeError,
    makeRpc, sleep,
    DASH, toNumber, fmtUnits, fmtSig, fmtCompact, fmtCompactUnits, fmtNum, fmtUsd, fmtUsdRaw, fmtPct, fmtSignedPct, fmtPrice, shortAddr, fmtHf,
    fmtCountdown, fmtDuration, fmtDate, fmtDay, parseAmount, signClass,
    E12, E18, E36, usdgPerGiant, giantToUsdRaw, giantToUsd, usdToGiantRaw, maxBorrowRaw, liqPriceWad, healthWad, lltvWad, aprFromRate, apyFromApr,
    DAY, DAWN_SECONDS, SPOIL_DAYS, JUBILEE_DAYS, nowSec, todayIndex, isSunday, localNextDawn,
  };
  root.MANNA = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
