'use strict';
/**
 * Bushel — launch.js
 *
 * Turns a filled-in launch form into a transaction Pons V2's own factory
 * (0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e on Robinhood Chain, chain id 4663) will accept.
 * Bushel deploys nothing of its own in this phase — every coin launched through this page is a
 * plain Pons V2 token, minted by Pons's factory, on Pons's bonding curve. This file is the entire
 * boundary between a form and that factory: it builds calldata, reads the factory's own state to
 * say whether a launch would be accepted before anyone is asked to pay for it, and drives the
 * three-step wallet flow (network, simulate, send) that turns a click into a signed transaction.
 *
 * No build step, no framework, no npm dependency — matching site/app.js and site/lib.js in
 * ../../manna, the same author's sibling project, whose house style this follows: an ABI codec and
 * a keccak256 written out by hand rather than pulled in, JSON-RPC as one injected `rpc(method,
 * params)` function so every read here is exactly as testable outside a browser as inside one, and
 * revert data turned into a sentence instead of a selector. It is exposed as `window.BushelLaunch`
 * in a browser and as `module.exports` under Node (`require('./launch.js')`), which is how the
 * round-trip harness under scratchpad/launch verifies encodeLaunch against real transactions —
 * see that directory for the proof this file's calldata is byte-identical to what real launches
 * on chain actually sent.
 *
 * The four things this exposes, in the order a caller uses them:
 *   validate(form, opts)   — synchronous. null if the form is fine to submit, or a short string
 *                            saying what is wrong. Cheap enough to call on every keystroke.
 *   preflight({...})       — async. Reads the factory's own state for one (launchConfigId,
 *                            pairToken) pair: the fee, the economics pin, whether the pair is
 *                            approved, whether the config is enabled, and the live creator-tax cap.
 *                            Everything launch() needs to know before it dares build calldata.
 *   encodeLaunch(...)      — synchronous, pure. TokenParams + the two trailing arguments -> the
 *                            exact calldata hex launchToken() takes. No chain access at all; see
 *                            the ABI section below for why this is the hard part of the file.
 *   launch({...})          — async. The whole flow: confirm the wallet is on chain 4663 (switching
 *                            or adding it if not), preflight, validate again defensively, encode,
 *                            eth_call the exact transaction first so a doomed launch costs nothing,
 *                            then eth_sendTransaction, wait for the receipt, and decode the
 *                            TokenLaunched log into { token, curve, deployer, txHash, receipt }.
 */
(function (root) {
  // ===========================================================================================
  // Bytes, hex and UTF-8 — the primitives everything else is built from. Uint8Array throughout
  // (never Buffer: this file has to run unmodified in a browser), matching the conventions
  // ../../manna/site/lib.js already uses for the same reason.
  // ===========================================================================================
  const TWO256 = 1n << 256n;
  const stripHex = (h) => String(h).replace(/^0x/i, '');
  const isHexLike = (v) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]*$/.test(v) && stripHex(v).length % 2 === 0;
  const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  const isZeroAddress = (v) => typeof v === 'string' && /^0x0{40}$/i.test(stripHex(v));

  function hexToBytes(h) {
    let s = stripHex(h);
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
  const utf8Bytes = (s) => new TextEncoder().encode(s);
  const bytesToUtf8 = (b) => new TextDecoder().decode(b);
  function concatBytes(arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  }
  /** A 'bytes'-typed value in and out of this file is always a hex string; a bare string is not
   *  ambiguated into UTF-8 here (unlike a 'string'-typed ABI value, which always is). */
  function toDynamicBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (isHexLike(v)) return hexToBytes(v);
    throw new Error(`expected hex bytes, got ${JSON.stringify(v)}`);
  }

  // ===========================================================================================
  // keccak256 — the exact algorithm ../../manna/site/lib.js uses (Keccak-f[1600], rate 136,
  // 0x01/0x80 padding: this is "raw" Keccak256 as Ethereum defines it, NOT NIST SHA3-256, which
  // pads differently and would silently produce wrong selectors and addresses). Copied rather
  // than loaded from lib.js because this file must not depend on another script's load order —
  // Bushel is not Manna's page, and nothing here may assume lib.js is even on it. BigInt lanes:
  // slower than a typed-array rewrite, and irrelevant for the few dozen hashes a launch needs.
  // ===========================================================================================
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
  function keccak256(input) {
    const msg = typeof input === 'string' ? utf8Bytes(input) : input;
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
  const selectorHex = (sig) => bytesToHex(keccak256(utf8Bytes(sig))).slice(0, 10);
  const topicHex = (sig) => bytesToHex(keccak256(utf8Bytes(sig)));
  function toChecksumAddress(addr) {
    const a = stripHex(addr).toLowerCase();
    const hash = bytesToHex(keccak256(utf8Bytes(a))).slice(2);
    let out = '0x';
    for (let i = 0; i < a.length; i++) out += parseInt(hash[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
    return out;
  }

  // ===========================================================================================
  // A generic ABI codec — address, bool, uintN, intN, bytesN, bytes, string, tuples "(...)" and
  // arrays "T[]" / "T[k]", nesting arbitrarily. This is more general than launchToken strictly
  // needs (int24 and uintN below 256 only show up in getLaunchConfig's return, not in TokenParams
  // itself), but a launch page needs to read the factory as much as it needs to call it, and one
  // codec that is provably correct both ways is simpler to trust than two narrower ones. Same
  // algorithm as ../../bushel/scripts/chain.js's Node-side encoder, rewritten over Uint8Array so
  // it has no Buffer dependency and runs unmodified in a browser.
  // ===========================================================================================
  function splitTopLevel(s) {
    const t = s.trim();
    if (t === '') return [];
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of t) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim());
  }
  function typeInfo(type) {
    const t = String(type).trim();
    const arrMatch = t.match(/^(.*)\[(\d*)\]$/s);
    if (arrMatch) return { kind: 'array', base: arrMatch[1].trim(), len: arrMatch[2] === '' ? null : parseInt(arrMatch[2], 10), raw: t };
    if (t.startsWith('(') && t.endsWith(')')) return { kind: 'tuple', components: splitTopLevel(t.slice(1, -1)), raw: t };
    if (t === 'address') return { kind: 'address', raw: t };
    if (t === 'bool') return { kind: 'bool', raw: t };
    if (t === 'bytes') return { kind: 'bytes', raw: t };
    if (t === 'string') return { kind: 'string', raw: t };
    let m = t.match(/^uint(\d*)$/);
    if (m) return { kind: 'uint', bits: m[1] ? parseInt(m[1], 10) : 256, raw: t };
    m = t.match(/^int(\d*)$/);
    if (m) return { kind: 'int', bits: m[1] ? parseInt(m[1], 10) : 256, raw: t };
    m = t.match(/^bytes(\d+)$/);
    if (m) return { kind: 'bytesN', size: parseInt(m[1], 10), raw: t };
    throw new Error(`abi: unsupported type "${type}"`);
  }
  function isDynamicType(type) {
    const info = typeInfo(type);
    if (info.kind === 'array') return info.len === null || isDynamicType(info.base);
    if (info.kind === 'tuple') return info.components.some(isDynamicType);
    return info.kind === 'bytes' || info.kind === 'string';
  }
  function staticWordSize(type) {
    const info = typeInfo(type);
    if (info.kind === 'array') return info.len * staticWordSize(info.base);
    if (info.kind === 'tuple') return info.components.reduce((a, c) => a + staticWordSize(c), 0);
    return 1;
  }

  function wordFromUint(v, bits) {
    const b = typeof v === 'bigint' ? v : BigInt(v);
    if (b < 0n || b >= (1n << BigInt(bits))) throw new Error(`uint${bits}: ${b} out of range`);
    return hexToBytes(b.toString(16).padStart(64, '0'));
  }
  function wordFromInt(v, bits) {
    const b = typeof v === 'bigint' ? v : BigInt(v);
    const half = 1n << BigInt(bits - 1);
    if (b < -half || b >= half) throw new Error(`int${bits}: ${b} out of range`);
    const twos = b < 0n ? TWO256 + b : b;
    return hexToBytes(twos.toString(16).padStart(64, '0'));
  }
  function wordFromAddress(addr) {
    const hex = stripHex(addr).toLowerCase();
    if (hex.length > 40) throw new Error(`"${addr}" is longer than 20 bytes, not a valid address`);
    return hexToBytes(hex.padStart(64, '0'));
  }
  const wordFromBool = (b) => hexToBytes((b ? '1' : '0').padStart(64, '0'));
  function wordFromBytesN(value, size) {
    const b = toDynamicBytes(value);
    if (b.length > size) throw new Error(`bytes${size}: ${b.length} bytes is too long`);
    const out = new Uint8Array(32); // bytesN is left-aligned: value first, zero-padded on the right
    out.set(b, 0);
    return out;
  }
  function encodeAtom(info, value) {
    switch (info.kind) {
      case 'address': return wordFromAddress(value);
      case 'bool': return wordFromBool(!!value);
      case 'uint': return wordFromUint(value, info.bits);
      case 'int': return wordFromInt(value, info.bits);
      case 'bytesN': return wordFromBytesN(value, info.size);
      default: throw new Error(`abi: ${info.raw} is not a static atomic type`);
    }
  }
  function encodeStatic(type, value) {
    const info = typeInfo(type);
    if (info.kind === 'array') {
      if (!Array.isArray(value) || value.length !== info.len) throw new Error(`abi: expected array of length ${info.len} for ${type}`);
      return concatBytes(value.map((v) => encodeStatic(info.base, v)));
    }
    if (info.kind === 'tuple') {
      if (!Array.isArray(value) || value.length !== info.components.length) throw new Error(`abi: expected ${info.components.length}-tuple for ${type}`);
      return concatBytes(info.components.map((c, i) => encodeStatic(c, value[i])));
    }
    return encodeAtom(info, value);
  }
  function encodeBytesDynamic(bytes) {
    const padLen = (32 - (bytes.length % 32)) % 32;
    return concatBytes([wordFromUint(bytes.length, 256), bytes, new Uint8Array(padLen)]);
  }
  function encodeDynamic(type, value) {
    const info = typeInfo(type);
    if (info.kind === 'bytes') return encodeBytesDynamic(toDynamicBytes(value));
    if (info.kind === 'string') return encodeBytesDynamic(utf8Bytes(String(value)));
    if (info.kind === 'array') {
      const len = info.len === null ? value.length : info.len;
      if (info.len !== null && value.length !== len) throw new Error(`abi: expected array length ${len} for ${type}`);
      const body = encodeList(new Array(len).fill(info.base), value);
      // A fixed-length array ("T[3]") is inline, no length word; a dynamic one ("T[]") is
      // length-prefixed — the same distinction 'bytes'/'string' draw against bytesN.
      return info.len === null ? concatBytes([wordFromUint(len, 256), body]) : body;
    }
    if (info.kind === 'tuple') return encodeList(info.components, value);
    throw new Error(`abi: ${info.raw} is not a dynamic type`);
  }
  /**
   * The head/tail encoding at the heart of the ABI, and the one piece of this file that most
   * rewards reading closely — it is also, unmodified, how a dynamic tuple like TokenParams
   * encodes correctly with no special-casing anywhere else in this codec.
   *
   * Every value in `types` gets one fixed 32-byte slot in the "head", in the order given. A value
   * whose own encoding is always the same length (address, boolN, uintN, bytesN, or a tuple/array
   * built only from those) has its words written directly into that slot. A value whose length can
   * vary — string, bytes, T[], or a tuple/array containing any of those, exactly what
   * isDynamicType flags — instead gets a *byte offset* written into its slot, and its real bytes
   * are appended after every head slot, in a region this function calls the "tail". Crucially,
   * that offset is counted from byte 0 of THIS list's own head — not from the start of the whole
   * calldata, and not from the start of whatever encloses this list. That is what makes the
   * recursion below correct without any argument threading a "how deep am I" or "where did my
   * parent's data start" value: when encodeDynamic hands a dynamic tuple's own components back
   * into this same function, the offsets it computes for THOSE components are already correct
   * relative to that tuple's own encoding, and the only thing the caller has to get right is
   * placing that whole head+tail block — unmodified — at the position its own offset slot named.
   *
   * Trace it through TokenParams, the first argument of launchToken: at the top level, the args
   * are [TokenParams, uint256, address] (or a fourth, address[], for the snipeTaxExemptions
   * overload). TokenParams contains strings, so isDynamicType flags it dynamic; its head slot in
   * the top-level args holds an offset, and the tail at that offset is exactly this function
   * called again on TokenParams' own ten components (name, symbol, logo, description, socials,
   * creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt). Four of those
   * ten are themselves dynamic strings, each getting its own offset slot within TokenParams' head,
   * pointing further into TokenParams' own tail. The fifth, socials, is a tuple whose every field
   * is a string, so isDynamicType flags IT dynamic too — it gets an offset slot of its own,
   * pointing at yet another head+tail block: this function called a third time, on socials' five
   * components, each of which finally gets a plain offset-and-length-prefixed string. Three levels
   * of offsets, each one only ever relative to its own immediate list, and each one produced by
   * the exact same nine lines below.
   */
  function encodeList(types, values) {
    if (types.length !== values.length) throw new Error(`abi: expected ${types.length} values, got ${values.length}`);
    const headWords = types.map((t) => (isDynamicType(t) ? 1 : staticWordSize(t)));
    let tailOffsetWords = headWords.reduce((a, b) => a + b, 0);
    const heads = [];
    const tails = [];
    for (let i = 0; i < types.length; i++) {
      if (isDynamicType(types[i])) {
        const encoded = encodeDynamic(types[i], values[i]);
        heads.push(wordFromUint(tailOffsetWords * 32, 256));
        tails.push(encoded);
        tailOffsetWords += encoded.length / 32;
      } else {
        heads.push(encodeStatic(types[i], values[i]));
      }
    }
    return concatBytes([...heads, ...tails]);
  }
  const abiEncode = (types, values) => bytesToHex(encodeList(types, values));

  function readUint(buf, offset) { return BigInt(bytesToHex(buf.subarray(offset, offset + 32))); }
  function decodeAtom(info, buf, offset) {
    const w = buf.subarray(offset, offset + 32);
    switch (info.kind) {
      case 'address': return toChecksumAddress(bytesToHex(w.subarray(12)));
      case 'bool': return readUint(buf, offset) !== 0n;
      case 'uint': return readUint(buf, offset);
      case 'int': { const u = readUint(buf, offset); return u >= (1n << 255n) ? u - TWO256 : u; }
      case 'bytesN': return bytesToHex(w.subarray(0, info.size));
      default: throw new Error(`abi: ${info.raw} is not a static atomic type`);
    }
  }
  function decodeStatic(type, buf, offset) {
    const info = typeInfo(type);
    if (info.kind === 'array') {
      const out = []; let cur = offset; const elemWords = staticWordSize(info.base);
      for (let i = 0; i < info.len; i++) { out.push(decodeStatic(info.base, buf, cur)); cur += elemWords * 32; }
      return out;
    }
    if (info.kind === 'tuple') {
      const out = []; let cur = offset;
      for (const c of info.components) { out.push(decodeStatic(c, buf, cur)); cur += staticWordSize(c) * 32; }
      return out;
    }
    return decodeAtom(info, buf, offset);
  }
  /** The mirror image of encodeDynamic: `offset` here is already absolute (decodeList below
   *  resolved the head's relative offset against its own baseOffset before calling this), so a
   *  nested tuple's own components resolve their offsets against THIS offset in turn — the same
   *  "always relative to my own immediate list" rule encodeList's comment walks through. */
  function decodeDynamic(type, buf, offset) {
    const info = typeInfo(type);
    if (info.kind === 'bytes') { const len = Number(readUint(buf, offset)); return bytesToHex(buf.subarray(offset + 32, offset + 32 + len)); }
    if (info.kind === 'string') { const len = Number(readUint(buf, offset)); return bytesToUtf8(buf.subarray(offset + 32, offset + 32 + len)); }
    if (info.kind === 'array') {
      let len = info.len, dataStart = offset;
      if (len === null) { len = Number(readUint(buf, offset)); dataStart = offset + 32; }
      return decodeList(new Array(len).fill(info.base), buf, dataStart);
    }
    if (info.kind === 'tuple') return decodeList(info.components, buf, offset);
    throw new Error(`abi: ${info.raw} is not a dynamic type`);
  }
  function decodeList(types, buf, baseOffset) {
    let headCursor = baseOffset;
    const out = [];
    for (const t of types) {
      if (isDynamicType(t)) {
        const rel = Number(readUint(buf, headCursor));
        out.push(decodeDynamic(t, buf, baseOffset + rel));
        headCursor += 32;
      } else {
        out.push(decodeStatic(t, buf, headCursor));
        headCursor += staticWordSize(t) * 32;
      }
    }
    return out;
  }
  const abiDecode = (types, data) => decodeList(types, hexToBytes(data), 0);

  // ===========================================================================================
  // Revert decoding. A failed eth_call carries a reason as raw hex (a selector, then ABI-encoded
  // arguments), and the difference between "creatorTaxBps is 3 bps over the cap" and "reverted"
  // is entirely whether something here recognizes that selector. Standard Error(string) and
  // Panic(uint256) plus every custom error PonsV2LaunchFactory itself declares (read from its
  // verified ABI, ../../manna/config/pons-abi.json's "factory" key, on 8 September 2026) are all
  // covered; anything else still shows the selector so it is at least identifiable by hand.
  // ===========================================================================================
  const ERROR_SIGS = [
    // The ones a launch actually runs into, worth a plain-English gloss.
    ['CreatorTaxTooHigh()', [], () => "creatorTaxBps is above the factory's maxCreatorTaxBps() cap."],
    ['PairTokenNotApproved()', [], () => 'pairToken is not on the factory\'s approved list (approvedPairTokens is false).'],
    ['LaunchConfigDisabled()', [], () => 'launchConfigId points at a config the factory has disabled.'],
    ['InvalidLaunchConfigId()', [], () => 'launchConfigId does not exist on the factory.'],
    ['LaunchEconomicsMismatch(bytes32,bytes32)', ['bytes32', 'bytes32'],
      (a) => `expectedEconomics does not match what the factory would price right now (pinned ${a[0]}, factory has ${a[1]}) — something about the config or pair economics changed since the pin was read; call previewLaunchEconomics again.`],
    ['LaunchFeeNotPaid()', [], () => 'msg.value did not cover launchFee() — read it fresh (it can change) and send exactly that much.'],
    ['ExemptionListTooLong()', [], () => 'snipeTaxExemptions has more addresses than the factory allows.'],
    ['InvalidTokenParams()', [], () => "TokenParams failed the factory's own validation (commonly an empty name or symbol)."],
    ['ZeroAddress()', [], () => 'a required address was the zero address (commonly creatorFeeRecipient).'],
    ['NotWhitelisted()', [], () => 'this factory currently requires the caller to be a whitelisted launcher.'],
    ['LaunchDependenciesNotWired()', [], () => "the factory's own dependencies (deployer, hook, pool manager) are not fully wired yet."],
    ['LaunchDeployerNotSet()', [], () => 'the factory has no launch deployer set.'],
    ['PairTokenEconomicsInvalid()', [], () => 'pairTokenEconomics for this pairToken is not set or not usable.'],
    ['PairTokenDecimalsMismatch(uint8,uint8)', ['uint8', 'uint8'], (a) => `pairToken's decimals() (${a[1]}) no longer match what the factory recorded (${a[0]}).`],
    ['PairTokenDecimalsUnavailable()', [], () => "pairToken has no readable decimals()."],
    ['PairTokenValidationFailed()', [], () => 'pairToken failed the factory\'s own token validation.'],
    ['SupplyTooHigh()', [], () => "the launch config's supply is above what the curve can price."],
    ['SupplyTooLow()', [], () => "the launch config's supply is below what the curve can price."],
    ['InvalidGraduationThreshold()', [], () => 'the launch config has an invalid graduation threshold.'],
    ['InvalidPhantomQuote()', [], () => 'the launch config has an invalid phantom quote.'],
    ['InvalidBasisPoints()', [], () => 'a basis-points value is out of range (over 10000).'],
    ['InvalidTickSpacing()', [], () => 'the launch config has an invalid tick spacing for its pool fee.'],
    ['CombinedFeeTooHigh()', [], () => 'protocol + creator + buyback fees combined exceed what the factory allows.'],
    ['CurveFeeTooHigh()', [], () => "the launch config's curve fee is too high."],
    ['CurveNotQuotable()', [], () => 'the bonding curve cannot currently be quoted.'],
    // The rest: real errors the factory can raise, decoded but without their own sentence.
    ['AlreadySet()', [], null], ['CoreLpFeeMustBeZero()', [], null], ['FeeTransferFailed()', [], null],
    ['GraduationExecutorNotSet()', [], null], ['GraduationRescueTooEarly(uint256)', ['uint256'], null],
    ['GraduationSeedNotViable()', [], null], ['GraduationStillViable()', [], null],
    ['InexactTransfer(address,uint256,uint256)', ['address', 'uint256', 'uint256'], null],
    ['InvalidSnipeTaxWindow()', [], null], ['NoPendingChange()', [], null], ['NotBuybackController()', [], null],
    ['NotCreatorFeeRecipient()', [], null], ['NotLaunchForwarder()', [], null], ['NotReadyToGraduate()', [], null],
    ['NothingToGraduate()', [], null], ['OwnableInvalidOwner(address)', ['address'], null],
    ['OwnableUnauthorizedAccount(address)', ['address'], null], ['OwnershipCannotBeRenounced()', [], null],
    ['ReentrancyGuardReentrantCall()', [], null], ['SafeERC20FailedOperation(address)', ['address'], null],
    ['SqrtPriceOutOfBounds()', [], null], ['TimelockExpired(uint256)', ['uint256'], null],
    ['TimelockNotElapsed(uint256)', ['uint256'], null], ['TokenNotFound()', [], null], ['UnsupportedPrice()', [], null],
    ['WrongGraduationPhase()', [], null], ['ZeroAmount()', [], null],
  ];
  const ERRORS_BY_SELECTOR = new Map(ERROR_SIGS.map(([sig, types, describe]) => [selectorHex(sig), { sig, types, describe }]));
  const ERROR_STRING_SEL = selectorHex('Error(string)');
  const PANIC_SEL = selectorHex('Panic(uint256)');
  const PANIC_CODES = {
    0x01: 'assertion failed', 0x11: 'arithmetic overflow', 0x12: 'division by zero', 0x21: 'invalid enum value',
    0x22: 'invalid storage byte array', 0x31: 'pop on empty array', 0x32: 'out-of-bounds array access',
    0x41: 'out of memory', 0x51: 'call to uninitialized function',
  };
  /** Revert data (hex, selector + args) -> a sentence, or null if there is nothing to decode. */
  function decodeRevert(data) {
    if (typeof data !== 'string' || data.length < 10 || !isHexLike(data)) return null;
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === ERROR_STRING_SEL) {
      try { return abiDecode(['string'], '0x' + data.slice(10))[0] || 'reverted'; } catch { return 'reverted'; }
    }
    if (sel === PANIC_SEL) {
      try { return 'panic: ' + (PANIC_CODES[Number(abiDecode(['uint256'], '0x' + data.slice(10))[0])] || 'unknown code'); }
      catch { return 'panic'; }
    }
    const entry = ERRORS_BY_SELECTOR.get(sel);
    if (!entry) return `reverted (selector ${sel})`;
    let args = [];
    try { args = entry.types.length ? abiDecode(entry.types, '0x' + data.slice(10)) : []; } catch { /* still name it below */ }
    const name = entry.sig.slice(0, entry.sig.indexOf('('));
    const detail = entry.describe ? entry.describe(args) : (args.length ? `args=${JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : '');
    return detail ? `${name}: ${detail}` : name;
  }
  /** Wallets and RPC clients nest revert data in different places under an error object; try the
   *  common ones, then fall back to spotting a selector-shaped hex string inside err.message —
   *  the only thing left once a caller's rpc() has already flattened everything else to a string,
   *  which is exactly what happens through a plain `throw new Error(jsonRpcError.message)`. */
  function extractRevertData(err) {
    const paths = [
      (e) => e && e.data, (e) => e && e.data && e.data.data,
      (e) => e && e.data && e.data.originalError && e.data.originalError.data,
      (e) => e && e.error && e.error.data, (e) => e && e.cause && e.cause.data,
      (e) => e && e.info && e.info.error && e.info.error.data,
    ];
    for (const get of paths) {
      try { const v = get(err); if (typeof v === 'string' && isHexLike(v) && v.length >= 10) return v; } catch { /* next */ }
    }
    if (err && typeof err.message === 'string') {
      const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m) { const padded = m[0].length % 2 ? m[0] + '0' : m[0]; if (isHexLike(padded)) return padded; }
    }
    return null;
  }
  /** A human sentence for anything a wallet, an rpc() implementation, or this file's own code throws. */
  function describeError(err) {
    if (!err) return 'unknown error';
    const data = extractRevertData(err);
    const decoded = data ? decodeRevert(data) : null;
    if (decoded && !decoded.startsWith('reverted (selector')) return decoded;
    if (err.code === 4001 || /user rejected|user denied/i.test(String(err.message))) return 'Rejected in the wallet.';
    if (err.code === -32002) return 'The wallet already has a request open — check it.';
    if (decoded) return decoded;
    const msg = (err.shortMessage || err.reason || err.message || String(err)).replace(/\s+/g, ' ');
    return msg.length > 220 ? msg.slice(0, 220) + '…' : msg;
  }

  // ===========================================================================================
  // The factory: address, chain, and the two function signatures TokenParams flows through. Both
  // overloads of launchToken share the same TokenParams shape; the only difference is a trailing
  // address[] snipeTaxExemptions, which is why encodeLaunch below treats it as one optional
  // fourth argument rather than two separate functions.
  // ===========================================================================================
  const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'; // config/addresses.json .pons.factory
  const CHAIN_ID = 4663;
  const CHAIN_ID_HEX = '0x1237';
  const DEFAULT_CHAIN = {
    chainId: CHAIN_ID,
    chainIdHex: CHAIN_ID_HEX,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://robinhood-rpc.publicnode.com', 'https://rpc.ordofi.network', 'https://rpc.mainnet.chain.robinhood.com'],
    explorer: 'https://robinhoodchain.blockscout.com',
  };

  const SOCIALS_T = '(string,string,string,string,string)'; // (twitter, telegram, discord, website, farcaster)
  const TOKEN_PARAMS_T = `(string,string,string,string,${SOCIALS_T},address,uint16,bool,bytes32,bytes32)`;
  const TYPES_3 = [TOKEN_PARAMS_T, 'uint256', 'address'];
  const TYPES_4 = [TOKEN_PARAMS_T, 'uint256', 'address', 'address[]'];
  const SIG_3 = `launchToken(${TYPES_3.join(',')})`;
  const SIG_4 = `launchToken(${TYPES_4.join(',')})`;
  const SEL_3 = selectorHex(SIG_3);
  const SEL_4 = selectorHex(SIG_4);
  const TOKEN_LAUNCHED_SIG = 'TokenLaunched(address,address,address,address,uint256,uint256)';
  const TOPIC_TOKEN_LAUNCHED = topicHex(TOKEN_LAUNCHED_SIG); // 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607

  const ZERO_ADDRESS = '0x' + '0'.repeat(40);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function randomSalt() {
    const bytes = new Uint8Array(32);
    (root.crypto || globalThis.crypto).getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  // ===========================================================================================
  // encodeLaunch / decodeLaunch — TokenParams flattened into the array-of-arrays shape the codec
  // above expects, and back. decodeLaunch is not part of what a launch page needs at runtime, but
  // it is exactly encodeLaunch run backwards, and having it here (rather than only in the
  // verification harness) is what lets that harness prove encodeLaunch against real calldata by
  // decoding a real transaction's input and re-encoding it, rather than having to construct a
  // known-good example from scratch to compare against.
  // ===========================================================================================
  /**
   * A caller's form is not the factory's TokenParams: a UI collects a name and a ticker, and the
   * last two fields are machinery it has no reason to know about. So the two are handled by what
   * each of them means, rather than both being passed through and failing deep inside the encoder
   * with "expected hex bytes, got undefined":
   *
   *   salt is a uniqueness nonce that picks the deployed address. Any value is as good as any
   *   other, so an absent one is filled with 32 fresh random bytes.
   *
   *   expectedEconomics is a PIN: the launch reverts if the factory's terms for this pair moved
   *   between reading them and signing. There is no safe default — a zero would either revert or,
   *   worse, disable the check — so an absent one is refused by name. launch() reads it live from
   *   previewLaunchEconomics immediately before sending, which is the only correct source.
   */
  function tokenParamsToTuple(p) {
    p = p || {};
    const s = p.socials || {};
    if (p.expectedEconomics === undefined || p.expectedEconomics === null || p.expectedEconomics === '') {
      throw new Error('expectedEconomics is required — read it from previewLaunchEconomics immediately '
        + 'before encoding (launch() does this for you); it pins the terms the launch was priced against.');
    }
    return [
      String(p.name || ''), String(p.symbol || ''), String(p.logo || ''), String(p.description || ''),
      [String(s.twitter || ''), String(s.telegram || ''), String(s.discord || ''), String(s.website || ''), String(s.farcaster || '')],
      p.creatorFeeRecipient, BigInt(p.creatorTaxBps || 0), !!p.buybackEnabled,
      p.expectedEconomics, p.salt === undefined || p.salt === null || p.salt === '' ? randomSalt() : p.salt,
    ];
  }
  function tupleToTokenParams(t) {
    const [name, symbol, logo, description, socials, creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt] = t;
    return {
      name, symbol, logo, description,
      socials: { twitter: socials[0], telegram: socials[1], discord: socials[2], website: socials[3], farcaster: socials[4] },
      creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt,
    };
  }

  /**
   * TokenParams + launchConfigId + pairToken (+ an optional snipeTaxExemptions address[]) -> the
   * full calldata hex, selector included. Omitting the fourth argument picks the plain three-
   * argument overload; passing an array — even an empty one — picks the address[] overload, since
   * those are two distinct selectors on chain and the only way to tell them apart is which one the
   * caller actually wants.
   */
  function encodeLaunch(params, launchConfigId, pairToken, snipeTaxExemptions) {
    const tuple = tokenParamsToTuple(params);
    const lcid = typeof launchConfigId === 'bigint' ? launchConfigId : BigInt(launchConfigId);
    if (snipeTaxExemptions === undefined || snipeTaxExemptions === null) {
      return SEL_3 + abiEncode(TYPES_3, [tuple, lcid, pairToken]).slice(2);
    }
    return SEL_4 + abiEncode(TYPES_4, [tuple, lcid, pairToken, Array.from(snipeTaxExemptions)]).slice(2);
  }

  /** The inverse of encodeLaunch: full calldata hex -> { overload, params, launchConfigId,
   *  pairToken, snipeTaxExemptions }. Throws if the selector is neither launchToken overload. */
  function decodeLaunch(data) {
    const sel = data.slice(0, 10).toLowerCase();
    let types, overload;
    if (sel === SEL_3) { types = TYPES_3; overload = 3; }
    else if (sel === SEL_4) { types = TYPES_4; overload = 4; }
    else throw new Error(`decodeLaunch: selector ${sel} is neither launchToken overload (${SEL_3} / ${SEL_4})`);
    const decoded = abiDecode(types, '0x' + data.slice(10));
    const [tuple, launchConfigId, pairToken, snipeTaxExemptions] = decoded;
    return { overload, params: tupleToTokenParams(tuple), launchConfigId, pairToken, snipeTaxExemptions };
  }

  // ===========================================================================================
  // validate(form) — the rules the factory enforces (or that are simply sane), checked before
  // anyone is asked to sign anything. Synchronous and cheap on purpose: it takes only the form,
  // returns null when the form is fine to submit or a short string saying what to fix, and never
  // touches the network — so a page can run it on every keystroke. That means the one rule that
  // genuinely needs a live chain read, the creator-tax cap, is checked against a fallback constant
  // by default (DEFAULT_MAX_CREATOR_TAX_BPS, the live maxCreatorTaxBps() as read on 8 September
  // 2026 — it is a value the factory's owner can change with setMaxCreatorTaxBps(), so this is a
  // pre-check, not the last word). Pass opts.maxCreatorTaxBps — preflight() below reads it fresh —
  // to check against the real, current cap instead; launch() always does.
  // ===========================================================================================
  const DEFAULT_MAX_CREATOR_TAX_BPS = 1000n;
  const MAX_NAME_CHARS = 64;
  const MAX_SYMBOL_CHARS = 11; // matches the launch form's own <input maxlength> in site/app.js

  function normalizeForm(form) {
    form = form || {};
    const s = form.socials || {};
    return {
      name: typeof form.name === 'string' ? form.name.trim() : '',
      symbol: typeof form.symbol === 'string' ? form.symbol.trim() : '',
      logo: typeof form.logo === 'string' ? form.logo.trim() : '',
      description: typeof form.description === 'string' ? form.description.trim() : '',
      socials: {
        twitter: typeof s.twitter === 'string' ? s.twitter : '',
        telegram: typeof s.telegram === 'string' ? s.telegram : '',
        discord: typeof s.discord === 'string' ? s.discord : '',
        website: typeof s.website === 'string' ? s.website : '',
        farcaster: typeof s.farcaster === 'string' ? s.farcaster : '',
      },
      creatorFeeRecipient: form.creatorFeeRecipient,
      creatorTaxBps: form.creatorTaxBps,
      buybackEnabled: !!form.buybackEnabled,
      pairToken: form.pairToken,
      launchConfigId: form.launchConfigId,
      salt: form.salt,
      snipeTaxExemptions: form.snipeTaxExemptions,
    };
  }

  /** null if `form` is fine to submit; otherwise a short string naming the first problem found. */
  function validate(form, opts) {
    opts = opts || {};
    const f = normalizeForm(form);

    if (!f.name) return 'Name is required.';
    if (f.name.length > MAX_NAME_CHARS) return `Name is longer than ${MAX_NAME_CHARS} characters.`;
    if (!f.symbol) return 'Symbol is required.';
    if (f.symbol.length > MAX_SYMBOL_CHARS) return `Symbol is longer than ${MAX_SYMBOL_CHARS} characters — most wallets truncate or refuse a longer ticker.`;
    if (!isAddress(f.creatorFeeRecipient) || isZeroAddress(f.creatorFeeRecipient)) return 'creatorFeeRecipient must be a real address — connect a wallet first.';
    if (f.pairToken !== undefined && f.pairToken !== null && f.pairToken !== '' && !isAddress(f.pairToken)) return 'pairToken must be a valid address.';

    let taxBps;
    try { taxBps = BigInt(f.creatorTaxBps === undefined || f.creatorTaxBps === null || f.creatorTaxBps === '' ? 0 : f.creatorTaxBps); }
    catch { taxBps = null; }
    if (taxBps === null || taxBps < 0n) return 'Creator tax must be a non-negative whole number of basis points.';
    if (taxBps > 65535n) return 'Creator tax does not fit in the factory\'s uint16 (max 65535 bps).';
    const cap = opts.maxCreatorTaxBps !== undefined && opts.maxCreatorTaxBps !== null ? BigInt(opts.maxCreatorTaxBps) : DEFAULT_MAX_CREATOR_TAX_BPS;
    if (taxBps > cap) {
      return `Creator tax (${taxBps} bps) is above the factory's cap of ${cap} bps — launchToken would revert CreatorTaxTooHigh.`;
    }

    if (f.salt !== undefined && f.salt !== null && f.salt !== '' && (!isHexLike(f.salt) || stripHex(f.salt).length !== 64)) {
      return 'salt must be a 32-byte hex value (0x + 64 hex characters) when provided.';
    }

    let lcid;
    if (f.launchConfigId !== undefined && f.launchConfigId !== null && f.launchConfigId !== '') {
      try { lcid = BigInt(f.launchConfigId); } catch { lcid = null; }
      if (lcid === null || lcid < 0n) return 'launchConfigId must be a non-negative whole number.';
    }

    return null;
  }

  // ===========================================================================================
  // preflight — reads everything launch() needs to know about one (launchConfigId, pairToken)
  // pair before it dares build calldata: the fee, the economics pin, and every reason the factory
  // would refuse the launch outright. `rpc` is `(method, params) => Promise<result>`, the same
  // shape site/app.js's own rpc() already has (a thin JSON-RPC-over-fetch wrapper with endpoint
  // rotation) — passed straight through rather than reimplemented here, so this file never opens
  // its own connection and never disagrees with the page about which endpoint is healthy.
  // ===========================================================================================
  function callData(sig, types, values) {
    return types.length ? selectorHex(sig) + abiEncode(types, values).slice(2) : selectorHex(sig);
  }

  async function preflight({ pairToken, launchConfigId, rpc, rpcCall, factory = FACTORY }) {
    const call = rpc || rpcCall;
    if (typeof call !== 'function') throw new Error('preflight needs an rpc(method, params) function.');
    if (!isAddress(pairToken)) throw new Error('preflight needs a valid pairToken address.');
    const lcid = typeof launchConfigId === 'bigint' ? launchConfigId : BigInt(launchConfigId);

    const readOne = async (sig, types, args, outTypes) => {
      try {
        const data = callData(sig, types, args);
        const raw = await call('eth_call', [{ to: factory, data }, 'latest']);
        const decoded = abiDecode(outTypes, raw);
        return { ok: true, value: outTypes.length === 1 ? decoded[0] : decoded };
      } catch (e) {
        return { ok: false, error: describeError(e) };
      }
    };

    const [feeR, enabledR, maxTaxR, approvedR, econR, configR, previewR] = await Promise.all([
      readOne('launchFee()', [], [], ['uint256']),
      readOne('launchEnabled()', [], [], ['bool']),
      readOne('maxCreatorTaxBps()', [], [], ['uint256']),
      readOne('approvedPairTokens(address)', ['address'], [pairToken], ['bool']),
      readOne('pairTokenEconomics(address)', ['address'], [pairToken], ['uint256', 'uint256', 'uint8']),
      readOne('getLaunchConfig(uint256)', ['uint256'], [lcid], ['uint256', 'uint256', 'uint256', 'uint256', 'uint24', 'int24', 'bool']),
      readOne('previewLaunchEconomics(uint256,address)', ['uint256', 'address'], [lcid, pairToken], ['bytes32']),
    ]);

    const reasons = [];
    if (!feeR.ok) reasons.push(`could not read launchFee(): ${feeR.error}`);
    if (enabledR.ok && enabledR.value === false) reasons.push('launchEnabled() is false — the factory is not accepting launches right now.');
    if (approvedR.ok && approvedR.value === false) reasons.push(`pairToken ${pairToken} is not on approvedPairTokens.`);
    if (!configR.ok) reasons.push(`getLaunchConfig(${lcid}) reverted (${configR.error}) — launchConfigId probably does not exist.`);
    else if (configR.value[6] === false) reasons.push(`launch config ${lcid} exists but is disabled.`);
    if (!previewR.ok) reasons.push(`previewLaunchEconomics reverted: ${previewR.error}`);

    const launchConfig = configR.ok ? {
      supply: configR.value[0], curveFeeBps: configR.value[1], phantomQuote: configR.value[2],
      graduationThreshold: configR.value[3], poolFee: configR.value[4], tickSpacing: configR.value[5], enabled: configR.value[6],
    } : null;
    const pairTokenEconomics = econR.ok ? { phantomQuote: econR.value[0], graduationThreshold: econR.value[1], decimals: econR.value[2] } : null;

    return {
      ok: reasons.length === 0,
      reasons,
      factory, pairToken, launchConfigId: lcid,
      launchFee: feeR.ok ? feeR.value : null,
      launchEnabled: enabledR.ok ? enabledR.value : null,
      maxCreatorTaxBps: maxTaxR.ok ? maxTaxR.value : null,
      approved: approvedR.ok ? approvedR.value : null,
      pairTokenEconomics,
      launchConfig,
      expectedEconomics: previewR.ok ? previewR.value : null,
      errors: {
        launchFee: feeR.ok ? null : feeR.error,
        launchEnabled: enabledR.ok ? null : enabledR.error,
        maxCreatorTaxBps: maxTaxR.ok ? null : maxTaxR.error,
        approvedPairTokens: approvedR.ok ? null : approvedR.error,
        pairTokenEconomics: econR.ok ? null : econR.error,
        getLaunchConfig: configR.ok ? null : configR.error,
        previewLaunchEconomics: previewR.ok ? null : previewR.error,
      },
    };
  }

  // ===========================================================================================
  // launch — the wallet flow. Confirms chain 4663, preflights and validates one more time (form
  // fields and preflight reasons are both checked here even when a caller already ran them, since
  // this is the step that actually spends the launch fee), builds calldata, eth_calls it first so
  // a doomed launch is free to discover, then sends it for real and decodes the result.
  // ===========================================================================================
  async function ensureChain(ethereum, chain = DEFAULT_CHAIN) {
    if (!ethereum) throw new Error('No wallet found — install a browser wallet extension and reload the page.');
    const current = await ethereum.request({ method: 'eth_chainId' });
    if (String(current).toLowerCase() === chain.chainIdHex.toLowerCase()) return { switched: false, added: false };
    try {
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainIdHex }] });
      return { switched: true, added: false };
    } catch (err) {
      if (err && err.code === 4902) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chain.chainIdHex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls,
            blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
          }],
        });
        return { switched: true, added: true };
      }
      throw new Error(`Could not switch the wallet to ${chain.name} (chain ${chain.chainId}): ${describeError(err)}`);
    }
  }

  /** Blocks here are ~0.101s (this is Arbitrum Nitro, not the ~2s the chain's own docs imply), so
   *  a receipt normally shows up in well under a second; the generous tries/interval below is
   *  headroom for a congested mempool or a slow RPC endpoint, not the expected case. */
  async function waitForReceipt(rpc, txHash, { tries = 150, intervalMs = 1000 } = {}) {
    for (let i = 0; i < tries; i++) {
      let r = null;
      try { r = await rpc('eth_getTransactionReceipt', [txHash]); } catch { /* keep polling */ }
      if (r) return r;
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for a receipt for ${txHash} — it may still land; check the explorer.`);
  }

  /** TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
   *  address pairToken, uint256 launchConfigId, uint256 graduationThreshold) — the three indexed
   *  addresses live in topics[1..3] as 32-byte words, so only their low 20 bytes are the address. */
  function findTokenLaunched(receipt, factory) {
    for (const log of receipt.logs || []) {
      if (!log.address || String(log.address).toLowerCase() !== String(factory).toLowerCase()) continue;
      if (!log.topics || !log.topics[0] || log.topics[0].toLowerCase() !== TOPIC_TOKEN_LAUNCHED) continue;
      return {
        token: toChecksumAddress(bytesToHex(hexToBytes(log.topics[1]).subarray(12))),
        curve: toChecksumAddress(bytesToHex(hexToBytes(log.topics[2]).subarray(12))),
        deployer: toChecksumAddress(bytesToHex(hexToBytes(log.topics[3]).subarray(12))),
      };
    }
    return null;
  }

  /**
   * ethereum: an EIP-1193 provider (window.ethereum). from: the connected account. factory,
   * launchConfigId, pairToken: where and what to launch — pairToken/launchConfigId may also be
   * left on `form` instead, in which case launch() reads them from there. form: the same shape
   * validate() takes; buybackEnabled, socials and salt are optional and default to false / empty /
   * random. snipeTaxExemptions: optional address[]; passing it (even []) selects the four-argument
   * launchToken overload. rpc: `(method, params) => Promise<result>`. chain: overrides
   * DEFAULT_CHAIN for ensureChain's wallet_addEthereumChain params.
   *
   * Resolves to { token, curve, deployer, txHash, receipt }.
   */
  async function launch({ ethereum, from, factory = FACTORY, launchConfigId, pairToken, form, snipeTaxExemptions, rpc, rpcCall, chain = DEFAULT_CHAIN }) {
    const doRpc = rpc || rpcCall;
    if (typeof doRpc !== 'function') throw new Error('launch needs an rpc(method, params) function to read and simulate with.');
    if (!ethereum) throw new Error('No wallet found — install a browser wallet extension and reload the page.');
    if (!isAddress(from)) throw new Error('launch needs `from`, the connected account.');

    const f = normalizeForm(form);
    const pair = pairToken || f.pairToken;
    if (!isAddress(pair)) throw new Error('pairToken is required and must be a valid address.');
    const lcidInput = launchConfigId !== undefined && launchConfigId !== null ? launchConfigId : f.launchConfigId;
    if (lcidInput === undefined || lcidInput === null || lcidInput === '') throw new Error('launchConfigId is required.');
    const exemptions = snipeTaxExemptions !== undefined ? snipeTaxExemptions : f.snipeTaxExemptions;

    // Cheap pass first (DEFAULT_MAX_CREATOR_TAX_BPS, no network): an obviously-broken form is
    // rejected before this function ever prompts the wallet or spends an RPC round trip on it.
    const cheapProblem = validate(form);
    if (cheapProblem) throw new Error(cheapProblem);

    await ensureChain(ethereum, chain);

    const pre = await preflight({ pairToken: pair, launchConfigId: lcidInput, rpc: doRpc, factory });
    if (!pre.ok) throw new Error('The factory would refuse this launch: ' + pre.reasons.join(' '));
    // Authoritative pass, against the cap preflight just read live: catches the case where
    // DEFAULT_MAX_CREATOR_TAX_BPS above is stale (the factory's owner can move the cap with
    // setMaxCreatorTaxBps() at any time) in either direction.
    const problem = validate(form, { maxCreatorTaxBps: pre.maxCreatorTaxBps });
    if (problem) throw new Error(problem);

    const params = {
      name: f.name, symbol: f.symbol, logo: f.logo, description: f.description, socials: f.socials,
      creatorFeeRecipient: f.creatorFeeRecipient, creatorTaxBps: BigInt(f.creatorTaxBps || 0),
      buybackEnabled: f.buybackEnabled,
      expectedEconomics: pre.expectedEconomics, // always the fresh pin, never one carried on the form —
      // a stale one only ever costs a guaranteed LaunchEconomicsMismatch revert, never a benefit.
      salt: (f.salt && isHexLike(f.salt) && stripHex(f.salt).length === 64) ? f.salt : randomSalt(),
    };

    const data = encodeLaunch(params, pre.launchConfigId, pair, exemptions);
    const valueHex = '0x' + pre.launchFee.toString(16);

    // Simulate first: a launch that would revert costs nothing to find out here, and everything
    // (gas, the launch fee, a confused user) to find out after the wallet has broadcast it.
    try {
      await doRpc('eth_call', [{ from, to: factory, data, value: valueHex }, 'latest']);
    } catch (e) {
      throw new Error('This launch would revert — nothing was sent. ' + describeError(e));
    }

    const txHash = await ethereum.request({ method: 'eth_sendTransaction', params: [{ from, to: factory, data, value: valueHex }] });
    const receipt = await waitForReceipt(doRpc, txHash);
    const success = receipt.status === '0x1' || receipt.status === 1;
    if (!success) throw new Error(`Transaction ${txHash} reverted on chain.`);
    const found = findTokenLaunched(receipt, factory);
    if (!found) throw new Error(`Transaction ${txHash} succeeded but no TokenLaunched log was found from ${factory}.`);
    return { token: found.token, curve: found.curve, deployer: found.deployer, txHash, receipt };
  }

  // ===========================================================================================
  const api = {
    // the four functions this file exists to provide
    validate, preflight, encodeLaunch, launch,
    // supporting pieces useful to a caller or a test harness
    decodeLaunch, ensureChain, describeError, decodeRevert, extractRevertData,
    abiEncode, abiDecode, keccak256, selectorHex, topicHex, toChecksumAddress, isAddress, randomSalt,
    // constants
    FACTORY, CHAIN_ID, CHAIN_ID_HEX, DEFAULT_CHAIN, ZERO_ADDRESS,
    TOKEN_PARAMS_T, SOCIALS_T, TYPES_3, TYPES_4, SIG_3, SIG_4, SEL_3, SEL_4,
    TOKEN_LAUNCHED_SIG, TOPIC_TOKEN_LAUNCHED, DEFAULT_MAX_CREATOR_TAX_BPS,
  };
  root.BushelLaunch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
