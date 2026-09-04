#!/usr/bin/env node
'use strict';
/**
 * Cross-check every contract call the site makes against the compiled ABIs.
 *
 *   NODE_PATH=<repo>/node_modules node locate/scripts/abicheck.js
 *
 * The site hand-encodes calldata from signature strings. Nothing forces those strings to agree with
 * the contracts, so a rename in Solidity would silently produce transactions that revert on chain.
 * This compiles the contracts, pulls every encodeCall('...') out of the site, and fails if a
 * signature does not exist on the contract it is sent to.
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'contracts');
const SITE = path.join(ROOT, 'site');

// signatures the site legitimately sends to things we do not compile
const EXTERNAL = new Set([
  'balanceOf(address)', 'allowance(address,address)', 'approve(address,uint256)', 'decimals()',
  'transfer(address,uint256)', 'symbol()', 'name()',
  // Morpho Blue, verified live by preflight.js
  'position(bytes32,address)', 'market(bytes32)', 'isAuthorized(address,address)',
  'setAuthorization(address,bool)', 'idToMarketParams(bytes32)',
  'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
  'price()', 'latestRoundData()',
]);

function compile() {
  const sources = {};
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.sol')) sources[path.relative(SRC, p)] = { content: fs.readFileSync(p, 'utf8') };
    }
  })(SRC);
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi'] } } },
  })));
  for (const e of out.errors || []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
  const sigs = new Map();
  for (const file of Object.keys(out.contracts || {})) {
    for (const [name, c] of Object.entries(out.contracts[file])) {
      const set = new Set();
      for (const e of c.abi) {
        if (e.type !== 'function') continue;
        const t = (i) => (i.type === 'tuple' ? `(${i.components.map(t).join(',')})` : i.type);
        set.add(`${e.name}(${e.inputs.map(t).join(',')})`);
      }
      if (set.size) sigs.set(name, set);
    }
  }
  return sigs;
}

const sigs = compile();
const known = new Set([...EXTERNAL]);
for (const set of sigs.values()) for (const s of set) known.add(s);

console.log('Compiled:', [...sigs.keys()].filter((n) => /^Locate/.test(n)).join(', '));
console.log('Signatures on our contracts:', [...sigs.entries()].filter(([n]) => /^Locate/.test(n)).reduce((a, [, s]) => a + s.size, 0), '\n');

let pass = 0, fail = 0;
for (const file of ['app.js', 'lib.js']) {
  const src = fs.readFileSync(path.join(SITE, file), 'utf8');
  const found = [...src.matchAll(/encodeCall\(\s*'([^']+)'/g)].map((m) => m[1]);
  const uniq = [...new Set(found)];
  console.log(`${file}: ${uniq.length} distinct call signature(s)`);
  for (const s of uniq) {
    if (known.has(s)) { pass++; console.log(`  ok   ${s}`); }
    else {
      fail++;
      const [name] = s.split('(');
      const near = [...known].filter((k) => k.startsWith(name + '('));
      console.log(`  FAIL ${s}\n         not on any compiled contract${near.length ? `; did you mean ${near.join(' or ')}` : ''}`);
    }
  }
}

console.log(`\n${pass} matched, ${fail} unmatched`);
process.exit(fail ? 1 : 0);
