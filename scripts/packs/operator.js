#!/usr/bin/env node
'use strict';

/**
 * Stonk Packs operator bot. Zero dependencies.
 *
 * Reveals operator seeds in order so packs open within seconds of purchase, refunds and
 * skips anything that expired, and never reveals a seed out of sequence.
 *
 *   RPC_URL=https://...  PACKS_ADDRESS=0x...  OPERATOR_KEY=0x...  PACK_SECRET=0x...  PACK_CHAIN_N=10000 \
 *   node scripts/packs/operator.js [--dry-run] [--once]
 *
 * PACK_SECRET is the value printed by `odds.js chain`; it never leaves this process.
 * OPERATOR_KEY is any funded key: opening is permissionless, the seed is what proves itself.
 *
 * Transactions are EIP-1559, signed locally with scripts/secp256k1.js, RLP-encoded here.
 */

const secp = require('../secp256k1');
const { keccak256 } = require('../keccak');
const odds = require('./odds');

const RPC = process.env.RPC_URL;
const PACKS = process.env.PACKS_ADDRESS;
const KEY = process.env.OPERATOR_KEY;
const SECRET = process.env.PACK_SECRET;
const N = Number(process.env.PACK_CHAIN_N || 10000);
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663); // Robinhood Chain
const OPEN_WINDOW = 200n;
const DRY = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');

if (!RPC || !PACKS || !SECRET || (!DRY && !KEY)) {
  console.error('set RPC_URL, PACKS_ADDRESS, PACK_SECRET and OPERATOR_KEY (or use --dry-run)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// JSON-RPC and ABI
// ---------------------------------------------------------------------------

let rpcId = 1;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const strip = (h) => String(h).replace(/^0x/i, '');
const word = (v) => {
  if (typeof v === 'bigint' || typeof v === 'number') return Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex');
  const b = Buffer.from(strip(v), 'hex');
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
};
const selector = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4);
const encode = (sig, ...args) => '0x' + Buffer.concat([selector(sig), ...args.map(word)]).toString('hex');
const big = (hex) => BigInt(hex);

async function callView(sig, ...args) {
  const data = await rpc('eth_call', [{ to: PACKS, data: encode(sig, ...args) }, 'latest']);
  const buf = Buffer.from(strip(data), 'hex');
  const out = [];
  for (let i = 0; i + 32 <= buf.length; i += 32) out.push(buf.subarray(i, i + 32));
  return out;
}

// ---------------------------------------------------------------------------
// RLP + EIP-1559 signing
// ---------------------------------------------------------------------------

function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLen(b.length, 0x80), b]);
}
function rlpLen(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hex = len.toString(16);
  const lenBytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
function rlpList(items) {
  const body = Buffer.concat(items);
  return Buffer.concat([rlpLen(body.length, 0xc0), body]);
}
const rlpInt = (v) => { v = BigInt(v); if (v === 0n) return rlpBytes(Buffer.alloc(0)); const h = v.toString(16); return rlpBytes(Buffer.from(h.length % 2 ? '0' + h : h, 'hex')); };
const rlpHex = (h) => rlpBytes(Buffer.from(strip(h), 'hex'));

async function sendTx(data) {
  const from = secp.addressOf(KEY);
  const [nonceHex, block, prioHex] = await Promise.all([
    rpc('eth_getTransactionCount', [from, 'pending']),
    rpc('eth_getBlockByNumber', ['latest', false]),
    rpc('eth_maxPriorityFeePerGas').catch(() => '0x5f5e100'),
  ]);
  const baseFee = big(block.baseFeePerGas || '0x0');
  const prio = big(prioHex);
  const maxFee = baseFee * 2n + prio;
  const gasHex = await rpc('eth_estimateGas', [{ from, to: PACKS, data }]);
  const gas = (big(gasHex) * 12n) / 10n;

  const fields = [rlpInt(CHAIN_ID), rlpInt(big(nonceHex)), rlpInt(prio), rlpInt(maxFee), rlpInt(gas), rlpHex(PACKS), rlpInt(0), rlpHex(data), rlpList([])];
  const unsigned = Buffer.concat([Buffer.from([2]), rlpList(fields)]);
  const sig = secp.sign(KEY, keccak256(unsigned));
  const signed = Buffer.concat([Buffer.from([2]), rlpList([...fields, rlpInt(sig.v - 27), rlpHex(sig.r), rlpHex(sig.s)])]);
  const hash = await rpc('eth_sendRawTransaction', ['0x' + signed.toString('hex')]);
  return hash;
}

async function waitReceipt(hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('no receipt for ' + hash);
}

async function act(label, data) {
  if (DRY) { console.log(`  dry-run: would send ${label}`); return; }
  const h = await sendTx(data);
  const r = await waitReceipt(h);
  console.log(`  ${label} -> ${r.status === '0x1' ? 'ok' : 'REVERTED'} ${h}`);
  if (r.status !== '0x1') throw new Error(`${label} reverted`);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

const STATUS = ['None', 'Sealed', 'Opened', 'Refunded'];

async function tick() {
  const [count] = await callView('packCount()');
  const [revealed] = await callView('revealed()');
  const blockNo = big(await rpc('eth_blockNumber'));
  const next = big('0x' + revealed.toString('hex')) + 1n;
  const total = big('0x' + count.toString('hex'));
  if (next > total) return false;

  const k = next;
  const p = await callView('packs(uint256)', k); // buyer, purchaseBlock, status, price, buyerSeed
  const purchaseBlock = big('0x' + p[1].toString('hex'));
  const status = STATUS[Number(big('0x' + p[2].toString('hex')))];
  const seed = odds.seedAt(SECRET, N, Number(k));
  const age = blockNo - purchaseBlock;

  console.log(`pack ${k}/${total}: ${status}, age ${age} blocks`);
  if (status === 'Sealed') {
    if (age <= 1n) return true; // wait for purchaseBlock + 1 to exist
    if (age <= OPEN_WINDOW) {
      await act(`open(${k})`, encode('open(uint256,bytes32)', k, seed));
    } else {
      await act(`refundExpired(${k})`, encode('refundExpired(uint256)', k));
      await act(`skip(${k})`, encode('skip(uint256,bytes32)', k, seed));
    }
  } else if (status === 'Refunded') {
    await act(`skip(${k})`, encode('skip(uint256,bytes32)', k, seed));
  } else {
    throw new Error(`pack ${k} is ${status} but revealed is ${next - 1n}; chain state is inconsistent`);
  }
  return true;
}

(async () => {
  console.log(`operator ${DRY ? '(dry run) ' : ''}on chain ${CHAIN_ID}, contract ${PACKS}, chain length ${N}`);
  for (;;) {
    try {
      const more = await tick();
      if (ONCE && !more) break;
      if (!more) await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.error('  error:', e.message);
      if (ONCE) process.exit(1);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
})();
