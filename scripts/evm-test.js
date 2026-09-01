#!/usr/bin/env node
'use strict';

/**
 * Integration test: run the real compiled contract inside a real EVM.
 *
 * scripts/test.js proves the JS toolkit is self-consistent. That is not the same claim.
 * This file proves the toolkit agrees with the CONTRACT — that the digest Solidity
 * builds is the digest we sign, that ecrecover accepts our signature, and that the
 * front-running attack reverts on a real interpreter rather than in a model of one.
 *
 * A digest layout that drifts by one byte passes every unit test in this repo and then
 * reverts every claim on mainnet forever, with the prize locked and an on-chain proof
 * that it was "solvable". That is the failure this file exists to catch.
 *
 * Needs dev dependencies, so it is deliberately NOT part of `node scripts/test.js`:
 *   npm install --no-save solc@0.8.28 @ethereumjs/vm@8.1.1 @ethereumjs/common@4.4.0 @ethereumjs/util@9.1.0
 *   node scripts/evm-test.js
 */

let solc, VM, Common, Hardfork, Address, Account, hexToBytes, bytesToHex;
try {
  solc = require('solc');
  ({ VM } = require('@ethereumjs/vm'));
  ({ Common, Hardfork } = require('@ethereumjs/common'));
  ({ Address, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util'));
} catch (e) {
  console.log('SKIPPED — dev dependencies not installed. See the header of this file.');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secp = require('./secp256k1');
const p = require('./puzzle');
const { keccak256 } = require('./keccak');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// ABI encoding, by hand. Only four shapes are needed and pulling in ethers to get
// them would defeat the point of a repo anyone can audit in one sitting.
// ---------------------------------------------------------------------------

const selector = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4);
const word = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex');
const addrWord = (a) => Buffer.concat([Buffer.alloc(12), Buffer.from(a.replace(/^0x/, ''), 'hex')]);
const b32Word = (h) => Buffer.from(h.replace(/^0x/, '').padStart(64, '0'), 'hex');
const encode = (sig, ...args) => Buffer.concat([selector(sig), ...args]);

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'TreasureHunt.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'TreasureHunt.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));

const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
const artifact = out.contracts['TreasureHunt.sol']['TreasureHunt'];
const warnings = (out.errors || []).filter((e) => e.severity === 'warning');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CURATOR = '0x' + 'c0'.repeat(20);
const WINNER = '0x' + '11'.repeat(20);
const ATTACKER = '0x' + '22'.repeat(20);
const ONE_ETH = 10n ** 18n;

const addr = (h) => new Address(hexToBytes(h));

async function main() {
  const common = new Common({ chain: 1, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const CHAIN_ID = Number(common.chainId());

  for (const a of [CURATOR, WINNER, ATTACKER]) {
    const acct = new Account(0n, 100n * ONE_ETH);
    await vm.stateManager.putAccount(addr(a), acct);
  }

  const call = async (opts) => {
    const res = await vm.evm.runCall({
      caller: addr(opts.from || CURATOR),
      origin: addr(opts.from || CURATOR),
      to: opts.to ? addr(opts.to) : undefined,
      data: opts.data,
      value: opts.value || 0n,
      gasLimit: 5_000_000n,
      ...(opts.to ? {} : { isStatic: false }),
    });
    return {
      reverted: !!res.execResult.exceptionError,
      error: res.execResult.exceptionError?.error,
      returnValue: Buffer.from(res.execResult.returnValue),
      createdAddress: res.createdAddress ? bytesToHex(res.createdAddress.bytes) : null,
    };
  };

  const balanceOf = async (a) => (await vm.stateManager.getAccount(addr(a)))?.balance ?? 0n;
  // Custom errors are keccak(sig)[:4], same as a selector.
  const errorIs = (ret, sig) => ret.subarray(0, 4).equals(selector(sig));

  // -------------------------------------------------------------------------
  section('Compilation');
  check('contract compiles with no errors', true);
  check('contract compiles with no warnings', warnings.length === 0,
    warnings.map((w) => w.formattedMessage.split('\n')[0]).join(' | '));

  const fns = artifact.abi.filter((x) => x.type === 'function').map((x) => x.name);
  check('there is no withdraw/rescue/sweep function at all',
    !fns.some((n) => /withdraw|rescue|sweep|emergency|drain|destroy/i.test(n)), fns.join(', '));
  check('there is no owner-transfer or signer-setter',
    !fns.some((n) => /^(set|update|change)(Owner|Curator|PuzzleSigner|Signer)/i.test(n)), fns.join(', '));

  // -------------------------------------------------------------------------
  section('Deploy');
  const ROLLOVER_AFTER = 100n;
  const deploy = await call({
    data: Buffer.concat([Buffer.from(artifact.evm.bytecode.object, 'hex'), word(ROLLOVER_AFTER)]),
  });
  check('deploys', !deploy.reverted && deploy.createdAddress, deploy.error);
  const HUNT = deploy.createdAddress;
  console.log(`       deployed at ${HUNT}`);

  // -------------------------------------------------------------------------
  section('Stage creation');
  const PUZZLE_KEY = p.demoKey('evm-stage');
  const SIGNER = secp.addressOf(PUZZLE_KEY);

  const created = await call({
    to: HUNT, from: CURATOR, value: ONE_ETH,
    data: encode('createStage(address,uint64,bool)', addrWord(SIGNER), word(0), word(0)),
  });
  check('curator creates and funds stage 0', !created.reverted, created.error);
  check('the escrow holds the prize', (await balanceOf(HUNT)) === ONE_ETH);

  const notCurator = await call({
    to: HUNT, from: ATTACKER, value: 0n,
    data: encode('createStage(address,uint64,bool)', addrWord(SIGNER), word(0), word(0)),
  });
  check('a stranger cannot create a stage', notCurator.reverted &&
    errorIs(notCurator.returnValue, 'NotCurator()'));

  const zeroSigner = await call({
    to: HUNT, from: CURATOR, value: 0n,
    data: encode('createStage(address,uint64,bool)', addrWord('0x' + '00'.repeat(20)), word(0), word(0)),
  });
  check('a stage with no puzzle signer is refused', zeroSigner.reverted &&
    errorIs(zeroSigner.returnValue, 'EmptySigner()'),
    'otherwise the curator can create an unsolvable stage and blame the puzzle');

  // -------------------------------------------------------------------------
  section('THE CRITICAL CHECK: on-chain digest == toolkit digest');
  const onChain = await call({
    to: HUNT, from: WINNER,
    data: encode('claimDigest(uint256,address)', word(0), addrWord(WINNER)),
  });
  const offChain = p.claimDigest(0, WINNER, HUNT, CHAIN_ID);
  check('Solidity claimDigest byte-for-byte matches scripts/puzzle.js',
    !onChain.reverted && onChain.returnValue.equals(offChain),
    `chain=${onChain.returnValue.toString('hex')} js=${offChain.toString('hex')}`);

  // -------------------------------------------------------------------------
  section('Honest claim');
  const claim = p.buildClaim(PUZZLE_KEY, 0, WINNER, HUNT, CHAIN_ID);
  const winnerBefore = await balanceOf(WINNER);

  const claimData = (stageId, recipient, sig) => encode(
    'claim(uint256,address,uint8,bytes32,bytes32)',
    word(stageId), addrWord(recipient), word(sig.v), b32Word(sig.r), b32Word(sig.s)
  );

  // ---- The attack happens FIRST, while the prize is still unclaimed. ----
  section('Front-running, against the real EVM');
  const hijack = await call({
    to: HUNT, from: ATTACKER,
    data: claimData(0, ATTACKER, claim),
  });
  check('THE ATTACK: attacker copies the signature and swaps in their own address -> REVERTS',
    hijack.reverted && errorIs(hijack.returnValue, 'BadSignature()'),
    hijack.error || hijack.returnValue.toString('hex'));
  check('the prize is untouched after the attack', (await balanceOf(HUNT)) === ONE_ETH);

  const relayed = await call({
    to: HUNT, from: ATTACKER,
    data: claimData(0, WINNER, claim),
  });
  check('the same attacker relaying it verbatim SUCCEEDS — and pays the winner',
    !relayed.reverted, relayed.error);
  check('the winner received the whole prize',
    (await balanceOf(WINNER)) === winnerBefore + ONE_ETH,
    `delta ${(await balanceOf(WINNER)) - winnerBefore}`);
  check('the escrow is empty', (await balanceOf(HUNT)) === 0n);
  check('the attacker paid the gas and got nothing',
    (await balanceOf(ATTACKER)) <= 100n * ONE_ETH);

  const twice = await call({ to: HUNT, from: WINNER, data: claimData(0, WINNER, claim) });
  check('the same claim cannot be replayed', twice.reverted &&
    errorIs(twice.returnValue, 'AlreadyClaimed()'));

  // -------------------------------------------------------------------------
  section('Signature rejection paths');
  await call({
    to: HUNT, from: CURATOR, value: ONE_ETH,
    data: encode('createStage(address,uint64,bool)', addrWord(SIGNER), word(0), word(0)),
  });

  const wrongKey = p.buildClaim(p.demoKey('impostor'), 1, WINNER, HUNT, CHAIN_ID);
  const wrongKeyRes = await call({ to: HUNT, from: WINNER, data: claimData(1, WINNER, wrongKey) });
  check('a signature from the wrong key is refused', wrongKeyRes.reverted &&
    errorIs(wrongKeyRes.returnValue, 'BadSignature()'));

  const otherStage = p.buildClaim(PUZZLE_KEY, 0, WINNER, HUNT, CHAIN_ID);
  const otherStageRes = await call({ to: HUNT, from: WINNER, data: claimData(1, WINNER, otherStage) });
  check('a signature for stage 0 cannot claim stage 1', otherStageRes.reverted &&
    errorIs(otherStageRes.returnValue, 'BadSignature()'));

  const good = p.buildClaim(PUZZLE_KEY, 1, WINNER, HUNT, CHAIN_ID);
  const malleable = {
    v: good.v === 27 ? 28 : 27,
    r: good.r,
    s: secp.hex32(secp.N - secp.toBig(secp.hexToBuf(good.s))),
  };
  check('the malleable twin recovers to the right signer off-chain',
    secp.sameAddress(secp.recover(p.claimDigest(1, WINNER, HUNT, CHAIN_ID), malleable.v, malleable.r, malleable.s), SIGNER),
    'proving the next check is a real guard, not a tautology');
  const malleableRes = await call({ to: HUNT, from: WINNER, data: claimData(1, WINNER, malleable) });
  check('...and the contract refuses it anyway (upper-half s guard)',
    malleableRes.reverted && errorIs(malleableRes.returnValue, 'BadSignature()'));

  const badV = await call({ to: HUNT, from: WINNER, data: claimData(1, WINNER, { ...good, v: 29 }) });
  check('an out-of-range v is refused', badV.reverted && errorIs(badV.returnValue, 'BadSignature()'));

  const zeroRecipient = await call({
    to: HUNT, from: WINNER,
    data: claimData(1, '0x' + '00'.repeat(20), good),
  });
  check('the zero address cannot be the recipient', zeroRecipient.reverted &&
    errorIs(zeroRecipient.returnValue, 'ZeroRecipient()'));

  // -------------------------------------------------------------------------
  section('Time gate and allowlist');
  const GATED_KEY = p.demoKey('evm-gated');
  const GATED_SIGNER = secp.addressOf(GATED_KEY);
  await call({
    to: HUNT, from: CURATOR, value: ONE_ETH,
    data: encode('createStage(address,uint64,bool)', addrWord(GATED_SIGNER), word(1_000_000), word(1)),
  });
  const gatedClaim = p.buildClaim(GATED_KEY, 2, WINNER, HUNT, CHAIN_ID);
  const tooEarly = await call({ to: HUNT, from: WINNER, data: claimData(2, WINNER, gatedClaim) });
  check('a valid signature before opensAt is refused', tooEarly.reverted &&
    errorIs(tooEarly.returnValue, 'NotOpenYet()'),
    'this is what lets a timelocked share land fairly for everyone');

  const openKey = p.demoKey('evm-allowlist');
  const openSigner = secp.addressOf(openKey);
  await call({
    to: HUNT, from: CURATOR, value: ONE_ETH,
    data: encode('createStage(address,uint64,bool)', addrWord(openSigner), word(0), word(1)),
  });
  const alClaim = p.buildClaim(openKey, 3, WINNER, HUNT, CHAIN_ID);
  const notAllowed = await call({ to: HUNT, from: WINNER, data: claimData(3, WINNER, alClaim) });
  check('an unregistered recipient is refused on an allowlisted stage', notAllowed.reverted &&
    errorIs(notAllowed.returnValue, 'NotAllowlisted()'));

  const setAl = await call({
    to: HUNT, from: ATTACKER,
    data: Buffer.concat([
      selector('setAllowlist(address[],bool)'), word(64), word(1), word(1), addrWord(ATTACKER),
    ]),
  });
  check('a stranger cannot add themselves to the allowlist', setAl.reverted &&
    errorIs(setAl.returnValue, 'NotCurator()'));

  await call({
    to: HUNT, from: CURATOR,
    data: Buffer.concat([
      selector('setAllowlist(address[],bool)'), word(64), word(1), word(1), addrWord(WINNER),
    ]),
  });
  const before = await balanceOf(WINNER);
  const allowed = await call({ to: HUNT, from: WINNER, data: claimData(3, WINNER, alClaim) });
  check('a pre-registered recipient claims normally', !allowed.reverted, allowed.error);
  check('and is paid', (await balanceOf(WINNER)) > before);

  // -------------------------------------------------------------------------
  section('Rug resistance');
  const escrowed = await balanceOf(HUNT);
  check('funds remain escrowed across the unsolved stages', escrowed === 2n * ONE_ETH,
    `${escrowed}`);

  const earlyRollover = await call({
    to: HUNT, from: ATTACKER,
    data: encode('rollover(uint256,uint256)', word(1), word(2)),
  });
  check('rollover before rolloverAfter blocks is refused', earlyRollover.reverted &&
    errorIs(earlyRollover.returnValue, 'RolloverTooEarly()'));

  const curatorBefore = await balanceOf(CURATOR);
  const drainAttempts = [
    encode('rollover(uint256,uint256)', word(1), word(1)),
    Buffer.concat([selector('withdraw()')]),
    Buffer.concat([selector('sweep()')]),
  ];
  for (const data of drainAttempts) await call({ to: HUNT, from: CURATOR, data });
  check('no curator call moves money out of the escrow',
    (await balanceOf(HUNT)) === escrowed && (await balanceOf(CURATOR)) <= curatorBefore);

  const plainSend = await call({ to: HUNT, from: ATTACKER, value: ONE_ETH, data: Buffer.alloc(0) });
  check('an untargeted transfer tops up stage 0 rather than sticking (stage 0 is claimed, so it reverts)',
    plainSend.reverted && errorIs(plainSend.returnValue, 'NoSuchStage()'),
    'refusing money it cannot account for beats silently swallowing it');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
