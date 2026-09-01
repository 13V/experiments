#!/usr/bin/env node
'use strict';

/**
 * Tests for the hunt. Run: node scripts/test.js
 *
 * The important one is the front-running suite. Everything else in this project is
 * cosmetic if a bot can lift the answer out of the mempool and take the prize.
 */

const p = require('./puzzle');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------

section('Normalization');
check('lowercases and strips separators', p.normalize('count the blocks') === 'COUNTTHEBLOCKS');
check('strips punctuation and digits', p.normalize('a-b_c 1 2 d!') === 'ABCD');
check('is idempotent', p.normalize(p.normalize('Count The Blocks')) === 'COUNTTHEBLOCKS');
check(
  'hash is insensitive to how a solver types it',
  p.answerHash('count the blocks') === p.answerHash('COUNT-THE-BLOCKS')
);

section('Stage solvability');
const solved = p.solve();
for (const r of solved) {
  check(`stage ${r.stage} key recovered from chain data`, r.keyOk, r.recoveredKey);
  check(`stage ${r.stage} answer decrypts`, r.answerOk, r.recoveredAnswer);
  check(`stage ${r.stage} answer matches published hash`, r.hashOk);
}

section('Encoding round-trips');
const amounts = p.amountsFor('SECRET');
check('amounts decode back to the word', p.amountsToWord(amounts.map((a) => a.amount)) === 'SECRET');
check('amounts are explorer-readable dust', amounts[0].amount === '0.0000083', amounts[0].amount);
const prefixes = p.vanityPrefixesFor('LEDGER');
check('address prefixes decode back to the word',
  prefixes.map((x) => String.fromCharCode(parseInt(x.prefix, 16))).join('') === 'LEDGER');
check('prefix is one byte of hex', prefixes[0].prefix === '0x4c', prefixes[0].prefix);

section('Vigenere');
check('encrypt then decrypt is identity',
  p.vigenere(p.vigenere('COUNTTHEBLOCKS', 'SECRET'), 'SECRET', true) === 'COUNTTHEBLOCKS');
check('known ciphertext is stable', p.vigenere('COUNTTHEBLOCKS', 'SECRET') === 'USWEXMZIDCSVCW');
check('wrong key does not decrypt', p.vigenere('USWEXMZIDCSVCW', 'WRONGKEY', true) !== 'COUNTTHEBLOCKS');

// ---------------------------------------------------------------------------
// The part that actually matters.
// ---------------------------------------------------------------------------

section('Front-running resistance');

const ANSWER = 'COUNT THE BLOCKS';
const solver = '0x1111111111111111111111111111111111111111';
const attacker = '0x2222222222222222222222222222222222222222';
const salt = '0x' + 'ab'.repeat(32);

const solverCommit = p.commitment(ANSWER, solver, salt);
const attackerCommit = p.commitment(ANSWER, attacker, salt);

check('commitment is deterministic', p.commitment(ANSWER, solver, salt) === solverCommit);
check(
  'SAME answer + SAME salt + different address => different commitment',
  solverCommit !== attackerCommit,
  'this is the whole front-run defence'
);
check('different salt => different commitment',
  p.commitment(ANSWER, solver, '0x' + 'cd'.repeat(32)) !== solverCommit);
check('wrong answer => different commitment',
  p.commitment('WRONG', solver, salt) !== solverCommit);

// Simulate the attack the naive design loses to.
// Attacker watches the solver's reveal tx and learns (answer, salt) in full.
const stolen = { answer: ANSWER, salt };
// To claim, the contract recomputes sha256(answer, msg.sender, salt) against the
// attacker's OWN stored commitment. They never made one, and even if they front-run a
// commit in the same block, it hashes to attackerCommit — not solverCommit.
check(
  'attacker replaying a stolen reveal cannot match the solver commitment',
  p.commitment(stolen.answer, attacker, stolen.salt) !== solverCommit
);
check(
  'the only address that can spend this commitment is the committer',
  p.commitment(ANSWER, solver, salt) === solverCommit &&
    p.commitment(ANSWER, attacker, salt) !== solverCommit
);

section('Salt quality');
const salts = new Set(Array.from({ length: 200 }, () => p.randomSalt()));
check('salts are unique across 200 draws', salts.size === 200);
check('salt is 32 bytes', p.randomSalt().length === 66);

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
