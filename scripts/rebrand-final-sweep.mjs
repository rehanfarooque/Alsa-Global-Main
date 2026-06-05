// Final sweep: rewrite every remaining 'worldmonitor' / 'WorldMonitor' /
// 'World Monitor' mention across the codebase, with three carve-outs:
//
//   1. The LICENSE file is NOT touched (preserves Elie Habib's copyright).
//   2. The ONE upstream source link in the site footer + mobile menu is
//      preserved (AGPL §13 — users must be able to find the source).
//   3. blog-site/ and pro-test/ are sub-products with their own scope.

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TARGET_TREES = ['src', 'api', 'server', 'scripts', 'public', 'convex', 'shared', 'e2e', 'tests', 'docs'];
const TARGET_FILES = [
  'index.html', 'live-channels.html', 'mcp-grant.html', 'settings.html', 'brief-palette-playground.html',
  'middleware.ts', 'vite.config.ts',
  'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'AGENTS.md',
  'ARCHITECTURE.md', 'DEPLOYMENT-PLAN.md', 'SELF_HOSTING.md',
  'Dockerfile', 'docker-compose.yml',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'blog-site', 'pro-test']);
const SKIP_FILES = new Set(['LICENSE', 'rebrand-final-sweep.mjs', 'rebrand-proto.mjs', 'rebrand-proto-pass2.mjs', 'rebrand-locales.mjs', 'rebrand-storage-keys.mjs', 'gen-alsaglobal-icons.mjs']);
const EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs',
  '.html', '.css', '.md', '.json', '.yaml', '.yml',
  '.toml', '.proto',
]);

// URL hosts to PRESERVE (upstream backend services + email).
// If we rewrite these we lose graceful fallbacks. The user can replace
// these later if/when they stand up their own backend.
const PRESERVE_HOST_REGEX = [
  /api\.worldmonitor\.app/,
  /maps\.worldmonitor\.app/,
  /proxy\.worldmonitor\.app/,
  /abacus\.worldmonitor\.app/,
  /status\.worldmonitor\.app/,
  /relay\.worldmonitor\.app/,
  /widget\.worldmonitor\.app/,
  /support@worldmonitor\.app/,
  /noreply@worldmonitor\.app/,
];

// The ONE link we keep for AGPL §13.
const PRESERVE_LITERAL = 'github.com/koala73/worldmonitor';

// Ordered replacements. Order matters — most-specific first to avoid
// double-replacement (e.g. don't rewrite 'WorldMonitor' to 'AlsaGlobal' BEFORE
// the longer 'WorldMonitorBot' pattern matches).
const REPLACEMENTS = [
  // Telegram bot fallback (user-visible in settings)
  [/'WorldMonitorBot'/g, "'AlsaGlobalBot'"],
  [/"WorldMonitorBot"/g, '"AlsaGlobalBot"'],
  // Push notification fallback title
  [/title:\s*'WorldMonitor'/g, "title: 'AlsaGlobal'"],
  [/'WorldMonitor'/g, "'AlsaGlobal'"],
  [/"WorldMonitor"/g, '"AlsaGlobal"'],
  // Push notification tag default
  [/'worldmonitor-generic'/g, "'alsaglobal-generic'"],
  // HTTP header names — cosmetic, won't affect upstream API calls
  [/x-worldmonitor-/g, 'x-alsaglobal-'],
  [/X-WorldMonitor-/g, 'X-AlsaGlobal-'],
  // User-Agent strings — cosmetic, used in our own outbound calls
  [/'worldmonitor-([a-z][a-z-]*)\/(\d+\.\d+)'/g, "'alsaglobal-$1/$2'"],
  [/"worldmonitor-([a-z][a-z-]*)\/(\d+\.\d+)"/g, '"alsaglobal-$1/$2"'],
  // User-visible product-page links: route to localhost root since we don't
  // run our own /pro /blog /docs /help backends. The fallback is
  // user lands on the dashboard rather than getting a 404 elsewhere.
  [/https?:\/\/(?:www\.)?worldmonitor\.app\/pro[^\s'"`<>)]*/g, '/'],
  [/https?:\/\/(?:www\.)?worldmonitor\.app\/blog[^\s'"`<>)]*/g, '/'],
  [/https?:\/\/(?:www\.)?worldmonitor\.app\/docs[^\s'"`<>)]*/g, '/'],
  [/https?:\/\/(?:www\.)?worldmonitor\.app\/help[^\s'"`<>)]*/g, '/'],
  // Bare "World Monitor" / "WorldMonitor" brand mentions in comments/docs
  [/World Monitor/g, 'AlsaGlobal'],
  [/WorldMonitor/g, 'AlsaGlobal'],
];

function shouldPreserveLine(line) {
  if (line.includes(PRESERVE_LITERAL)) return true;
  for (const h of PRESERVE_HOST_REGEX) if (h.test(line)) return true;
  return false;
}

let totalReplaced = 0;
let filesChanged = 0;

function processFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  if (!EXTS.has(ext)) return;
  if (SKIP_FILES.has(basename(absPath))) return;
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return; }
  // Line-by-line so we can skip preservation lines
  const lines = content.split(/\r?\n/);
  let changed = false;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (shouldPreserveLine(lines[i])) continue;
    const before = lines[i];
    let after = before;
    for (const [pat, sub] of REPLACEMENTS) after = after.replace(pat, sub);
    if (after !== before) {
      lines[i] = after;
      changed = true;
      count++;
    }
  }
  if (changed) {
    writeFileSync(absPath, lines.join('\n'));
    filesChanged++;
    totalReplaced += count;
  }
}

function walk(dirAbs) {
  if (!existsSync(dirAbs)) return;
  for (const name of readdirSync(dirAbs)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dirAbs, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full);
    else processFile(full);
  }
}

for (const d of TARGET_TREES) walk(join(ROOT, d));
for (const f of TARGET_FILES) processFile(join(ROOT, f));

console.log(`Files changed: ${filesChanged}`);
console.log(`Line replacements: ${totalReplaced}`);
