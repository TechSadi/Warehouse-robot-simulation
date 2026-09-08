#!/usr/bin/env node
/**
 * Syntax-checks every source and test file.
 *
 * The previous `lint` script ran `node --check src/server.js`, which only
 * parses that one file - a syntax error anywhere else passed lint and was
 * caught later, or not at all. This walks the tree instead.
 *
 * Deliberately not a full ESLint setup: the project has no lint config to
 * respect, and adding one during a security phase would bury the security
 * diff under a few hundred style fixes.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'tests', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'coverage', 'dist']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((dir) => {
  const full = path.join(ROOT, dir);
  return fs.existsSync(full) ? walk(full) : [];
});

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${path.relative(ROOT, file)}`);
    console.error(String(err.stderr || err.message).trim());
  }
}

console.log(`[lint] checked ${files.length} file(s), ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
