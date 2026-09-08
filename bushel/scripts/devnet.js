#!/usr/bin/env node
'use strict';

/**
 * Manna — devnet.js ("the Wilderness")
 *
 * Manna has no foundry, no hardhat, and (until now) nowhere to actually run: scripts/chain.js
 * signs raw transactions by hand, scripts/test.js runs the contracts inside @ethereumjs/vm, and
 * the site talks to whatever RPC_URL config/addresses.json points at. This is the missing piece —
 * a real JSON-RPC chain, backed by the same @ethereumjs/vm already vendored for the test suite,
 * that scripts/*.js and a browser can both talk to. Deploy, dawn(), sunday(), the site's feeds —
 * everything that needs "an EVM at the other end of an RPC URL" now has one, on this machine,
 * for free, with no state that outlives the process.
 *
 *   node scripts/devnet.js [--port 8545] [--chain-id 4663] [--fund 0xADDR ...]
 *
 * Then, in another shell:
 *   RPC_URL=http://127.0.0.1:8545 CHAIN_ID=4663 PRIVATE_KEY=<one of the dev keys below> \
 *     node scripts/deploy.js
 *
 * WHAT THIS IS NOT: geth. There is no mempool (every accepted transaction is executed and sealed
 * into its own block immediately — see "Auto-mine" below), no peer-to-peer anything, no disk
 * persistence (state lives in @ethereumjs/vm's in-memory trie and evaporates when the process
 * exits), and every read (eth_call, eth_getBalance, eth_getCode, eth_getStorageAt,
 * eth_estimateGas, ...) always answers against the CURRENT head — the blockTag argument is
 * accepted for compatibility but otherwise ignored, since no historical state snapshots are kept.
 * What it is: enough of the JSON-RPC surface, correctly enough, that this repo's own scripts and
 * the site's browser code cannot tell the difference from a real chain.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !! The private keys this file hands out (DEV_KEY_SEEDS below) are hardcoded, deterministic,  !!
 * !! and printed to stdout on every run. That is the point — they are for THIS PROCESS, on     !!
 * !! YOUR machine, so scripts and tests can reuse the same funded accounts every time. They     !!
 * !! secure nothing. Never fund them on a real network; anyone who has read this source file    !!
 * !! (which is to say: anyone) can spend from them.                                             !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * How a transaction is actually run (and why): @ethereumjs/vm's own transaction runner
 * (`vm.runTx`) wants a signed transaction object from `@ethereumjs/tx`, which is not a
 * dependency this project declares (see scripts/test.js's header and package.json — only
 * @ethereumjs/vm, common, block and util are). So, exactly like scripts/test.js's own `call()`
 * helper, transactions here run through the lower-level `vm.evm.runCall` instead, with the
 * handful of things that only the transaction layer normally does — nonce checking, the gas
 * payment, EIP-1559 fee math, the receipt — done by hand below. Two things `runCall` already
 * does correctly on its own, confirmed by reading @ethereumjs/evm's source rather than assumed:
 * it increments the caller's nonce exactly once per top-level call whether or not it reverts, and
 * for a contract creation it computes the new address from the nonce as it stood *before* that
 * increment — i.e. the real protocol rule — so nothing here touches the nonce directly. RLP
 * encode/decode is hand-rolled too, the same way scripts/chain.js hand-rolls RLP for signing: a
 * transaction handed to eth_sendRawTransaction has to be decoded, which chain.js never needed.
 *
 * Auto-mine: there is no separate "submit then mine" step. eth_sendRawTransaction and
 * eth_sendTransaction execute the transaction and seal it into a new block before returning its
 * hash. evm_mine, evm_increaseTime and evm_setNextBlockTimestamp (non-standard, Hardhat/Ganache-
 * shaped) exist because Manna's calendar (dawn at noon UTC, no dial turns on Sunday, a 49-day
 * Jubilee) is otherwise impossible to reach from a chain that only advances one second at a time.
 */

const http = require('node:http');
const { VM, Bloom } = require('@ethereumjs/vm');
const { Common, Hardfork } = require('@ethereumjs/common');
const { Block } = require('@ethereumjs/block');
const { Address, Account, hexToBytes } = require('@ethereumjs/util');
const secp = require('./secp256k1');
const { keccak256 } = require('./keccak');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flagValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? undefined : process.argv[i + 1];
}
function flagValues(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}

const PORT = parseInt(flagValue('port') || '8545', 10);
const CHAIN_ID = BigInt(flagValue('chain-id') || '4663');
const FUND_ADDRESSES = flagValues('fund');

// ---------------------------------------------------------------------------
// Hex / byte helpers. Quantities are minimal (no leading zero digits, "0x0" for zero); data is
// full-byte hex, "0x" for empty. Both directions get exercised constantly below, so they earn
// their own names rather than being inlined everywhere.
// ---------------------------------------------------------------------------

const strip = (h) => String(h).replace(/^0x/i, '');
const bufFromHex = (h) => Buffer.from(strip(h == null ? '0x' : h), 'hex');
const hexFromBuf = (b) => '0x' + Buffer.from(b).toString('hex');
const hexQty = (v) => '0x' + (typeof v === 'bigint' ? v : BigInt(v)).toString(16);
const bufToBig = (b) => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n);
const bufToAddr = (b) => (b.length === 0 ? null : '0x' + Buffer.from(b).toString('hex'));
const addrOf = (hex) => new Address(hexToBytes(hex));
const ZERO_HASH = '0x' + '00'.repeat(32);
const ZERO_ADDRESS = '0x' + '00'.repeat(20);

function padLeft32(buf) {
  const b = Buffer.from(buf);
  if (b.length >= 32) return b.subarray(b.length - 32);
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

// ---------------------------------------------------------------------------
// RLP — hand-rolled in both directions (chain.js only ever needed to encode, for signing; a raw
// transaction handed to eth_sendRawTransaction has to be decoded too). Byte-string / list only,
// which is all Ethereum's own encodings ever nest.
// ---------------------------------------------------------------------------

function rlpLenPrefix(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const hex = len.toString(16);
  const lenBytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLenPrefix(b.length, 0x80), b]);
}
function rlpList(items) {
  const body = Buffer.concat(items);
  return Buffer.concat([rlpLenPrefix(body.length, 0xc0), body]);
}
function rlpEncode(item) {
  return Array.isArray(item) ? rlpList(item.map(rlpEncode)) : rlpBytes(item);
}
function bigToMinimalBuf(v) {
  if (v === 0n) return Buffer.alloc(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}
const rlpInt = (v) => rlpBytes(bigToMinimalBuf(BigInt(v)));

/** Decodes one RLP item at `offset`. A "string" item comes back as a Buffer, a "list" item as an
 *  array of such values (nested arbitrarily) — exactly the shape rlpEncode's input takes, so
 *  round-tripping a value through rlpEncode -> rlpDecode reproduces it. No streaming, no lengths
 *  past what fits a JS number: plenty for a transaction, which is all this ever decodes. */
function rlpDecodeAt(buf, offset) {
  const prefix = buf[offset];
  if (prefix < 0x80) return { value: buf.subarray(offset, offset + 1), next: offset + 1 };
  if (prefix < 0xb8) {
    const len = prefix - 0x80;
    return { value: buf.subarray(offset + 1, offset + 1 + len), next: offset + 1 + len };
  }
  if (prefix < 0xc0) {
    const lenOfLen = prefix - 0xb7;
    const len = Number(bufToBig(buf.subarray(offset + 1, offset + 1 + lenOfLen)));
    const start = offset + 1 + lenOfLen;
    return { value: buf.subarray(start, start + len), next: start + len };
  }
  if (prefix < 0xf8) return rlpDecodeList(buf, offset + 1, offset + 1 + (prefix - 0xc0));
  const lenOfLen = prefix - 0xf7;
  const len = Number(bufToBig(buf.subarray(offset + 1, offset + 1 + lenOfLen)));
  const start = offset + 1 + lenOfLen;
  return rlpDecodeList(buf, start, start + len);
}
function rlpDecodeList(buf, start, end) {
  const items = [];
  let pos = start;
  while (pos < end) {
    const { value, next } = rlpDecodeAt(buf, pos);
    items.push(value);
    pos = next;
  }
  return { value: items, next: end };
}
function rlpDecode(buf) {
  const { value, next } = rlpDecodeAt(buf, 0);
  if (next !== buf.length) throw new Error('rlp: trailing bytes after the top-level item');
  return value;
}

// ---------------------------------------------------------------------------
// Dev accounts — a handful of FIXED, DETERMINISTIC keys (see the warning banner in the header
// above and printed at startup). Derived from plain seed strings via keccak256 rather than typed
// in as literal hex, so there is no chance of a transcription slip putting an address on stdout
// that the accompanying "private key" doesn't actually open — the derivation IS the check.
// ---------------------------------------------------------------------------

const DEV_KEY_SEEDS = [
  'manna devnet key 0', 'manna devnet key 1', 'manna devnet key 2',
  'manna devnet key 3', 'manna devnet key 4', 'manna devnet key 5',
];
const DEV_ACCOUNTS = DEV_KEY_SEEDS.map((seed) => {
  const d = (bufToBig(keccak256(Buffer.from(seed, 'utf8'))) % (secp.N - 1n)) + 1n;
  const privateKey = '0x' + d.toString(16).padStart(64, '0');
  return { privateKey, address: secp.addressOf(privateKey).toLowerCase() };
});
const DEV_KEY_OF = new Map(DEV_ACCOUNTS.map((a) => [a.address, a.privateKey]));

const ETH = 10n ** 18n;
const DEV_BALANCE = 10000n * ETH;

// ---------------------------------------------------------------------------
// Chain parameters and clock. baseFeePerGas is fixed rather than adjusted per EIP-1559's own
// formula — this is a devnet with one transaction per block; a "real" base-fee market has nothing
// to track. evm_increaseTime/evm_setNextBlockTimestamp bend the clock for Manna's calendar logic
// (dawn, Sunday, Jubilee); nextTimestamp() below is where that bend actually gets applied.
// ---------------------------------------------------------------------------

const BLOCK_GAS_LIMIT = 30_000_000n;
const BASE_FEE = 1_000_000_000n; // 1 gwei, fixed
const DEFAULT_PRIORITY_FEE = 1_000_000_000n; // 1 gwei, fixed
const COINBASE = new Address(hexToBytes(ZERO_ADDRESS));

let clock = BigInt(Math.floor(Date.now() / 1000));
let pendingTimestamp = null; // set once by evm_setNextBlockTimestamp, consumed by the next block
let increaseOffset = 0n; // accumulated by evm_increaseTime, consumed by the next block

/** The timestamp the NEXT block will carry, strictly after the current head's. Consumes any
 *  pending evm_setNextBlockTimestamp override or evm_increaseTime offset exactly once. */
function nextTimestamp() {
  let ts;
  if (pendingTimestamp !== null) {
    ts = pendingTimestamp;
    pendingTimestamp = null;
  } else {
    ts = clock + 1n + increaseOffset;
    increaseOffset = 0n;
  }
  if (ts <= clock) ts = clock + 1n; // time never runs backwards or stands still
  clock = ts;
  return ts;
}

// ---------------------------------------------------------------------------
// The chain itself: one VM, one growing list of blocks, and the transactions/receipts/logs they
// contain. No persistence, no snapshots-per-block — every read answers against vm.stateManager's
// current trie, which IS "latest" (see the header's "WHAT THIS IS NOT").
// ---------------------------------------------------------------------------

const common = Common.custom({ chainId: CHAIN_ID }, { baseChain: 'mainnet', hardfork: Hardfork.Cancun });
let vm; // set in main()

let headNumber = 0n;
const blocksByNumber = new Map();
const blocksByHash = new Map();
const txsByHash = new Map();
const receiptsByHash = new Map();
const logsStore = []; // flat, in chain order; eth_getLogs filters it directly rather than a bloom scan

/** A simplified header hash: keccak256 of the fields that actually change block to block. Not a
 *  consensus-spec RLP header (no real transactions/receipts tries, no difficulty/mixHash/nonce —
 *  nothing here validates against those, see the grep of site/ and scripts/ this was checked
 *  against), just a unique, deterministic 32 bytes per block, good enough to chain parentHash ->
 *  hash and to answer the BLOCKHASH opcode. */
function computeBlockHash({ parentHash, number, timestamp, stateRoot, gasUsed, txHash }) {
  const fields = [
    bufFromHex(parentHash), bigToMinimalBuf(number), bigToMinimalBuf(timestamp),
    bufFromHex(stateRoot), bigToMinimalBuf(gasUsed), bufFromHex(txHash || ZERO_HASH),
  ];
  return hexFromBuf(keccak256(rlpEncode(fields)));
}

const EMPTY_BLOOM_HEX = '0x' + '00'.repeat(256);
const EMPTY_LIST_HASH = hexFromBuf(keccak256(rlpList([])));

async function currentStateRoot() {
  return hexFromBuf(await vm.stateManager.getStateRoot());
}

async function getAccount(addressHex) {
  const a = await vm.stateManager.getAccount(addrOf(addressHex));
  return a || new Account(0n, 0n);
}
async function putAccount(addressHex, account) {
  await vm.stateManager.putAccount(addrOf(addressHex), account);
}

// ---------------------------------------------------------------------------
// JSON-RPC error shape: `code`/`message` become the standard error object; `data`, when present,
// carries revert bytes so a caller (chain.js's `revertName`-style decoders, or a contract's own
// custom-error ABI) can decode exactly what the contract reverted with — requirement is that a
// failed eth_call/eth_estimateGas surfaces this, not just "execution reverted".
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Best-effort human message for a revert: decodes the standard Error(string) selector so the
 *  common case ("insufficient balance", etc.) is legible; anything else (a custom error, a
 *  Panic(uint256), a bare revert()) just says so — its raw bytes are still in the error's `data`
 *  for the caller to decode itself, which is the part that actually matters. */
function revertMessage(returnValue) {
  const data = Buffer.from(returnValue || []);
  if (data.length >= 68 && data.subarray(0, 4).toString('hex') === '08c379a0') {
    try {
      const len = Number(bufToBig(data.subarray(36, 68)));
      return `execution reverted: ${data.subarray(68, 68 + len).toString('utf8')}`;
    } catch (e) {
      // fall through to the generic message below
    }
  }
  return 'execution reverted';
}

// ---------------------------------------------------------------------------
// Intrinsic gas: TX_BASE (21000) + 4/16 gas per zero/non-zero calldata byte +, for a contract
// creation, the 32000 creation fee and EIP-3860's 2-gas-per-32-byte-word of initcode. No access
// lists (chain.js never sends one — see its send(), which always RLPs an empty list) and no
// EIP-7702 authorization lists, both intentionally out of scope; see the report for why.
// ---------------------------------------------------------------------------

function intrinsicGas(to, data) {
  let g = 21000n;
  for (const byte of data) g += byte === 0 ? 4n : 16n;
  if (to === null) {
    g += 32000n;
    g += BigInt(Math.ceil(data.length / 32)) * 2n;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Transaction decoding — legacy (type 0, with or without EIP-155) and EIP-1559 (type 2), the two
// shapes scripts/chain.js's send() and a browser wallet's eth_sendTransaction can produce between
// them. EIP-2930 (type 1) is deliberately not handled: nothing in this repo or a stock wallet
// emits it, and silently mis-parsing a type byte we don't understand is worse than refusing it.
// ---------------------------------------------------------------------------

function decodeRawTx(rawHex) {
  const raw = bufFromHex(rawHex);
  if (raw.length === 0) throw new RpcError(-32602, 'empty raw transaction');
  const hash = hexFromBuf(keccak256(raw));
  const typeByte = raw[0];

  if (typeByte >= 0xc0) {
    // Legacy: [nonce, gasPrice, gasLimit, to, value, data, v, r, s].
    const [nonceB, gasPriceB, gasLimitB, toB, valueB, dataB, vB, rB, sB] = rlpDecode(raw);
    const v = bufToBig(vB);
    let chainId = null;
    let recid;
    if (v === 27n || v === 28n) {
      recid = Number(v - 27n);
    } else {
      chainId = (v - 35n) / 2n;
      recid = Number(v - 35n - chainId * 2n);
    }
    const signFields = chainId === null
      ? [nonceB, gasPriceB, gasLimitB, toB, valueB, dataB]
      : [nonceB, gasPriceB, gasLimitB, toB, valueB, dataB, bigToMinimalBuf(chainId), Buffer.alloc(0), Buffer.alloc(0)];
    const digest = keccak256(rlpEncode(signFields));
    const from = secp.recover(digest, recid + 27, hexFromBuf(rB), hexFromBuf(sB));
    if (!from) throw new RpcError(-32000, 'could not recover a sender — bad signature');
    return {
      type: 0, chainId, from: from.toLowerCase(), nonce: bufToBig(nonceB), gasLimit: bufToBig(gasLimitB),
      maxFeePerGas: bufToBig(gasPriceB), maxPriorityFeePerGas: bufToBig(gasPriceB),
      to: bufToAddr(toB), value: bufToBig(valueB), data: Buffer.from(dataB), raw, hash,
      v: hexQty(v), r: hexFromBuf(rB), s: hexFromBuf(sB),
    };
  }

  if (typeByte === 0x02) {
    const [chainIdB, nonceB, priorityB, maxFeeB, gasLimitB, toB, valueB, dataB, accessListB, yParityB, rB, sB] =
      rlpDecode(raw.subarray(1));
    const chainId = bufToBig(chainIdB);
    const signed = Buffer.concat([Buffer.from([2]), rlpEncode([chainIdB, nonceB, priorityB, maxFeeB, gasLimitB, toB, valueB, dataB, accessListB])]);
    const digest = keccak256(signed);
    const recid = Number(bufToBig(yParityB));
    const from = secp.recover(digest, recid + 27, hexFromBuf(rB), hexFromBuf(sB));
    if (!from) throw new RpcError(-32000, 'could not recover a sender — bad signature');
    return {
      type: 2, chainId, from: from.toLowerCase(), nonce: bufToBig(nonceB), gasLimit: bufToBig(gasLimitB),
      maxPriorityFeePerGas: bufToBig(priorityB), maxFeePerGas: bufToBig(maxFeeB),
      to: bufToAddr(toB), value: bufToBig(valueB), data: Buffer.from(dataB), raw, hash,
      v: hexQty(BigInt(recid)), r: hexFromBuf(rB), s: hexFromBuf(sB),
    };
  }

  throw new RpcError(-32602, `unsupported transaction type 0x${typeByte.toString(16)} — this devnet speaks legacy and EIP-1559 (type 2) only`);
}

/** Builds and signs an EIP-1559 transaction for one of DEV_ACCOUNTS, then hands it straight to
 *  decodeRawTx — the exact bytes an eth_sendRawTransaction caller would have sent — so
 *  eth_sendTransaction and eth_sendRawTransaction run through one identical path from here on. */
function signType2(privateKey, f) {
  const fields = [
    rlpInt(f.chainId), rlpInt(f.nonce), rlpInt(f.maxPriorityFeePerGas), rlpInt(f.maxFeePerGas), rlpInt(f.gasLimit),
    f.to ? rlpBytes(bufFromHex(f.to)) : rlpBytes(Buffer.alloc(0)),
    rlpInt(f.value), rlpBytes(f.data), rlpList([]),
  ];
  const unsigned = Buffer.concat([Buffer.from([2]), rlpList(fields)]);
  const sig = secp.sign(privateKey, keccak256(unsigned));
  const signed = Buffer.concat([
    Buffer.from([2]),
    rlpList([...fields, rlpInt(BigInt(sig.v - 27)), rlpBytes(bufFromHex(sig.r)), rlpBytes(bufFromHex(sig.s))]),
  ]);
  return hexFromBuf(signed);
}

// ---------------------------------------------------------------------------
// Applying a transaction: validate, pay for gas, run it, refund unused gas, seal a block. The gas
// payment/refund pair is the one piece of real transaction processing vm.runTx would otherwise do
// (see the file header for why it's done by hand); the nonce increment and the value transfer are
// vm.evm.runCall's own job and are not touched here.
// ---------------------------------------------------------------------------

async function applyTransaction(tx) {
  if (tx.chainId !== null && tx.chainId !== CHAIN_ID) {
    throw new RpcError(-32000, `invalid chain id ${tx.chainId} — this devnet is chain ${CHAIN_ID}`);
  }
  const from = await getAccount(tx.from);
  if (tx.nonce !== from.nonce) {
    throw new RpcError(-32000, `nonce too ${tx.nonce < from.nonce ? 'low' : 'high'}: account ${tx.from} is at nonce ${from.nonce}, tx has ${tx.nonce}`);
  }
  if (tx.gasLimit > BLOCK_GAS_LIMIT) {
    throw new RpcError(-32000, `gas limit ${tx.gasLimit} exceeds the block gas limit ${BLOCK_GAS_LIMIT}`);
  }
  if (tx.maxFeePerGas < BASE_FEE) {
    throw new RpcError(-32000, `max fee per gas (${tx.maxFeePerGas}) is less than the block's base fee (${BASE_FEE})`);
  }
  const iGas = intrinsicGas(tx.to, tx.data);
  if (tx.gasLimit < iGas) {
    throw new RpcError(-32000, `intrinsic gas too low: gas limit ${tx.gasLimit}, intrinsic gas required ${iGas}`);
  }
  const upfrontCost = tx.value + tx.gasLimit * tx.maxFeePerGas;
  if (from.balance < upfrontCost) {
    throw new RpcError(-32000, `insufficient funds for gas * price + value: balance ${from.balance}, need ${upfrontCost}`);
  }

  const priority = tx.maxPriorityFeePerGas < tx.maxFeePerGas - BASE_FEE ? tx.maxPriorityFeePerGas : tx.maxFeePerGas - BASE_FEE;
  const gasPrice = BASE_FEE + priority;

  // Pay for gas up front, at the full gas limit; the unused portion is refunded once we know how
  // much execution actually cost. `value` is deliberately left alone here — vm.evm.runCall moves
  // it itself as part of running the call, and only if the call doesn't revert.
  from.balance -= tx.gasLimit * gasPrice;
  await putAccount(tx.from, from);

  const timestamp = nextTimestamp();
  const pendingNumber = headNumber + 1n;
  const parent = blocksByNumber.get(headNumber);
  const block = Block.fromBlockData(
    { header: { number: pendingNumber, timestamp, gasLimit: BLOCK_GAS_LIMIT, baseFeePerGas: BASE_FEE, coinbase: COINBASE } },
    { common, skipConsensusFormatValidation: true }
  );

  const res = await vm.evm.runCall({
    caller: addrOf(tx.from),
    origin: addrOf(tx.from),
    to: tx.to ? addrOf(tx.to) : undefined,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit - iGas,
    block,
  });

  const reverted = !!res.execResult.exceptionError;
  const executionGasUsed = res.execResult.executionGasUsed;
  const refundCap = executionGasUsed / 5n; // EIP-3529, in effect since London
  const refund = res.execResult.gasRefund < refundCap ? res.execResult.gasRefund : refundCap;
  let gasUsed = iGas + executionGasUsed - refund;
  if (gasUsed > tx.gasLimit) gasUsed = tx.gasLimit;

  // Refund unused gas. Re-read the account rather than reusing `from` from above: the call may
  // have paid the sender itself (a self-send, or a contract sending back change), and blindly
  // overwriting with the pre-execution snapshot would erase that.
  const after = await getAccount(tx.from);
  after.balance += (tx.gasLimit - gasUsed) * gasPrice;
  await putAccount(tx.from, after);

  const blockHashPlaceholder = null; // filled in once computeBlockHash has run, below
  const logs = reverted
    ? []
    : (res.execResult.logs || []).map(([address, topics, data], i) => ({
        address: hexFromBuf(address).toLowerCase(),
        topics: topics.map(hexFromBuf),
        data: hexFromBuf(data),
        blockNumber: hexQty(pendingNumber),
        blockHash: blockHashPlaceholder,
        transactionHash: tx.hash,
        transactionIndex: '0x0',
        logIndex: hexQty(BigInt(i)),
        removed: false,
      }));

  const bloom = new Bloom();
  for (const l of logs) {
    bloom.add(bufFromHex(l.address));
    for (const t of l.topics) bloom.add(bufFromHex(t));
  }
  const logsBloomHex = hexFromBuf(bloom.bitvector);

  const stateRoot = await currentStateRoot();
  const blockHash = computeBlockHash({ parentHash: parent.hash, number: pendingNumber, timestamp, stateRoot, gasUsed, txHash: tx.hash });
  for (const l of logs) l.blockHash = blockHash;

  const contractAddress = !tx.to && !reverted && res.createdAddress ? hexFromBuf(res.createdAddress.bytes).toLowerCase() : null;

  const receipt = {
    transactionHash: tx.hash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: hexQty(pendingNumber),
    from: tx.from,
    to: tx.to ? tx.to.toLowerCase() : null,
    cumulativeGasUsed: hexQty(gasUsed),
    gasUsed: hexQty(gasUsed),
    effectiveGasPrice: hexQty(gasPrice),
    contractAddress,
    logs,
    logsBloom: logsBloomHex,
    status: reverted ? '0x0' : '0x1',
    type: hexQty(BigInt(tx.type)),
  };

  const block_ = {
    number: pendingNumber, hash: blockHash, parentHash: parent.hash, timestamp, gasLimit: BLOCK_GAS_LIMIT,
    gasUsed, baseFeePerGas: BASE_FEE, stateRoot, miner: ZERO_ADDRESS, transactions: [tx.hash], logsBloom: logsBloomHex,
  };
  blocksByNumber.set(pendingNumber, block_);
  blocksByHash.set(blockHash.toLowerCase(), block_);
  headNumber = pendingNumber;

  txsByHash.set(tx.hash.toLowerCase(), {
    ...tx, blockHash, blockNumber: pendingNumber, transactionIndex: 0,
    returnData: hexFromBuf(res.execResult.returnValue),
    revertReason: reverted ? revertMessage(res.execResult.returnValue) : null,
  });
  receiptsByHash.set(tx.hash.toLowerCase(), receipt);
  for (const l of logs) logsStore.push(l);

  return tx.hash;
}

/** Mines an empty block — no transaction, just time and a block number moving forward. The only
 *  way to advance the chain without also sending a transaction, which evm_increaseTime alone
 *  cannot do (it only sets a pending offset; something has to seal a block to apply it). */
async function mineEmptyBlock(explicitTimestamp) {
  if (explicitTimestamp !== undefined) pendingTimestamp = BigInt(explicitTimestamp);
  const timestamp = nextTimestamp();
  const pendingNumber = headNumber + 1n;
  const parent = blocksByNumber.get(headNumber);
  const stateRoot = await currentStateRoot();
  const blockHash = computeBlockHash({ parentHash: parent.hash, number: pendingNumber, timestamp, stateRoot, gasUsed: 0n, txHash: null });
  const block = {
    number: pendingNumber, hash: blockHash, parentHash: parent.hash, timestamp, gasLimit: BLOCK_GAS_LIMIT,
    gasUsed: 0n, baseFeePerGas: BASE_FEE, stateRoot, miner: ZERO_ADDRESS, transactions: [], logsBloom: EMPTY_BLOOM_HEX,
  };
  blocksByNumber.set(pendingNumber, block);
  blocksByHash.set(blockHash.toLowerCase(), block);
  headNumber = pendingNumber;
  return blockHash;
}

// ---------------------------------------------------------------------------
// Read-only execution (eth_call / eth_estimateGas): runs inside a stateManager checkpoint that is
// ALWAYS reverted afterwards, success or failure, so a "call" — even one that calls into a
// state-changing function, the way a dApp's callStatic/simulate pattern does — can never leak
// into the chain's real state. vm.evm.runCall's automatic nonce increment (see the file header)
// is caught by this same checkpoint and discarded right along with everything else.
// ---------------------------------------------------------------------------

async function runReadOnlyCall({ from, to, data, value, gasLimit }) {
  await vm.stateManager.checkpoint();
  try {
    const head = blocksByNumber.get(headNumber);
    const block = Block.fromBlockData(
      { header: { number: headNumber, timestamp: head.timestamp, gasLimit: BLOCK_GAS_LIMIT, baseFeePerGas: BASE_FEE, coinbase: COINBASE } },
      { common, skipConsensusFormatValidation: true }
    );
    return await vm.evm.runCall({
      caller: addrOf(from),
      origin: addrOf(from),
      to: to ? addrOf(to) : undefined,
      data,
      value,
      gasLimit,
      block,
    });
  } finally {
    await vm.stateManager.revert();
  }
}

function normalizeCallObject(callObj) {
  return {
    from: (callObj.from || DEV_ACCOUNTS[0].address).toLowerCase(),
    to: callObj.to && callObj.to !== '0x' ? callObj.to.toLowerCase() : null,
    data: bufFromHex(callObj.data || callObj.input || '0x'),
    value: callObj.value ? BigInt(callObj.value) : 0n,
    gas: callObj.gas !== undefined ? BigInt(callObj.gas) : undefined,
  };
}

async function handleCall(params) {
  const c = normalizeCallObject(params[0] || {});
  const res = await runReadOnlyCall({ from: c.from, to: c.to, data: c.data, value: c.value, gasLimit: c.gas ?? BLOCK_GAS_LIMIT });
  if (res.execResult.exceptionError) {
    throw new RpcError(3, revertMessage(res.execResult.returnValue), hexFromBuf(res.execResult.returnValue));
  }
  return hexFromBuf(res.execResult.returnValue);
}

async function handleEstimateGas(params) {
  const c = normalizeCallObject(params[0] || {});
  const cap = c.gas ?? BLOCK_GAS_LIMIT;
  const iGas = intrinsicGas(c.to, c.data);
  const res = await runReadOnlyCall({ from: c.from, to: c.to, data: c.data, value: c.value, gasLimit: cap > iGas ? cap - iGas : 0n });
  if (res.execResult.exceptionError) {
    throw new RpcError(3, revertMessage(res.execResult.returnValue), hexFromBuf(res.execResult.returnValue));
  }
  const refundCap = res.execResult.executionGasUsed / 5n;
  const refund = res.execResult.gasRefund < refundCap ? res.execResult.gasRefund : refundCap;
  const used = iGas + res.execResult.executionGasUsed - refund;

  // What a call consumes when it is given plenty of gas is not what it needs to survive being
  // given exactly that much: EIP-150 hands a child call at most 63/64 of what is left, so a
  // transaction can starve a subcall and revert on a limit comfortably above its own gasUsed.
  // Manna.enter() does exactly that — measured 186,995 gas, but reverts at a 206,694 limit. So
  // do what a real node does and binary-search for the smallest limit that actually succeeds,
  // rather than padding the observed figure and hoping.
  const succeedsAt = async (total) => {
    if (total <= iGas) return false;
    const r = await runReadOnlyCall({ from: c.from, to: c.to, data: c.data, value: c.value, gasLimit: total - iGas });
    return !r.execResult.exceptionError;
  };
  if (await succeedsAt(used)) return hexQty(used);
  let lo = used, hi = cap;
  for (let probe = used * 2n; probe < cap; probe *= 2n) {   // grow until it survives, then bisect
    if (await succeedsAt(probe)) { hi = probe; break; }
    lo = probe;
  }
  while (hi - lo > lo / 64n + 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await succeedsAt(mid)) hi = mid; else lo = mid;
  }
  return hexQty(hi > cap ? cap : hi);
}

// ---------------------------------------------------------------------------
// eth_getLogs — fromBlock/toBlock (numbers, 'earliest', 'latest'/'pending'), address (string or
// array), topics (positional; null/absent = wildcard, an array at a position = OR of alternatives).
// ---------------------------------------------------------------------------

function resolveBlockTag(tag) {
  if (tag === undefined || tag === null || tag === 'latest' || tag === 'pending') return headNumber;
  if (tag === 'earliest') return 0n;
  return BigInt(tag);
}

function matchesAddress(logAddr, filterAddr) {
  if (!filterAddr) return true;
  const list = Array.isArray(filterAddr) ? filterAddr : [filterAddr];
  return list.some((a) => String(a).toLowerCase() === logAddr);
}

function matchesTopics(logTopics, filterTopics) {
  if (!filterTopics) return true;
  for (let i = 0; i < filterTopics.length; i++) {
    const want = filterTopics[i];
    if (want === null || want === undefined) continue;
    const got = logTopics[i];
    const alts = Array.isArray(want) ? want : [want];
    if (!got || !alts.some((t) => t !== null && String(t).toLowerCase() === got.toLowerCase())) return false;
  }
  return true;
}

async function handleGetLogs(params) {
  const filter = params[0] || {};
  let from, to;
  if (filter.blockHash) {
    const b = blocksByHash.get(String(filter.blockHash).toLowerCase());
    if (!b) throw new RpcError(-32000, `unknown block hash ${filter.blockHash}`);
    from = to = b.number;
  } else {
    from = resolveBlockTag(filter.fromBlock);
    to = resolveBlockTag(filter.toBlock);
  }
  return logsStore.filter((l) => {
    const bn = BigInt(l.blockNumber);
    if (bn < from || bn > to) return false;
    if (!matchesAddress(l.address, filter.address)) return false;
    return matchesTopics(l.topics, filter.topics);
  });
}

// ---------------------------------------------------------------------------
// RPC-shaped views of a block / transaction.
// ---------------------------------------------------------------------------

function txToRpc(t) {
  return {
    hash: t.hash,
    nonce: hexQty(t.nonce),
    blockHash: t.blockHash,
    blockNumber: hexQty(t.blockNumber),
    transactionIndex: hexQty(BigInt(t.transactionIndex)),
    from: t.from,
    to: t.to ? t.to.toLowerCase() : null,
    value: hexQty(t.value),
    gas: hexQty(t.gasLimit),
    gasPrice: hexQty(t.maxFeePerGas),
    maxFeePerGas: hexQty(t.maxFeePerGas),
    maxPriorityFeePerGas: hexQty(t.maxPriorityFeePerGas),
    input: hexFromBuf(t.data),
    v: t.v, r: t.r, s: t.s,
    type: hexQty(BigInt(t.type)),
    chainId: hexQty(CHAIN_ID),
    accessList: [],
  };
}

function blockToRpc(b, fullTx) {
  return {
    number: hexQty(b.number),
    hash: b.hash,
    parentHash: b.parentHash,
    nonce: '0x0000000000000000',
    sha3Uncles: EMPTY_LIST_HASH,
    logsBloom: b.logsBloom,
    transactionsRoot: b.transactions.length ? keccak256Of(b.transactions[0]) : EMPTY_LIST_HASH,
    stateRoot: b.stateRoot,
    receiptsRoot: b.transactions.length ? keccak256Of(b.transactions[0] + 'receipt') : EMPTY_LIST_HASH,
    miner: b.miner,
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x0',
    gasLimit: hexQty(b.gasLimit),
    gasUsed: hexQty(b.gasUsed),
    timestamp: hexQty(b.timestamp),
    baseFeePerGas: hexQty(b.baseFeePerGas),
    transactions: fullTx ? b.transactions.map((h) => txToRpc(txsByHash.get(h.toLowerCase()))) : b.transactions,
    uncles: [],
  };
}
const keccak256Of = (s) => hexFromBuf(keccak256(Buffer.from(s, 'utf8')));

// ---------------------------------------------------------------------------
// Method table.
// ---------------------------------------------------------------------------

const methods = {
  web3_clientVersion: async () => `Manna-devnet/0.1.0/@ethereumjs-vm-8.1.1/node-${process.version}`,
  net_version: async () => CHAIN_ID.toString(),
  eth_chainId: async () => hexQty(CHAIN_ID),
  eth_blockNumber: async () => hexQty(headNumber),

  eth_getBlockByNumber: async ([tag, fullTx]) => {
    const b = blocksByNumber.get(resolveBlockTag(tag));
    return b ? blockToRpc(b, !!fullTx) : null;
  },
  eth_getBlockByHash: async ([hash, fullTx]) => {
    const b = blocksByHash.get(String(hash).toLowerCase());
    return b ? blockToRpc(b, !!fullTx) : null;
  },

  eth_getBalance: async ([address]) => hexQty((await getAccount(address)).balance),
  eth_getTransactionCount: async ([address]) => hexQty((await getAccount(address)).nonce),
  eth_getCode: async ([address]) => hexFromBuf(await vm.stateManager.getContractCode(addrOf(address))),
  eth_getStorageAt: async ([address, slot]) => {
    const acc = await vm.stateManager.getAccount(addrOf(address));
    if (!acc) return ZERO_HASH; // getContractStorage throws on an account the trie has never seen
    const value = await vm.stateManager.getContractStorage(addrOf(address), padLeft32(bufFromHex(slot)));
    return hexFromBuf(padLeft32(value));
  },

  eth_gasPrice: async () => hexQty(BASE_FEE + DEFAULT_PRIORITY_FEE),
  eth_maxPriorityFeePerGas: async () => hexQty(DEFAULT_PRIORITY_FEE),
  eth_feeHistory: async ([blockCountRaw, newestTag, rewardPercentiles]) => {
    const newest = resolveBlockTag(newestTag);
    const count = BigInt(blockCountRaw);
    const oldest = newest + 1n > count ? newest + 1n - count : 0n;
    const baseFeePerGas = [];
    const gasUsedRatio = [];
    for (let n = oldest; n <= newest; n++) {
      const b = blocksByNumber.get(n);
      baseFeePerGas.push(hexQty(BASE_FEE));
      gasUsedRatio.push(b ? Number(b.gasUsed) / Number(BLOCK_GAS_LIMIT) : 0);
    }
    baseFeePerGas.push(hexQty(BASE_FEE)); // the (blockCount+1)th entry: this constant chain's "next" base fee
    const result = { oldestBlock: hexQty(oldest), baseFeePerGas, gasUsedRatio };
    if (rewardPercentiles && rewardPercentiles.length) {
      result.reward = gasUsedRatio.map(() => rewardPercentiles.map(() => hexQty(DEFAULT_PRIORITY_FEE)));
    }
    return result;
  },

  eth_estimateGas: async (params) => handleEstimateGas(params),
  eth_call: async (params) => handleCall(params),

  eth_sendRawTransaction: async ([raw]) => applyTransaction(decodeRawTx(raw)),
  eth_sendTransaction: async ([callObj]) => {
    const fromLower = String(callObj.from || '').toLowerCase();
    const privateKey = DEV_KEY_OF.get(fromLower);
    if (!privateKey) {
      throw new RpcError(-32000, `unknown account ${callObj.from} — this devnet can only sign for its own dev accounts (see eth_accounts)`);
    }
    const nonce = callObj.nonce !== undefined ? BigInt(callObj.nonce) : (await getAccount(fromLower)).nonce;
    const to = callObj.to && callObj.to !== '0x' ? callObj.to : null;
    const data = bufFromHex(callObj.data || callObj.input || '0x');
    const value = callObj.value ? BigInt(callObj.value) : 0n;
    const priority = callObj.maxPriorityFeePerGas !== undefined ? BigInt(callObj.maxPriorityFeePerGas) : DEFAULT_PRIORITY_FEE;
    const maxFee = callObj.maxFeePerGas !== undefined
      ? BigInt(callObj.maxFeePerGas)
      : callObj.gasPrice !== undefined ? BigInt(callObj.gasPrice) : BASE_FEE * 2n + priority;
    let gasLimit = callObj.gas !== undefined ? BigInt(callObj.gas) : undefined;
    if (gasLimit === undefined) {
      // The estimate above is the minimum that works against the head as it stands now; a wallet
      // pads it, because the state can move between the estimate and the block this lands in.
      const est = BigInt(await handleEstimateGas([{ ...callObj, from: fromLower, to }]));
      gasLimit = est + est / 4n;
      if (gasLimit > BLOCK_GAS_LIMIT) gasLimit = BLOCK_GAS_LIMIT;
    }
    const raw = signType2(privateKey, { chainId: CHAIN_ID, nonce, to, data, value, gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
    return applyTransaction(decodeRawTx(raw));
  },

  eth_getTransactionByHash: async ([hash]) => {
    const t = txsByHash.get(String(hash).toLowerCase());
    return t ? txToRpc(t) : null;
  },
  eth_getTransactionReceipt: async ([hash]) => receiptsByHash.get(String(hash).toLowerCase()) || null,
  eth_getLogs: async (params) => handleGetLogs(params),

  eth_accounts: async () => DEV_ACCOUNTS.map((a) => a.address),
  eth_requestAccounts: async () => DEV_ACCOUNTS.map((a) => a.address),

  // Non-standard (Hardhat/Ganache-shaped) time-travel helpers — see the file header.
  evm_mine: async (params) => mineEmptyBlock(params && params[0] !== undefined ? params[0] : undefined),
  evm_increaseTime: async ([seconds]) => {
    increaseOffset += BigInt(seconds);
    return increaseOffset.toString();
  },
  evm_setNextBlockTimestamp: async ([timestamp]) => {
    pendingTimestamp = BigInt(timestamp);
    return null;
  },
};

// ---------------------------------------------------------------------------
// HTTP + JSON-RPC. Every request (batch or single) is run through one FIFO queue so two
// overlapping HTTP connections can never interleave state-mutating calls — nonce checks and gas
// accounting above assume nothing else touches the VM mid-transaction.
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
function serialize(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(() => {}, () => {});
  return result;
}

async function handleOne(req) {
  const { id = null, method, params = [] } = req || {};
  try {
    const fn = methods[method];
    if (!fn) throw new RpcError(-32601, `method not found: ${method}`);
    const result = await fn(params);
    return { jsonrpc: '2.0', id, result: result === undefined ? null : result };
  } catch (e) {
    const error = { code: e.code || -32000, message: e.message || String(e) };
    if (e.data !== undefined) error.data = e.data;
    return { jsonrpc: '2.0', id, error };
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ manna: 'devnet', chainId: CHAIN_ID.toString(), blockNumber: hexQty(headNumber), accounts: DEV_ACCOUNTS.map((a) => a.address) }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    serialize(async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      const isBatch = Array.isArray(payload);
      const requests = isBatch ? payload : [payload];
      const results = [];
      for (const r of requests) results.push(await handleOne(r));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isBatch ? results : results[0]));
    }).catch((e) => {
      // handleOne already catches per-request errors; this only fires for something catastrophic
      // (e.g. res.end() itself throwing on a closed socket) and must not wedge the queue.
      try { res.end(); } catch (_e) { /* already gone */ }
    });
  });
});

// ---------------------------------------------------------------------------
// Startup.
// ---------------------------------------------------------------------------

async function main() {
  vm = await VM.create({ common });

  // Same trick as scripts/test.js: the real @ethereumjs/blockchain wants a fully-formed chain of
  // real blocks to answer BLOCKHASH; this chain's own block store already has real hashes, so
  // just hand those back instead of standing up the whole Blockchain machinery.
  const bc = vm.evm.blockchain || vm.blockchain;
  bc.getBlock = async (n) => {
    const num = typeof n === 'bigint' ? n : BigInt(n);
    const b = blocksByNumber.get(num);
    return { hash: () => hexToBytes(b ? b.hash : ZERO_HASH) };
  };

  for (const a of DEV_ACCOUNTS) await putAccount(a.address, new Account(0n, DEV_BALANCE));
  for (const addr of FUND_ADDRESSES) await putAccount(addr.toLowerCase(), new Account(0n, DEV_BALANCE));

  const genesisTimestamp = clock;
  const genesisStateRoot = await currentStateRoot();
  const genesisHash = computeBlockHash({ parentHash: ZERO_HASH, number: 0n, timestamp: genesisTimestamp, stateRoot: genesisStateRoot, gasUsed: 0n, txHash: null });
  const genesis = {
    number: 0n, hash: genesisHash, parentHash: ZERO_HASH, timestamp: genesisTimestamp, gasLimit: BLOCK_GAS_LIMIT,
    gasUsed: 0n, baseFeePerGas: BASE_FEE, stateRoot: genesisStateRoot, miner: ZERO_ADDRESS, transactions: [], logsBloom: EMPTY_BLOOM_HEX,
  };
  blocksByNumber.set(0n, genesis);
  blocksByHash.set(genesisHash.toLowerCase(), genesis);

  server.listen(PORT, '127.0.0.1', () => {
    console.log('Manna devnet — an in-memory @ethereumjs/vm chain for local development.\n');
    console.log(`  RPC URL  : http://127.0.0.1:${PORT}`);
    console.log(`  chain id : ${CHAIN_ID}`);
    console.log(`  genesis  : block 0, ${genesisHash}\n`);
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('!! DEV KEYS ONLY. Hardcoded, deterministic, printed on every run — for LOCAL     !!');
    console.log('!! use with this process alone. They secure nothing; never fund them for real.   !!');
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
    console.log('  privateKey                                                          address                                     balance');
    for (const a of DEV_ACCOUNTS) {
      console.log(`  ${a.privateKey}  ${secp.toChecksumAddress(a.address)}  ${DEV_BALANCE / ETH} ETH`);
    }
    if (FUND_ADDRESSES.length) {
      console.log('\n  additionally funded (--fund; no local signing key):');
      for (const addr of FUND_ADDRESSES) console.log(`  ${addr}  ${DEV_BALANCE / ETH} ETH`);
    }
    console.log('');
  });
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
