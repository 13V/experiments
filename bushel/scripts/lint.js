#!/usr/bin/env node
'use strict';
/**
 * lint.js — the cheapest check that earns its place: every script parses, every config is JSON.
 * No dependency, no style rules, nothing to argue about. It is here so CI has something to fail on
 * from the first commit rather than after the first outage.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let checked = 0;
const problems = [];

// site/data/menu.json is generated, so it is checked when it is there and not missed when it is
// not — a fresh clone has no menu until `node scripts/menu.js` has run once.
const JS_DIRS = ['scripts', 'site', 'test/site', 'test/site/support'];
const JSON_DIRS = ['config', 'site/config', 'site/data'];

for (const dir of JS_DIRS) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith('.js')) continue;
    const file = path.join(full, name);
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); checked++; }
    catch (e) { problems.push(`${dir}/${name}: ${String(e.stderr || e).split('\n').slice(0, 2).join(' ')}`); }
  }
}
for (const dir of JSON_DIRS) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith('.json')) continue;
    try { JSON.parse(fs.readFileSync(path.join(full, name), 'utf8')); checked++; }
    catch (e) { problems.push(`${dir}/${name}: ${e.message}`); }
  }
}

if (problems.length) { problems.forEach((p) => console.error('  ' + p)); console.error(`lint: ${problems.length} problem(s)`); process.exit(1); }
console.log(`lint: ${checked} file(s) OK (syntax and config JSON only — no style rules, no new dependency)`);
