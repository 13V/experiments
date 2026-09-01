#!/usr/bin/env node
'use strict';

/**
 * Puzzle toolkit for TreasureHunt.
 *
 * Zero dependencies. Uses node:crypto sha256, which matches the contract's sha256
 * precompile byte for byte — so a hash produced here is the hash the chain will check.
 *
 *   node scripts/puzzle.js stage1        build the stage 1 artifacts
 *   node scripts/puzzle.js stage2        build the stage 2 artifacts
 *   node scripts/puzzle.js hash <answer> sha256 of a normalized answer
 *   node scripts/puzzle.js solve         run the full solver, proving both stages are solvable
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Answer normalization
// ---------------------------------------------------------------------------

/**
 * Answers are uppercase A-Z only. Everything else is stripped.
 * This has to be identical everywhere (site, contract docs, tooling) or solvers
 * will produce hashes that don't match and think the puzzle is broken.
 *   "count the blocks" -> "COUNTTHEBLOCKS"
 */
function normalize(answer) {
  return String(answer).toUpperCase().replace(/[^A-Z]/g, '');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const hex = (buf) => '0x' + buf.toString('hex');

/** sha256(bytes(answer)) — matches the contract's answerHash check. */
function answerHash(answer) {
  return hex(sha256(Buffer.from(normalize(answer), 'utf8')));
}

/**
 * sha256(abi.encodePacked(answer, solver, salt)) — matches the contract's commit check.
 * encodePacked of (string, address, bytes32) is: utf8 bytes || 20 address bytes || 32 salt bytes.
 */
function commitment(answer, solver, salt) {
  const a = Buffer.from(normalize(answer), 'utf8');
  const s = Buffer.from(solver.replace(/^0x/i, ''), 'hex');
  const t = Buffer.from(salt.replace(/^0x/i, ''), 'hex');
  if (s.length !== 20) throw new Error('solver must be a 20-byte address');
  if (t.length !== 32) throw new Error('salt must be 32 bytes');
  return hex(sha256(Buffer.concat([a, s, t])));
}

const randomSalt = () => hex(crypto.randomBytes(32));

// ---------------------------------------------------------------------------
// Stage 1 layer A — letters encoded as dust transfer amounts
// ---------------------------------------------------------------------------

/**
 * Encode a word as a series of dust amounts whose significant digits are ASCII codes.
 * Readable in any block explorer with no tooling, which is the point: stage 1 has to be
 * approachable or nobody starts.
 *
 * 'S' (83) -> 0.0000083 SOL  /  0.0000083 ETH
 */
function amountsFor(word, decimals = 7) {
  return normalize(word).split('').map((ch, i) => {
    const code = ch.charCodeAt(0); // 65..90
    return {
      order: i + 1,
      letter: ch,
      ascii: code,
      amount: (code / Math.pow(10, decimals)).toFixed(decimals),
    };
  });
}

/** Inverse: read the amounts back out, as a solver would. */
function amountsToWord(amounts, decimals = 7) {
  return amounts
    .map((a) => String.fromCharCode(Math.round(parseFloat(a) * Math.pow(10, decimals))))
    .join('');
}

// ---------------------------------------------------------------------------
// Stage 1 layer B — Vigenere
// ---------------------------------------------------------------------------

function vigenere(text, key, decrypt = false) {
  const t = normalize(text);
  const k = normalize(key);
  if (!k) throw new Error('key required');
  const dir = decrypt ? -1 : 1;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const p = t.charCodeAt(i) - 65;
    const s = k.charCodeAt(i % k.length) - 65;
    out += String.fromCharCode(((p + dir * s + 26) % 26) + 65);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — letters encoded as vanity address prefixes
// ---------------------------------------------------------------------------

/**
 * Stage 1 taught: amounts carry data.
 * Stage 2 teaches: destinations carry data.
 *
 * Each transfer goes to an address whose first byte is the ASCII code of a letter.
 * 'C' (0x43) -> 0x43........  Grinding a 2-hex-char prefix is ~256 tries: instant.
 */
function vanityPrefixesFor(word) {
  return normalize(word).split('').map((ch, i) => {
    const code = ch.charCodeAt(0);
    return {
      order: i + 1,
      letter: ch,
      ascii: code,
      prefix: '0x' + code.toString(16).padStart(2, '0'),
    };
  });
}

/** Grind a vanity address with the given 1-byte prefix. Demo only — keys here are throwaway. */
function grindVanity(prefixByte, maxTries = 500000) {
  const want = prefixByte.replace(/^0x/i, '').toLowerCase();
  for (let i = 0; i < maxTries; i++) {
    // Stand-in for real keypair derivation: any 20-byte value works to prove the search cost.
    const addr = crypto.randomBytes(20).toString('hex');
    if (addr.startsWith(want)) return { address: '0x' + addr, tries: i + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The hunt
// ---------------------------------------------------------------------------

const STAGE1 = { key: 'SECRET', answer: 'COUNT THE BLOCKS' };
const STAGE2 = { key: 'LEDGER', answer: 'NOTHING IS HIDDEN ONLY UNREAD' };

function buildStage1() {
  const amounts = amountsFor(STAGE1.key);
  const ciphertext = vigenere(STAGE1.answer, STAGE1.key);
  return {
    stage: 1,
    prizeSuggestion: '$500-1,000 — its job is to prove the contract pays, not to be the treasure',
    layerA: {
      medium: 'Dust transfers from the puzzle wallet. Amounts are ASCII codes, ordered by block time.',
      amounts,
      spells: STAGE1.key,
    },
    layerB: {
      medium: "Ciphertext published in the token's own on-chain metadata.",
      cipher: 'Vigenere',
      keyFrom: 'layer A',
      ciphertext,
      plaintext: normalize(STAGE1.answer),
    },
    answer: normalize(STAGE1.answer),
    answerHash: answerHash(STAGE1.answer),
  };
}

function buildStage2() {
  const prefixes = vanityPrefixesFor(STAGE2.key);
  const ciphertext = vigenere(STAGE2.answer, STAGE2.key);
  return {
    stage: 2,
    prizeSuggestion: 'The main pot',
    entryPoint: "Stage 1's answer, COUNT THE BLOCKS, points at the transfers below.",
    layerA: {
      medium:
        'Transfers to crafted destination addresses. The first byte of each address is an ASCII code. ' +
        'Amounts are now uniform and meaningless — the tell that the medium moved.',
      prefixes,
      spells: STAGE2.key,
    },
    layerB: {
      medium: 'Ciphertext committed in the contract deployment calldata.',
      cipher: 'Vigenere',
      keyFrom: 'layer A',
      ciphertext,
      plaintext: normalize(STAGE2.answer),
    },
    answer: normalize(STAGE2.answer),
    answerHash: answerHash(STAGE2.answer),
  };
}

/** Walk both stages exactly as a solver would. Proves solvability end to end. */
function solve() {
  const results = [];

  for (const [n, built, spec] of [[1, buildStage1(), STAGE1], [2, buildStage2(), STAGE2]]) {
    // Layer A: recover the key from the on-chain medium.
    const recoveredKey =
      n === 1
        ? amountsToWord(built.layerA.amounts.map((a) => a.amount))
        : built.layerA.prefixes.map((p) => String.fromCharCode(parseInt(p.prefix, 16))).join('');

    // Layer B: decrypt with it.
    const recoveredAnswer = vigenere(built.layerB.ciphertext, recoveredKey, true);

    const keyOk = recoveredKey === normalize(spec.key);
    const answerOk = recoveredAnswer === normalize(spec.answer);
    const hashOk = answerHash(recoveredAnswer) === built.answerHash;

    results.push({ stage: n, recoveredKey, recoveredAnswer, keyOk, answerOk, hashOk });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'stage1') {
    console.log(JSON.stringify(buildStage1(), null, 2));
  } else if (cmd === 'stage2') {
    console.log(JSON.stringify(buildStage2(), null, 2));
  } else if (cmd === 'hash') {
    if (!rest.length) throw new Error('usage: puzzle.js hash <answer>');
    const a = rest.join(' ');
    console.log(normalize(a), answerHash(a));
  } else if (cmd === 'solve') {
    const results = solve();
    for (const r of results) {
      console.log(
        `stage ${r.stage}: key=${r.recoveredKey} answer="${r.recoveredAnswer}" ` +
          `[key ${r.keyOk ? 'ok' : 'FAIL'} | answer ${r.answerOk ? 'ok' : 'FAIL'} | hash ${r.hashOk ? 'ok' : 'FAIL'}]`
      );
    }
    const allOk = results.every((r) => r.keyOk && r.answerOk && r.hashOk);
    console.log(allOk ? '\nBoth stages solvable.' : '\nSOLVABILITY FAILURE');
    process.exit(allOk ? 0 : 1);
  } else {
    console.log('usage: puzzle.js <stage1|stage2|hash <answer>|solve>');
    process.exit(1);
  }
}

module.exports = {
  normalize,
  answerHash,
  commitment,
  randomSalt,
  amountsFor,
  amountsToWord,
  vigenere,
  vanityPrefixesFor,
  grindVanity,
  buildStage1,
  buildStage2,
  solve,
};
