// Second pass: catch bare 'server/alsaglobal/' substrings and stale
// path references in comments that the first pass's anchored regex missed.

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TARGET_TREES = ['src', 'server', 'api', 'scripts', 'tests', 'e2e', 'convex', 'shared'];
const TARGET_FILES = ['vite.config.ts', 'middleware.ts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.proto']);

// Plain substring replacement — narrow enough to avoid false positives
// (won't match server.worldmonitor.app or repo URLs).
const REPLACEMENTS = [
  ['server/alsaglobal/', 'server/alsaglobal/'],
  ['proto/alsaglobal/', 'proto/alsaglobal/'],
];

let totalReplaced = 0;
let filesChanged = 0;

function processFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  if (!EXTS.has(ext)) return;
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return; }
  let after = content;
  let count = 0;
  for (const [find, sub] of REPLACEMENTS) {
    if (after.includes(find)) {
      const before = after;
      after = after.split(find).join(sub);
      count += (before.length - after.length) / (find.length - sub.length) || 0;
    }
  }
  if (after !== content) {
    writeFileSync(absPath, after);
    totalReplaced += count;
    filesChanged++;
  }
}

function walk(dirAbs) {
  if (!existsSync(dirAbs)) return;
  for (const name of readdirSync(dirAbs)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dirAbs, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else processFile(full);
  }
}

for (const d of TARGET_TREES) walk(join(ROOT, d));
for (const f of TARGET_FILES) processFile(join(ROOT, f));

console.log(`Pass 2: ${filesChanged} files changed, ~${totalReplaced} replacements`);
