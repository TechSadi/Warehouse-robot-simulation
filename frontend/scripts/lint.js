#!/usr/bin/env node
/**
 * Syntax- and hygiene-checks every source and test file.
 *
 * Mirrors backend/scripts/lint.js deliberately: the same command name, the
 * same "walk the tree, fail loudly" shape, and the same reasoning for not
 * being a full ESLint setup - the project has no lint config to respect,
 * and introducing one mid-phase would bury the real diff under a few
 * hundred style fixes. What it does check is the small set of mistakes that
 * are cheap to detect and expensive to ship.
 *
 * Parsing is done by esbuild (already present via Vite), because `node
 * --check` cannot parse JSX or ESM-with-import.meta, which is most of this
 * codebase.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'tests', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'coverage', 'dist', 'playwright-report', 'test-results']);
const EXTENSIONS = ['.js', '.jsx'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Checks that do not need a full linter but do catch real problems:
 *
 *  - `.only` in a committed test silently disables every other test in the
 *    file, and nothing else in CI would notice.
 *  - `debugger` halts a real browser.
 *  - A `console.log` left in application code ships to users' consoles.
 *    Warnings and errors are legitimate and allowed.
 */
const RULES = [
  {
    name: 'focused-test',
    pattern: /\b(?:describe|it|test)\.only\s*\(/,
    message: '.only would silently skip the rest of the file',
    appliesTo: (path) => path.includes('tests'),
  },
  {
    name: 'debugger',
    pattern: /^\s*debugger\s*;?\s*$/m,
    message: 'debugger statement left in the source',
    appliesTo: () => true,
  },
  {
    name: 'console-log',
    pattern: /console\.log\s*\(/,
    message: 'console.log in application code (use console.warn/error, or remove it)',
    appliesTo: (path) => path.includes(`src${'/'}`) || path.includes(`src${'\\'}`),
  },
];

const files = DIRS.flatMap((dir) => {
  const full = join(ROOT, dir);
  try {
    return statSync(full).isDirectory() ? walk(full) : [];
  } catch {
    return [];
  }
});

let failures = 0;

for (const file of files) {
  const relativePath = relative(ROOT, file);
  const source = readFileSync(file, 'utf8');

  try {
    transformSync(source, {
      loader: file.endsWith('.jsx') ? 'jsx' : 'js',
      format: 'esm',
      sourcefile: relativePath,
    });
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${relativePath}`);
    for (const problem of error.errors || []) {
      console.error(`  ${problem.text} (line ${problem.location?.line ?? '?'})`);
    }
    continue;
  }

  for (const rule of RULES) {
    if (!rule.appliesTo(relativePath)) continue;
    if (rule.pattern.test(source)) {
      failures += 1;
      console.error(`FAIL ${relativePath}: ${rule.message} [${rule.name}]`);
    }
  }
}

console.log(`[lint] checked ${files.length} file(s), ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
