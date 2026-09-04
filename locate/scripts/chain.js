#!/usr/bin/env node
'use strict';

/**
 * Locate — shared chain plumbing. Zero npm dependencies at runtime.
 *
 * JSON-RPC, a hand-rolled ABI encoder/decoder (address, uint*, int*, bool, bytesN, bytes,
 * string, tuples of the above, and fixed-size arrays), EIP-1559 signing (RLP here,
 * keccak/secp256k1 from the repo root), and the handful of config/formatting helpers every
 * script in this directory needs.
 *
 * The public RPC sits behind something that rejects script user agents, so every request
 * carries a browser-like User-Agent (see rpc()).
 *
 * `--dry-run` is read once at load time. In dry-run, send() prints what it would have signed
 * and sent and returns a fake receipt; it never touches secp256k1.sign or eth_sendRawTransaction.
 */

const fs = require('fs');
const path = require('path');
const secp = require('../../scripts/secp256k1');
const { keccak256 } = require('../../scripts/keccak');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const ADDRESSES_PATH = path.join(CONFIG_DIR, 'addresses.json');
const MARKETS_PATH = path.join(CONFIG_DIR, 'markets.json');

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------------------------------------------------------------------------
// JSON config load/save. saveJson mutates-then-stringifies so existing keys keep their
// original order and new keys land at the end (JS objects preserve string-key insertion
// order); it matches this repo's existing convention exactly: JSON.stringify(x, null, 1)
// with NO trailing newline.
// ---------------------------------------------------------------------------

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveJson(p, obj) {
  const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
  fs.writeFileSync(p, JSON.stringify(obj, replacer, 1));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function env() {
  const addresses = loadJson(ADDRESSES_PATH);
  const rpcUrl = process.env.RPC_URL || addresses.rpc;
  const chainId = Number(process.env.CHAIN_ID || addresses.chainId || 4663);
  const privateKey = process.env.PRIVATE_KEY || '';
  const dryRun = process.argv.includes('--dry-run');
  return { rpcUrl, chainId, privateKey, dryRun, addresses };
}

const CONFIG = env();
const dryRun = CONFIG.dryRun;

function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

let rpcId = 1;

async function rpc(method, params = []) {
  const res = await fetch(CONFIG.rpcUrl, {
    method: 'POST',
    // The Robinhood Chain public RPC sits behind something that 403s a bare script UA.
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ---------------------------------------------------------------------------
// Small hex/word helpers
// ---------------------------------------------------------------------------

const strip = (h) => String(h).replace(/^0x/i, '');
const isHex = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (isHex(v)) return Buffer.from(strip(v), 'hex');
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw new Error(`cannot coerce ${JSON.stringify(v)} to bytes`);
}

function word(n) {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  const u = BigInt.asUintN(256, v);
  return Buffer.from(u.toString(16).padStart(64, '0'), 'hex');
}

function readUint(buf, offset) {
  return BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'));
}

// ---------------------------------------------------------------------------
// ABI type parsing
//
// A type string is one of: address, bool, string, bytes, uintN, intN, bytesN,
// a tuple "(t1,t2,...)", or an array "T[k]" (static, k a literal) / "T[]" (dynamic).
// Tuples/arrays nest, e.g. "(address,uint256)[3]".
// ---------------------------------------------------------------------------

function splitTopLevel(s) {
  const t = s.trim();
  if (t === '') return [];
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of t) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function typeInfo(type) {
  const t = String(type).trim();
  const arrMatch = t.match(/^(.*)\[(\d*)\]$/s);
  if (arrMatch) {
    return { kind: 'array', base: arrMatch[1].trim(), len: arrMatch[2] === '' ? null : parseInt(arrMatch[2], 10), raw: t };
  }
  if (t.startsWith('(') && t.endsWith(')')) {
    return { kind: 'tuple', components: splitTopLevel(t.slice(1, -1)), raw: t };
  }
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

function isDynamic(type) {
  const info = typeInfo(type);
  if (info.kind === 'array') return info.len === null || isDynamic(info.base);
  if (info.kind === 'tuple') return info.components.some(isDynamic);
  return info.kind === 'bytes' || info.kind === 'string';
}

function staticWordSize(type) {
  const info = typeInfo(type);
  if (info.kind === 'array') return info.len * staticWordSize(info.base);
  if (info.kind === 'tuple') return info.components.reduce((a, c) => a + staticWordSize(c), 0);
  return 1;
}

// ---------------------------------------------------------------------------
// ABI encode
// ---------------------------------------------------------------------------

function encodeAtom(info, value) {
  switch (info.kind) {
    case 'address': {
      const hex = strip(value).toLowerCase();
      if (hex.length > 40) throw new Error(`abi: "${value}" is longer than 20 bytes, not a valid address`);
      return word(BigInt('0x' + (hex || '0').padStart(40, '0')));
    }
    case 'bool':
      return word(value ? 1 : 0);
    case 'uint': {
      const v = BigInt(value);
      if (v < 0n || v >= 1n << BigInt(info.bits)) throw new Error(`abi: ${v} out of range for uint${info.bits}`);
      return word(v);
    }
    case 'int': {
      const v = BigInt(value);
      const half = 1n << BigInt(info.bits - 1);
      if (v < -half || v >= half) throw new Error(`abi: ${v} out of range for int${info.bits}`);
      return word(BigInt.asUintN(256, v));
    }
    case 'bytesN': {
      const b = toBuffer(value);
      if (b.length > info.size) throw new Error(`abi: ${b.length} bytes too long for bytes${info.size}`);
      const out = Buffer.alloc(32);
      b.copy(out, 0); // bytesN is left-aligned / right-padded
      return out;
    }
    default:
      throw new Error(`abi: ${info.raw} is not a static atomic type`);
  }
}

function encodeStatic(type, value) {
  const info = typeInfo(type);
  if (info.kind === 'array') {
    if (!Array.isArray(value) || value.length !== info.len) {
      throw new Error(`abi: expected array of length ${info.len} for ${type}`);
    }
    return Buffer.concat(value.map((v) => encodeStatic(info.base, v)));
  }
  if (info.kind === 'tuple') {
    if (!Array.isArray(value) || value.length !== info.components.length) {
      throw new Error(`abi: expected ${info.components.length}-tuple for ${type}, got ${JSON.stringify(value)}`);
    }
    return Buffer.concat(info.components.map((c, i) => encodeStatic(c, value[i])));
  }
  return encodeAtom(info, value);
}

function encodeBytesDynamic(buf) {
  const pad = (32 - (buf.length % 32)) % 32;
  return Buffer.concat([word(buf.length), buf, Buffer.alloc(pad)]);
}

function encodeDynamic(type, value) {
  const info = typeInfo(type);
  if (info.kind === 'bytes') return encodeBytesDynamic(toBuffer(value));
  if (info.kind === 'string') return encodeBytesDynamic(Buffer.from(String(value), 'utf8'));
  if (info.kind === 'array') {
    const len = info.len === null ? value.length : info.len;
    if (info.len !== null && value.length !== len) throw new Error(`abi: expected array length ${len} for ${type}`);
    const body = encodeList(new Array(len).fill(info.base), value);
    return info.len === null ? Buffer.concat([word(len), body]) : body;
  }
  if (info.kind === 'tuple') return encodeList(info.components, value);
  throw new Error(`abi: ${info.raw} is not a dynamic type`);
}

/** Head/tail encoding shared by top-level arg lists, dynamic tuples and dynamic arrays. */
function encodeList(types, values) {
  if (types.length !== values.length) {
    throw new Error(`abi: expected ${types.length} values, got ${values.length}`);
  }
  const headWords = types.map((t) => (isDynamic(t) ? 1 : staticWordSize(t)));
  let tailOffsetWords = headWords.reduce((a, b) => a + b, 0);
  const heads = [];
  const tails = [];
  for (let i = 0; i < types.length; i++) {
    if (isDynamic(types[i])) {
      const encoded = encodeDynamic(types[i], values[i]);
      heads.push(word(tailOffsetWords * 32));
      tails.push(encoded);
      tailOffsetWords += encoded.length / 32;
    } else {
      heads.push(encodeStatic(types[i], values[i]));
    }
  }
  return Buffer.concat([...heads, ...tails]);
}

/** abi.encode(types, values) -> "0x..." */
function abiEncode(types, values) {
  return '0x' + encodeList(types, values).toString('hex');
}

// ---------------------------------------------------------------------------
// ABI decode
// ---------------------------------------------------------------------------

function decodeAtom(info, buf, offset) {
  const w = buf.subarray(offset, offset + 32);
  switch (info.kind) {
    case 'address':
      return secp.toChecksumAddress('0x' + w.subarray(12).toString('hex'));
    case 'bool':
      return readUint(buf, offset) !== 0n;
    case 'uint':
      return readUint(buf, offset);
    case 'int':
      return BigInt.asIntN(256, readUint(buf, offset));
    case 'bytesN':
      return '0x' + w.subarray(0, info.size).toString('hex');
    default:
      throw new Error(`abi: ${info.raw} is not a static atomic type`);
  }
}

function decodeStatic(type, buf, offset) {
  const info = typeInfo(type);
  if (info.kind === 'array') {
    const out = [];
    let cur = offset;
    const elemWords = staticWordSize(info.base);
    for (let i = 0; i < info.len; i++) {
      out.push(decodeStatic(info.base, buf, cur));
      cur += elemWords * 32;
    }
    return out;
  }
  if (info.kind === 'tuple') {
    const out = [];
    let cur = offset;
    for (const c of info.components) {
      out.push(decodeStatic(c, buf, cur));
      cur += staticWordSize(c) * 32;
    }
    return out;
  }
  return decodeAtom(info, buf, offset);
}

function decodeDynamic(type, buf, offset) {
  const info = typeInfo(type);
  if (info.kind === 'bytes') {
    const len = Number(readUint(buf, offset));
    return '0x' + buf.subarray(offset + 32, offset + 32 + len).toString('hex');
  }
  if (info.kind === 'string') {
    const len = Number(readUint(buf, offset));
    return buf.subarray(offset + 32, offset + 32 + len).toString('utf8');
  }
  if (info.kind === 'array') {
    let len = info.len;
    let dataStart = offset;
    if (len === null) {
      len = Number(readUint(buf, offset));
      dataStart = offset + 32;
    }
    return decodeList(new Array(len).fill(info.base), buf, dataStart);
  }
  if (info.kind === 'tuple') return decodeList(info.components, buf, offset);
  throw new Error(`abi: ${info.raw} is not a dynamic type`);
}

function decodeList(types, buf, baseOffset) {
  let headCursor = baseOffset;
  const out = [];
  for (const t of types) {
    if (isDynamic(t)) {
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

/** abi.decode(types, "0x...") -> values[] */
function abiDecode(types, data) {
  const buf = toBuffer(data);
  return decodeList(types, buf, 0);
}

// ---------------------------------------------------------------------------
// Function signatures: selector(sig) / encodeCall(sig, args)
//
// `sig` may be a bare canonical signature ("transfer(address,uint256)") or a Solidity-style
// one with parameter names and storage keywords ("transfer(address to, uint256 amount)") —
// canonicalizeSig() strips names/keywords down to the type list solc actually hashes.
// ---------------------------------------------------------------------------

function canonicalizeParam(p) {
  let s = p.trim().replace(/\b(calldata|memory|storage|indexed)\b/g, ' ').trim();
  if (s.startsWith('(')) {
    let depth = 0;
    let i = 0;
    for (; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const inner = s.slice(1, i - 1);
    const rest = s.slice(i).trim();
    const arrMatch = rest.match(/^((?:\[\d*\])+)/);
    const arraySuffix = arrMatch ? arrMatch[1] : '';
    const comps = splitTopLevel(inner).map(canonicalizeParam);
    return `(${comps.join(',')})${arraySuffix}`;
  }
  const parts = s.split(/\s+/).filter(Boolean);
  return parts[0];
}

function canonicalizeSig(sig) {
  const open = sig.indexOf('(');
  if (open === -1) throw new Error(`not a function signature: ${sig}`);
  const name = sig.slice(0, open).trim();
  const inner = sig.slice(open + 1, sig.lastIndexOf(')'));
  const types = splitTopLevel(inner).filter((p) => p !== '').map(canonicalizeParam);
  return { name, types, canonical: `${name}(${types.join(',')})` };
}

/** Remembers sig/types by 4-byte selector so send()'s dry-run can describe raw calldata. */
const selectorRegistry = new Map();

function selector(sig) {
  const { canonical } = canonicalizeSig(sig);
  return '0x' + keccak256(Buffer.from(canonical, 'utf8')).subarray(0, 4).toString('hex');
}

/** Full 32-byte topic hash of an event signature, e.g. topic("Transfer(address,address,uint256)"). */
function topic(sig) {
  const { canonical } = canonicalizeSig(sig);
  return '0x' + keccak256(Buffer.from(canonical, 'utf8')).toString('hex');
}

function encodeCall(sig, args = []) {
  const { name, types, canonical } = canonicalizeSig(sig);
  const sel = '0x' + keccak256(Buffer.from(canonical, 'utf8')).subarray(0, 4).toString('hex');
  selectorRegistry.set(sel.slice(2), { name, types, canonical });
  const body = types.length ? abiEncode(types, args).slice(2) : '';
  return sel + body;
}

function jsonBig(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

/** Best-effort human description of calldata, used by send()'s dry-run print. */
function describeCalldata(to, data) {
  if (!data || data === '0x') return '(empty calldata)';
  const bytes = (data.length - 2) / 2;
  if (data.length < 10) return `raw calldata (${bytes} bytes)`;
  const sel = data.slice(2, 10);
  const entry = selectorRegistry.get(sel);
  if (!entry) {
    if (!to) return `contract creation (${bytes} bytes bytecode + constructor args)`;
    return `unknown selector 0x${sel} (${bytes} bytes)`;
  }
  try {
    const decoded = entry.types.length ? abiDecode(entry.types, '0x' + data.slice(10)) : [];
    return `${entry.canonical} args=${JSON.stringify(decoded, jsonBig)}`;
  } catch (e) {
    return `${entry.canonical} [undecodable: ${e.message}]`;
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function call(to, sig, args = [], outTypes = []) {
  const data = encodeCall(sig, args);
  const result = await rpc('eth_call', [{ to, data }, 'latest']);
  if (!outTypes.length) return [];
  return abiDecode(outTypes, result);
}

async function estimateGas({ to, data, value, from }) {
  const params = { data: data || '0x' };
  if (to) params.to = to;
  if (from) params.from = from;
  if (value) params.value = '0x' + BigInt(value).toString(16);
  const hex = await rpc('eth_estimateGas', [params]);
  return BigInt(hex);
}

// ---------------------------------------------------------------------------
// RLP + EIP-1559 signing (same shape as scripts/packs/operator.js)
// ---------------------------------------------------------------------------

function rlpLen(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hex = len.toString(16);
  const lenBytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLen(b.length, 0x80), b]);
}
function rlpList(items) {
  const body = Buffer.concat(items);
  return Buffer.concat([rlpLen(body.length, 0xc0), body]);
}
function rlpInt(v) {
  v = BigInt(v);
  if (v === 0n) return rlpBytes(Buffer.alloc(0));
  const h = v.toString(16);
  return rlpBytes(Buffer.from(h.length % 2 ? '0' + h : h, 'hex'));
}
const rlpHex = (h) => rlpBytes(Buffer.from(strip(h), 'hex'));

async function waitReceipt(hash, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`no receipt for ${hash} after ${tries}s`);
}

function explorerTxUrl(hash) {
  return `${CONFIG.addresses.explorer}/tx/${hash}`;
}
function explorerAddressUrl(addr) {
  return `${CONFIG.addresses.explorer}/address/${addr}`;
}

/**
 * send({to, data, value}) — to is falsy for a contract-creation transaction.
 * In dry-run: prints {to, data, value, from} and a decoded description, signs/sends nothing,
 * and returns a fake receipt shaped like a real one so callers can keep flowing.
 */
async function send({ to, data, value = 0n }) {
  const { privateKey, chainId } = CONFIG;
  const from = privateKey ? secp.addressOf(privateKey) : null;
  const valueBig = BigInt(value || 0);

  if (dryRun) {
    console.log('  [dry-run] would send:');
    console.log('    to     :', to || '(contract creation)');
    console.log('    from   :', from || '(unknown — no PRIVATE_KEY set)');
    console.log('    value  :', valueBig.toString());
    console.log('    data   :', data.length > 138 ? `${data.slice(0, 138)}… (${(data.length - 2) / 2} bytes)` : data);
    console.log('    decoded:', describeCalldata(to, data));
    return {
      status: '0x1',
      transactionHash: '0x' + '0'.repeat(64),
      contractAddress: to ? null : '0x' + '0'.repeat(40),
      gasUsed: '0x0',
      dryRun: true,
    };
  }

  if (!privateKey) throw new Error('PRIVATE_KEY is required to send a transaction (or pass --dry-run)');

  const [nonceHex, block, prioHex] = await Promise.all([
    rpc('eth_getTransactionCount', [from, 'pending']),
    rpc('eth_getBlockByNumber', ['latest', false]),
    rpc('eth_maxPriorityFeePerGas', []).catch(() => null),
  ]);
  const baseFee = BigInt(block.baseFeePerGas || '0x0');
  let prio;
  if (prioHex) {
    prio = BigInt(prioHex);
  } else {
    const gasPrice = BigInt(await rpc('eth_gasPrice', []).catch(() => '0x3b9aca00')); // 1 gwei fallback
    prio = gasPrice > baseFee ? gasPrice - baseFee : 1000000000n;
  }
  if (prio <= 0n) prio = 1000000000n;
  const maxFee = baseFee * 2n + prio;

  const estimated = await estimateGas({ to, data, value: valueBig, from });
  const gas = (estimated * 12n) / 10n;

  const fields = [
    rlpInt(chainId),
    rlpInt(BigInt(nonceHex)),
    rlpInt(prio),
    rlpInt(maxFee),
    rlpInt(gas),
    to ? rlpHex(to) : rlpBytes(Buffer.alloc(0)),
    rlpInt(valueBig),
    rlpHex(data),
    rlpList([]),
  ];
  const unsigned = Buffer.concat([Buffer.from([2]), rlpList(fields)]);
  const sig = secp.sign(privateKey, keccak256(unsigned));
  const signed = Buffer.concat([
    Buffer.from([2]),
    rlpList([...fields, rlpInt(BigInt(sig.v - 27)), rlpHex(sig.r), rlpHex(sig.s)]),
  ]);
  const hash = await rpc('eth_sendRawTransaction', ['0x' + signed.toString('hex')]);
  console.log('  sent:', hash);
  console.log('  explorer:', explorerTxUrl(hash));
  const receipt = await waitReceipt(hash);
  console.log('  status:', receipt.status === '0x1' ? 'ok' : 'REVERTED', 'gasUsed', BigInt(receipt.gasUsed).toString());
  if (receipt.status !== '0x1') throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const MARKET_PARAMS_T = '(address,address,address,address,uint256)';
const MARKET_T = '(uint128,uint128,uint128,uint128,uint128,uint128)';
const WAD = 10n ** 18n;

/** bps (e.g. 8600 = 86.00%) -> WAD-scaled ratio, done entirely in BigInt (8600 * 1e14 overflows
 *  a double's exact-integer range, so this must never be plain Number arithmetic). */
function bpsToWad(bps) {
  return BigInt(bps) * (WAD / 10000n);
}

/** keccak256(abi.encode(MarketParams)) — a struct of statics ABI-encodes identically to its
 *  fields as a flat tuple, so this is exactly what Morpho's `Id.wrap(keccak256(abi.encode(...)))`
 *  computes. */
function marketId(params) {
  const { loanToken, collateralToken, oracle, irm, lltv } = params;
  const encoded = encodeList(
    ['address', 'address', 'address', 'address', 'uint256'],
    [loanToken, collateralToken, oracle, irm, lltv]
  );
  return '0x' + keccak256(encoded).toString('hex');
}

/** Decimal string/number -> BigInt base units, exact (no float rounding). */
function toUnits(amount, decimals) {
  const s = String(amount).trim();
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [intPart, fracPart = ''] = abs.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`toUnits: ${amount} has more than ${decimals} decimal places`);
  }
  const fracPadded = fracPart.padEnd(decimals, '0');
  const combined = `${intPart || '0'}${fracPadded}` || '0';
  let v = BigInt(combined);
  if (neg) v = -v;
  return v;
}

/** BigInt base units -> decimal string, trimmed of trailing zeros. */
function fromUnits(units, decimals) {
  let v = BigInt(units);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals) || '0';
  let fracPart = decimals > 0 ? s.slice(s.length - decimals) : '';
  fracPart = fracPart.replace(/0+$/, '');
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

/** Chainlink latestRoundData(), plus decimals() and an age computed off the chain's own
 *  latest block timestamp (never the local clock — this box's clock is not the source of truth). */
async function feedPrice(feedAddress) {
  const [decRaw] = await call(feedAddress, 'decimals()', [], ['uint8']);
  const [, answer, , updatedAt] = await call(
    feedAddress,
    'latestRoundData()',
    [],
    ['uint80', 'int256', 'uint256', 'uint256', 'uint80']
  );
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const now = Number(BigInt(block.timestamp));
  const decimals = Number(decRaw);
  const updatedAtNum = Number(updatedAt);
  return { answer, decimals, updatedAt: updatedAtNum, ageSeconds: now - updatedAtNum };
}

/**
 * Morpho oracle price() is "raw loan units per raw collateral unit, scaled by 1e36"
 * (collateralRaw * price / 1e36 = loanRaw of equal value). Inverted and decimal-adjusted,
 * that's how many whole collateral tokens one whole loan token is worth — for us, USDG per
 * stock. Returned as a decimal string with `precision` fractional digits.
 */
function oracleHumanPrice(price, loanDecimals = 18, collateralDecimals = 6, precision = 6) {
  const p = BigInt(price);
  if (p === 0n) return '0';
  const exp = 36 + loanDecimals - collateralDecimals;
  const scale = 10n ** BigInt(precision);
  const scaled = (10n ** BigInt(exp) * scale) / p;
  return fromUnits(scaled, precision);
}

/** USD cap (a plain integer/decimal number) -> base token units at a given feed price. */
function capUnitsFromUsd(capUsd, feed, tokenDecimals = 18) {
  const capUnits = toUnits(capUsd, 0); // whole-dollar cap amounts in config
  return (capUnits * 10n ** BigInt(feed.decimals) * 10n ** BigInt(tokenDecimals)) / BigInt(feed.answer);
}

module.exports = {
  // rpc / env
  rpc,
  env,
  dryRun,
  flagValue,
  // abi
  abiEncode,
  abiDecode,
  selector,
  topic,
  encodeCall,
  describeCalldata,
  isDynamic,
  // calls / txs
  call,
  estimateGas,
  send,
  waitReceipt,
  explorerTxUrl,
  explorerAddressUrl,
  // config
  loadJson,
  saveJson,
  ADDRESSES_PATH,
  MARKETS_PATH,
  // domain
  MARKET_PARAMS_T,
  MARKET_T,
  WAD,
  bpsToWad,
  marketId,
  toUnits,
  fromUnits,
  feedPrice,
  oracleHumanPrice,
  capUnitsFromUsd,
  // low-level, exposed for other scripts / self-tests
  keccak256,
  secp,
};

if (require.main === module) {
  // `node chain.js` on its own runs a couple of quick self-checks.
  console.log('chain id (config):', CONFIG.chainId, ' rpc:', CONFIG.rpcUrl, ' dryRun:', dryRun);
  const enc = abiEncode(['address', 'uint256'], ['0x0000000000000000000000000000000000000001', 2n]);
  console.log('abiEncode(address,uint256)(0x1, 2) =', enc);
  console.log('abiDecode round-trip =', abiDecode(['address', 'uint256'], enc));
}
