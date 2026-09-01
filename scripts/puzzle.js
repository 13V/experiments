#!/usr/bin/env node
'use strict';

/**
 * Puzzle toolkit for TreasureHunt. Zero dependencies.
 *
 *   node scripts/puzzle.js stage1     build the stage 1 artifacts
 *   node scripts/puzzle.js stage2     build the stage 2 artifacts
 *   node scripts/puzzle.js solve      walk both stages end to end, then claim
 *   node scripts/puzzle.js newkey     a real puzzle key from the OS CSPRNG
 *
 * ---------------------------------------------------------------------------
 * THE ONE DESIGN RULE
 * ---------------------------------------------------------------------------
 *
 * The prize is a PRIVATE KEY, and every byte of it is already published on-chain.
 * The puzzle is working out WHERE those bytes are and IN WHAT ORDER. Nothing is
 * ever guessed.
 *
 * That rule is not stylistic. The alternative — the puzzle yields a phrase, the
 * contract holds its hash — publishes a free, permanent, unlimited-rate oracle
 * against a secret with maybe thirty bits of entropy. Brain wallets with more
 * entropy than any English sentence get drained within minutes of funding.
 *
 * It also rules out the entire classical-cipher family. A Vigenere, a substitution,
 * a rail fence, an acrostic: a current frontier model solves all of them instantly
 * from a screenshot, so they cost a solver nothing and cost the hunt its whole
 * middle game. What survives is work no amount of cleverness shortcuts: reading a
 * lot of chain data and noticing structure in it.
 */

const crypto = require('node:crypto');
const secp = require('./secp256k1');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const hex = (buf) => '0x' + Buffer.from(buf).toString('hex');
const stripHex = (h) => String(h).replace(/^0x/i, '');
const bytesOf = (h) => Buffer.from(stripHex(h), 'hex');

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Deterministic key for the fixtures in this repo, so tests and docs are reproducible.
 * NEVER launch with one of these — they are computable by anyone reading the file.
 * Use `newPuzzleKey()`.
 */
function demoKey(label) {
  for (let i = 0; ; i++) {
    const candidate = sha256(Buffer.from(`treasurehunt/demo/${label}/${i}`, 'utf8'));
    const d = secp.toBig(candidate);
    if (d > 0n && d < secp.N) return hex(candidate);
  }
}

const newPuzzleKey = secp.newPrivateKey;

// ---------------------------------------------------------------------------
// Stage 1 encoding — key bytes as dust transfer amounts
// ---------------------------------------------------------------------------

/**
 * Each of the 32 key bytes becomes one dust transfer, ordered by block.
 *
 * amount = (byte + 256) / 1e7  ->  0.0000256 .. 0.0000511
 *
 * The +256 offset does real work: every amount has the same digit width and none is
 * zero, so there is no unspendable transfer and no ambiguity about leading zeros. A
 * solver reading a block explorer sees thirty-two near-identical dust sends and the
 * only variation is in the last three digits. That is the whole tell.
 */
function keyToAmounts(privHex, decimals = 7) {
  const key = bytesOf(privHex);
  if (key.length !== 32) throw new Error('private key must be 32 bytes');
  const scale = Math.pow(10, decimals);
  return Array.from(key, (byte, i) => ({
    order: i + 1,
    byte,
    amount: ((byte + 256) / scale).toFixed(decimals),
  }));
}

/** Inverse: read the amounts back off the explorer, in block order. */
function amountsToKey(amounts, decimals = 7) {
  const scale = Math.pow(10, decimals);
  const bytes = amounts.map((a) => {
    const v = Math.round(parseFloat(a) * scale) - 256;
    if (v < 0 || v > 255) throw new Error(`amount ${a} is not a key byte`);
    return v;
  });
  return hex(Buffer.from(bytes));
}

// ---------------------------------------------------------------------------
// Stage 2 encoding — key XOR-split across three media
// ---------------------------------------------------------------------------

const xorBuffers = (bufs) => {
  const out = Buffer.alloc(32);
  for (const b of bufs) for (let i = 0; i < 32; i++) out[i] ^= b[i];
  return out;
};

/**
 * Split a key into n shares such that all n are required and any n-1 reveal nothing.
 * Not "hard to reverse" — information-theoretically empty. A solver holding two of the
 * three shares has exactly as much as a solver holding none, which is what keeps the
 * stage alive after the first share is found and posted publicly.
 */
function xorSplit(privHex, n = 3, seed = null) {
  const key = bytesOf(privHex);
  if (key.length !== 32) throw new Error('private key must be 32 bytes');
  const shares = [];
  for (let i = 0; i < n - 1; i++) {
    shares.push(seed ? sha256(Buffer.from(`${seed}/share/${i}`, 'utf8')) : crypto.randomBytes(32));
  }
  shares.push(xorBuffers([key, ...shares]));
  return shares.map(hex);
}

const xorCombine = (shareHexes) => hex(xorBuffers(shareHexes.map(bytesOf)));

/** Share carried as the low byte of 32 crafted destination addresses. */
function shareToAddressBytes(shareHex) {
  return Array.from(bytesOf(shareHex), (byte, i) => ({
    order: i + 1,
    byte,
    lastByte: '0x' + byte.toString(16).padStart(2, '0'),
  }));
}

const addressBytesToShare = (entries) =>
  hex(Buffer.from(entries.map((e) => parseInt(stripHex(e.lastByte), 16))));

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * sha256(abi.encodePacked(uint256 stageId, address recipient, address contract, uint256 chainId))
 * = 32 || 20 || 20 || 32 = 104 bytes. Byte-identical to TreasureHunt.claimDigest.
 */
function claimDigest(stageId, recipient, contractAddress, chainId) {
  const r = bytesOf(recipient);
  const c = bytesOf(contractAddress);
  if (r.length !== 20) throw new Error('recipient must be a 20-byte address');
  if (c.length !== 20) throw new Error('contract must be a 20-byte address');
  return sha256(Buffer.concat([
    secp.big32(BigInt(stageId)),
    r,
    c,
    secp.big32(BigInt(chainId)),
  ]));
}

/**
 * Everything a winner submits, in one transaction.
 *
 * The recipient address is INSIDE the signed digest. That single fact is the entire
 * anti-front-running design: a validator, sequencer, RPC operator or mempool bot who
 * copies this transaction can do exactly one thing with it — rebroadcast it and pay
 * gas to hand the money to the winner. There is nothing to redirect.
 */
function buildClaim(privHex, stageId, recipient, contractAddress, chainId) {
  const digest = claimDigest(stageId, recipient, contractAddress, chainId);
  const sig = secp.sign(privHex, digest);
  return {
    stageId,
    recipient: secp.toChecksumAddress(recipient),
    digest: hex(digest),
    v: sig.v,
    r: sig.r,
    s: sig.s,
    call: `claim(${stageId}, ${secp.toChecksumAddress(recipient)}, ${sig.v}, ${sig.r}, ${sig.s})`,
  };
}

/** What the contract does with a claim: recover, compare to the stage's published signer. */
function checkClaim(claim, puzzleSigner, contractAddress, chainId) {
  const digest = claimDigest(claim.stageId, claim.recipient, contractAddress, chainId);
  return secp.verify(digest, { v: claim.v, r: claim.r, s: claim.s }, puzzleSigner);
}

// ---------------------------------------------------------------------------
// The hunt
// ---------------------------------------------------------------------------

const STAGE1_KEY = demoKey('stage1');
const STAGE2_KEY = demoKey('stage2');

function buildStage1() {
  const amounts = keyToAmounts(STAGE1_KEY);
  return {
    stage: 1,
    name: 'The Ledger',
    prizeSuggestion: 'Small. Its only job is to prove the contract pays.',
    puzzleSigner: secp.addressOf(STAGE1_KEY),
    medium: 'Thirty-two dust transfers out of the puzzle wallet, in block order.',
    encoding: 'amount = (key byte + 256) / 1e7. Subtract 256 from the last three digits.',
    amounts,
    solverPath: [
      'Notice the puzzle wallet made exactly 32 outbound transfers.',
      'Notice every amount sits between 0.0000256 and 0.0000511.',
      'Subtract 256 from each. Thirty-two numbers in 0..255 is a 256-bit key.',
      'Order by block. Derive the address. It is the one published in StageCreated.',
    ],
    // Present so `solve` can assert; strip before publishing anything.
    _key: STAGE1_KEY,
  };
}

function buildStage2() {
  const [shareA, shareB, shareC] = xorSplit(STAGE2_KEY, 3, 'treasurehunt/demo/stage2');
  return {
    stage: 2,
    name: 'The Split',
    prizeSuggestion: 'The main pot.',
    puzzleSigner: secp.addressOf(STAGE2_KEY),
    medium: 'The key is XOR-split three ways. Two of three shares reveal nothing at all.',
    shares: [
      {
        id: 'A',
        where: 'Published in the clear at launch, in the contract deployment calldata tail.',
        value: shareA,
        difficulty: 'Free. Everyone has this on day one, and it is worthless alone.',
      },
      {
        id: 'B',
        where: 'The last byte of each of 32 crafted destination addresses, in block order.',
        value: shareB,
        bytes: shareToAddressBytes(shareB),
        difficulty:
          'Stage 1 taught that amounts carry data. Here the amounts are uniform and ' +
          'meaningless — the signal moved to the destinations. That relocation is the puzzle.',
      },
      {
        id: 'C',
        where: 'Not on chain at launch. Released by drand timelock at a pre-announced block.',
        value: shareC,
        difficulty:
          'Nobody can finish before the timelock opens, so the grand prize is a fair start ' +
          'for everyone who did the work — not a prize for whoever scraped fastest.',
      },
    ],
    solverPath: [
      'Recover share B from the destination addresses.',
      'Take share A from the deployment calldata.',
      'Wait for share C. XOR all three. That is the key.',
    ],
    _key: STAGE2_KEY,
  };
}

/**
 * Walk both stages exactly as a solver would, then claim exactly as a winner would.
 * If this passes, the hunt is solvable and the prize is payable. If it fails, the
 * hunt is a scam whether or not anyone meant it to be.
 */
function solve(contractAddress = '0x' + '11'.repeat(20), chainId = 1) {
  const results = [];

  for (const built of [buildStage1(), buildStage2()]) {
    const recoveredKey =
      built.stage === 1
        ? amountsToKey(built.amounts.map((a) => a.amount))
        : xorCombine([
            built.shares[0].value,
            addressBytesToShare(built.shares[1].bytes),
            built.shares[2].value,
          ]);

    const recoveredAddress = secp.addressOf(recoveredKey);
    const addressOk = secp.sameAddress(recoveredAddress, built.puzzleSigner);

    const recipient = '0x' + 'aa'.repeat(20);
    const claim = buildClaim(recoveredKey, built.stage, recipient, contractAddress, chainId);
    const claimOk = checkClaim(claim, built.puzzleSigner, contractAddress, chainId);

    results.push({
      stage: built.stage,
      name: built.name,
      keyOk: recoveredKey === built._key,
      addressOk,
      claimOk,
      recoveredAddress,
      claim,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === '_key' ? undefined : v)));

  if (cmd === 'stage1') {
    console.log(JSON.stringify(strip(buildStage1()), null, 2));
  } else if (cmd === 'stage2') {
    console.log(JSON.stringify(strip(buildStage2()), null, 2));
  } else if (cmd === 'newkey') {
    const key = newPuzzleKey();
    console.log('private key  :', key, '  <- hide this in the chain, never commit it');
    console.log('puzzleSigner :', secp.addressOf(key), '  <- pass this to createStage');
  } else if (cmd === 'digest') {
    const [stageId, recipient, contract, chainId] = rest;
    if (!chainId) throw new Error('usage: puzzle.js digest <stageId> <recipient> <contract> <chainId>');
    console.log(hex(claimDigest(stageId, recipient, contract, chainId)));
  } else if (cmd === 'solve') {
    const results = solve();
    for (const r of results) {
      console.log(
        `stage ${r.stage} (${r.name}): key ${r.keyOk ? 'ok' : 'FAIL'} | ` +
          `address ${r.addressOk ? 'ok' : 'FAIL'} | claim ${r.claimOk ? 'ok' : 'FAIL'}  ${r.recoveredAddress}`
      );
    }
    const allOk = results.every((r) => r.keyOk && r.addressOk && r.claimOk);
    console.log(allOk ? '\nBoth stages solvable and payable.' : '\nSOLVABILITY FAILURE');
    process.exit(allOk ? 0 : 1);
  } else {
    console.log('usage: puzzle.js <stage1|stage2|solve|newkey|digest ...>');
    process.exit(1);
  }
}

module.exports = {
  demoKey, newPuzzleKey,
  keyToAmounts, amountsToKey,
  xorSplit, xorCombine, shareToAddressBytes, addressBytesToShare,
  claimDigest, buildClaim, checkClaim,
  buildStage1, buildStage2, solve,
};
