#!/usr/bin/env node
'use strict';

/**
 * Tests for the hunt. Run: node scripts/test.js
 *
 * Two suites carry the project. Everything else is scaffolding.
 *
 *   1. Primitives against published vectors. keccak256 and secp256k1 are reimplemented
 *      here from scratch, so they are guilty until proven innocent — a subtly wrong
 *      curve derives a puzzleSigner address nobody can ever sign for, and the prize is
 *      entombed with a straight face and an on-chain proof that it was "solvable".
 *
 *   2. Front-running resistance. If a bot can lift a winning claim out of the mempool
 *      and redirect it, nothing else in this repo matters.
 */

const crypto = require('node:crypto');
const { keccak256Hex } = require('./keccak');
const secp = require('./secp256k1');
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

const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------

section('keccak256 against published vectors');
check(
  'keccak256("") matches the canonical empty hash',
  keccak256Hex('') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  keccak256Hex('')
);
check(
  'keccak256("abc") matches',
  keccak256Hex('abc') === '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  keccak256Hex('abc')
);
check(
  'input longer than the 136-byte rate absorbs correctly',
  keccak256Hex('a'.repeat(200)).length === 66 && keccak256Hex('a'.repeat(200)) !== keccak256Hex('a'.repeat(201))
);
check(
  'this is keccak, NOT node\'s sha3-256',
  keccak256Hex('') !== '0x' + crypto.createHash('sha3-256').update('').digest('hex'),
  'if these ever match, the padding is wrong and every address is garbage'
);

section('secp256k1 against published key vectors');
const KEY1 = '0x' + '00'.repeat(31) + '01';
const KEY2 = '0x' + '00'.repeat(31) + '02';
check(
  'private key 1 derives 0x7E5F...95Bdf',
  secp.sameAddress(secp.addressOf(KEY1), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
  secp.addressOf(KEY1)
);
check(
  'private key 2 derives 0x2B5A...D6cF',
  secp.sameAddress(secp.addressOf(KEY2), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF'),
  secp.addressOf(KEY2)
);
check('EIP-55 checksum casing is produced', secp.addressOf(KEY1).startsWith('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'.slice(0, 6)));
check('generator is on the curve', secp.onCurve(secp.G));
check('public key is on the curve', secp.onCurve(secp.publicKey(p.demoKey('curvecheck'))));
check('scalar mul is consistent: 2G == G+G', (() => {
  const a = secp.mul(2n, secp.G);
  const b = secp.add(secp.G, secp.G);
  return a.x === b.x && a.y === b.y;
})());
check('n*G is the point at infinity', secp.mul(secp.N, secp.G) === null);

section('Signing');
const SK = p.demoKey('signing');
const PK = secp.addressOf(SK);
const d1 = crypto.createHash('sha256').update('one').digest();
const d2 = crypto.createHash('sha256').update('two').digest();
const s1 = secp.sign(SK, d1);
const s2 = secp.sign(SK, d2);

check('signature recovers to the signer', secp.sameAddress(secp.recover(d1, s1.v, s1.r, s1.s), PK));
check('signing is deterministic (RFC 6979)', JSON.stringify(secp.sign(SK, d1)) === JSON.stringify(s1));
check(
  'a different digest uses a different nonce',
  s1.r !== s2.r,
  'reused nonces across digests leak the private key outright'
);
check('s is always in the lower half of the curve order', secp.toBig(secp.hexToBuf(s1.s)) <= secp.HALF_N);
check('v is 27 or 28', s1.v === 27 || s1.v === 28);
check('signature does not verify against a different digest', !secp.verify(d2, s1, PK));
check('signature does not verify against a different signer', !secp.verify(d1, s1, secp.addressOf(KEY1)));
check('a mutated r is rejected', (() => {
  const bad = { ...s1, r: '0x' + 'ff'.repeat(32) };
  return !secp.verify(d1, bad, PK);
})());
check(
  'the malleable twin (v^1, r, n-s) is rejected',
  (() => {
    const flipped = {
      v: s1.v === 27 ? 28 : 27,
      r: s1.r,
      s: secp.hex32(secp.N - secp.toBig(secp.hexToBuf(s1.s))),
    };
    // It is a mathematically valid signature for the same digest...
    const recovers = secp.sameAddress(secp.recover(d1, flipped.v, flipped.r, flipped.s) || '0x0', PK);
    // ...and the contract's upper-half guard, mirrored in verify(), still refuses it.
    return recovers && !secp.verify(d1, flipped, PK);
  })(),
  'this is what the upper-half-of-n check in claim() is for'
);

section('Stage encodings round-trip');
const st1 = p.buildStage1();
check('32 key bytes become 32 dust transfers', st1.amounts.length === 32);
check(
  'amounts are uniform-width explorer-readable dust',
  st1.amounts.every((a) => /^0\.0000[2-5]\d\d$/.test(a.amount)),
  st1.amounts[0].amount
);
check('no transfer is zero-valued', st1.amounts.every((a) => parseFloat(a.amount) > 0));
check(
  'amounts decode back to the key',
  p.amountsToKey(st1.amounts.map((a) => a.amount)) === st1._key
);
check(
  'the published puzzleSigner is the address of the hidden key',
  secp.sameAddress(st1.puzzleSigner, secp.addressOf(st1._key))
);

const st2 = p.buildStage2();
check('key splits into three shares', st2.shares.length === 3);
check(
  'all three shares XOR back to the key',
  p.xorCombine(st2.shares.map((s) => s.value)) === st2._key
);
check(
  'ANY TWO shares reveal nothing',
  [[0, 1], [0, 2], [1, 2]].every(([i, j]) => p.xorCombine([st2.shares[i].value, st2.shares[j].value]) !== st2._key),
  'the stage has to survive one share leaking publicly'
);
check(
  'share B round-trips through destination-address bytes',
  p.addressBytesToShare(p.shareToAddressBytes(st2.shares[1].value)) === st2.shares[1].value
);

section('End-to-end solvability');
for (const r of p.solve()) {
  check(`stage ${r.stage} key recovered from chain data alone`, r.keyOk);
  check(`stage ${r.stage} recovered key derives the published puzzleSigner`, r.addressOk, r.recoveredAddress);
  check(`stage ${r.stage} the recovered key can actually claim`, r.claimOk);
}

// ---------------------------------------------------------------------------
// The part that actually matters.
// ---------------------------------------------------------------------------

section('Front-running resistance');

const CONTRACT = '0x' + 'cc'.repeat(20);
const CHAIN = 8453;
const STAGE = 1;
const PUZZLE_KEY = p.demoKey('stage1');
const SIGNER = secp.addressOf(PUZZLE_KEY);

const winner = '0x' + '11'.repeat(20);
const attacker = '0x' + '22'.repeat(20);

// The winner broadcasts. The transaction sits in the mempool in plain sight.
const claim = p.buildClaim(PUZZLE_KEY, STAGE, winner, CONTRACT, CHAIN);

check('the honest claim is valid', p.checkClaim(claim, SIGNER, CONTRACT, CHAIN));

// The attack: a bot copies the pending transaction and swaps in its own address.
const hijacked = { ...claim, recipient: attacker };
check(
  'THE ATTACK: swapping the recipient invalidates the signature',
  !p.checkClaim(hijacked, SIGNER, CONTRACT, CHAIN),
  'the recipient is inside the signed digest — there is nothing to redirect'
);

check(
  'the digest for the attacker differs from the digest for the winner',
  p.claimDigest(STAGE, winner, CONTRACT, CHAIN).toString('hex') !==
    p.claimDigest(STAGE, attacker, CONTRACT, CHAIN).toString('hex')
);
check(
  'the copied signature recovers to a stranger, not the puzzle signer',
  (() => {
    const d = p.claimDigest(STAGE, attacker, CONTRACT, CHAIN);
    const got = secp.recover(d, claim.v, claim.r, claim.s);
    return got === null || !secp.sameAddress(got, SIGNER);
  })()
);
check(
  'a copied transaction rebroadcast verbatim still pays the WINNER',
  p.checkClaim({ ...claim }, SIGNER, CONTRACT, CHAIN) && claim.recipient.toLowerCase() === winner.toLowerCase(),
  'the classic attack degrades into a free relay service for the winner'
);

section('Replay resistance');
check(
  'a claim for stage 1 cannot claim stage 2',
  !p.checkClaim({ ...claim, stageId: 2 }, SIGNER, CONTRACT, CHAIN)
);
check(
  'a claim cannot be replayed against a different deployment',
  !p.checkClaim(claim, SIGNER, '0x' + 'dd'.repeat(20), CHAIN)
);
check(
  'a claim cannot be replayed on a forked chain',
  !p.checkClaim(claim, SIGNER, CONTRACT, 1),
  'chainid is in the digest'
);
check(
  'a claim signed by the wrong key is rejected',
  !p.checkClaim(p.buildClaim(p.demoKey('impostor'), STAGE, winner, CONTRACT, CHAIN), SIGNER, CONTRACT, CHAIN)
);

section('Digest layout matches the contract');
const dg = p.claimDigest(0, winner, CONTRACT, 1);
check('digest is 32 bytes', dg.length === 32);
check(
  'digest preimage is abi.encodePacked(uint256,address,address,uint256) = 104 bytes',
  (() => {
    const manual = crypto.createHash('sha256').update(Buffer.concat([
      Buffer.alloc(32),                                  // stageId 0
      Buffer.from('11'.repeat(20), 'hex'),               // recipient
      Buffer.from('cc'.repeat(20), 'hex'),               // contract
      Buffer.concat([Buffer.alloc(31), Buffer.from([1])]), // chainid 1
    ])).digest();
    return manual.equals(dg);
  })(),
  'if this drifts from the Solidity, every claim on earth reverts'
);

section('Key generation');
const keys = new Set(Array.from({ length: 50 }, () => p.newPuzzleKey()));
check('CSPRNG keys are unique across 50 draws', keys.size === 50);
check('keys are 32 bytes', p.newPuzzleKey().length === 66);
check('every generated key is a valid scalar', Array.from(keys).every((k) => {
  const d = secp.toBig(secp.hexToBuf(k));
  return d > 0n && d < secp.N;
}));
check(
  'demo keys are deterministic — and therefore must never be launched with',
  p.demoKey('x') === p.demoKey('x') && p.demoKey('x') !== p.demoKey('y')
);

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
