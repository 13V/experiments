#!/usr/bin/env node
'use strict';
/**
 * The seam between site/app.js and site/launch.js.
 *
 * launch.js was verified against 43 real historical launch transactions, and app.js was verified in
 * a browser — but each was written against the other's description rather than the other's code, so
 * the one thing neither pass could check is that the object app.js actually builds is the object
 * launch.js actually expects. That is what this file checks, with the form literal copied from
 * app.js's doLaunch() rather than invented here.
 *
 *   node test/launch.test.js
 */
const path = require('path');
const L = require(path.join(__dirname, '..', 'site', 'launch.js'));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${what}`);
}
function checkThat(what, cond, detail) {
  if (!cond) { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
  else console.log(`  ok   ${what}`);
}

// Exactly the shape site/app.js builds in doLaunch(); if that literal changes, this must too.
const ACCOUNT = '0x4ca685f4a1cd39ba0d0f1cd06b3f2b0f5b7cdd11';
const GLD = '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e';
const form = () => ({
  name: 'Gold Standard', symbol: 'GOLDS',
  logo: 'https://example.invalid/g.png', description: 'A coin priced in ounces.',
  creatorTaxBps: 100, creatorFeeRecipient: ACCOUNT, pairToken: GLD,
});
// launch() reads this live from previewLaunchEconomics; encoding it here needs a fixed one so the
// calldata is reproducible. It is opaque to both files — a pin, not a number either of them reads.
const PIN = '0x' + 'ab'.repeat(32);
const SALT = '0x' + '11'.repeat(32);
const encodable = (extra) => Object.assign(form(), { expectedEconomics: PIN, salt: SALT }, extra || {});

console.log('the API app.js calls is present');
for (const fn of ['validate', 'preflight', 'encodeLaunch', 'launch']) {
  checkThat(`BushelLaunch.${fn} is a function`, typeof L[fn] === 'function');
}

console.log('\nvalidate() accepts what the form produces and names what it rejects');
check('a filled-in form passes', L.validate(form()), null);
checkThat('an empty name is refused', /name/i.test(L.validate(Object.assign(form(), { name: '' })) || ''));
checkThat('an empty symbol is refused', /symbol/i.test(L.validate(Object.assign(form(), { symbol: '' })) || ''));
checkThat('no connected wallet is refused',
  /recipient|address/i.test(L.validate(Object.assign(form(), { creatorFeeRecipient: '' })) || ''));
checkThat('a tax over the factory cap is refused',
  /tax/i.test(L.validate(Object.assign(form(), { creatorTaxBps: 1001 })) || ''));
check('a tax exactly at the cap passes', L.validate(Object.assign(form(), { creatorTaxBps: 1000 })), null);
checkThat('a negative tax is refused', /tax/i.test(L.validate(Object.assign(form(), { creatorTaxBps: -1 })) || ''));
// app.js reads the tax field with `Number(v) | 0`, so an empty box arrives as 0, not ''.
check('a zero tax passes', L.validate(Object.assign(form(), { creatorTaxBps: 0 })), null);

console.log('\nencodeLaunch() produces calldata that decodes back to the same form');
const data = L.encodeLaunch(encodable(), 0, GLD);
checkThat('calldata is 0x-prefixed hex of whole bytes',
  /^0x([0-9a-f]{2})+$/i.test(data), data.slice(0, 40));
check('it selects the three-argument launchToken overload', data.slice(0, 10), L.SEL_3);
const back = L.decodeLaunch(data);
check('name survives the round trip', back.params.name, 'Gold Standard');
check('symbol survives the round trip', back.params.symbol, 'GOLDS');
check('creatorTaxBps survives the round trip', Number(back.params.creatorTaxBps), 100);
check('pairToken survives the round trip', back.pairToken.toLowerCase(), GLD.toLowerCase());
check('launchConfigId survives the round trip', Number(back.launchConfigId), 0);
checkThat('creatorFeeRecipient survives the round trip',
  String(back.params.creatorFeeRecipient).toLowerCase() === ACCOUNT.toLowerCase(),
  String(back.params.creatorFeeRecipient));

check('the salt it was given survives the round trip', String(back.params.salt).toLowerCase(), SALT);
check('the economics pin survives the round trip', String(back.params.expectedEconomics).toLowerCase(), PIN);

console.log('\nthe two fields a form does not carry are handled by what they mean');
// A salt is a uniqueness nonce, so an absent one is filled in — and two encodings of the same form
// must therefore differ, or the fill is not random and two launches would collide.
const a1 = L.decodeLaunch(L.encodeLaunch(Object.assign(form(), { expectedEconomics: PIN }), 0, GLD));
const a2 = L.decodeLaunch(L.encodeLaunch(Object.assign(form(), { expectedEconomics: PIN }), 0, GLD));
checkThat('an absent salt is filled with 32 bytes', /^0x[0-9a-f]{64}$/i.test(String(a1.params.salt)), String(a1.params.salt));
checkThat('and a different one each time', String(a1.params.salt) !== String(a2.params.salt));
// The economics pin has no safe default: a wrong one reverts, a zero would disable the check.
let refused = null;
try { L.encodeLaunch(form(), 0, GLD); } catch (e) { refused = e.message; }
checkThat('an absent economics pin is refused by name', /expectedEconomics/.test(refused || ''), String(refused));

console.log('\nnon-ASCII names encode as UTF-8 rather than being mangled or dropped');
const emoji = encodable({ name: 'WR☻NGUSER ✗', symbol: 'WRØNG' });
const backEmoji = L.decodeLaunch(L.encodeLaunch(emoji, 0, GLD));
check('a name with symbols round trips', backEmoji.params.name, 'WR☻NGUSER ✗');
check('a symbol with a slashed O round trips', backEmoji.params.symbol, 'WRØNG');

console.log('\nthe four-argument overload is chosen only when a fourth argument is given');
check('with snipe exemptions it selects the four-argument overload',
  L.encodeLaunch(encodable(), 0, GLD, [ACCOUNT]).slice(0, 10), L.SEL_4);

console.log('\nthe constants match the chain this site is for');
check('chain id', Number(L.CHAIN_ID), 4663);
check('factory', String(L.FACTORY).toLowerCase(), '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
