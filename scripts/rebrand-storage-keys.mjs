import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TARGET_DIRS = ['src', 'e2e', 'scripts'];
const TARGET_FILES_ABS = ['index.html', 'live-channels.html', 'settings.html', 'middleware.ts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'generated']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.html']);

// Match quoted strings whose CONTENT is exactly `worldmonitor-<key>` where key
// contains only word chars and hyphens (no /, ., :, etc). This excludes
// User-Agent strings like 'worldmonitor-edge/1.0' (has a slash) and URL
// substrings, while catching the legitimate localStorage / namespace keys.
const PATTERN = /(['"])worldmonitor-([a-z][a-z0-9-]*?)\1/g;

let totalReplaced = 0;
const filesChanged = [];

function processFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  if (!EXTS.has(ext)) return;
  const before = readFileSync(absPath, 'utf8');
  if (!PATTERN.test(before)) { PATTERN.lastIndex = 0; return; }
  PATTERN.lastIndex = 0;
  let count = 0;
  const after = before.replace(PATTERN, (_m, q, key) => {
    count++;
    return `${q}alsaglobal-${key}${q}`;
  });
  if (after !== before) {
    writeFileSync(absPath, after);
    totalReplaced += count;
    filesChanged.push([absPath.replace(ROOT, ''), count]);
  }
}

function walk(dirAbs) {
  for (const name of readdirSync(dirAbs)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dirAbs, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else processFile(full);
  }
}

for (const d of TARGET_DIRS) walk(join(ROOT, d));
for (const f of TARGET_FILES_ABS) processFile(join(ROOT, f));

console.log(`Files changed: ${filesChanged.length}`);
for (const [f, n] of filesChanged) console.log(`  ${f}: ${n}`);
console.log(`Total replacements: ${totalReplaced}`);
