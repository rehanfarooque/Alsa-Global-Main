// Phase 7 — protobuf namespace rename: worldmonitor → alsaglobal
//
// 1) Rename 4 directories (already done with git mv before running this script).
// 2) Update string literals in .proto files (package + import paths).
// 3) Update string literals in generated .ts files (source comment).
// 4) Update consumer imports across src/, server/, api/, scripts/, vite.config.ts.
// 5) Update proto/buf.yaml and proto/buf.gen.yaml metadata.

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TARGET_TREES = [
  'src', 'server', 'api', 'scripts', 'tests', 'e2e', 'convex',
  'proto/alsaglobal', // post-rename
];
const TARGET_FILES = [
  'vite.config.ts', 'middleware.ts',
  'proto/buf.yaml', 'proto/buf.gen.yaml',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs',
  '.proto', '.yaml', '.yml', '.json', '.html', '.md',
]);

// Replacements: order matters — most-specific first.
const REPLACEMENTS = [
  // Directory-style paths in imports / strings
  [/generated\/client\/worldmonitor\//g, 'generated/client/alsaglobal/'],
  [/generated\/server\/worldmonitor\//g, 'generated/server/alsaglobal/'],
  // server/alsaglobal/ → server/alsaglobal/  (be careful: don't match "server/worldmonitor.app")
  [/(['"`])\.\.\/server\/worldmonitor\//g, '$1../server/alsaglobal/'],
  [/(['"`])\.\/server\/worldmonitor\//g, '$1./server/alsaglobal/'],
  [/(['"`])(\.\.\/)+server\/worldmonitor\//g, (m) => m.replace('server/alsaglobal/', 'server/alsaglobal/')],
  // proto package: package alsaglobal.X.v1;
  [/\bpackage\s+worldmonitor\./g, 'package alsaglobal.'],
  // proto imports: import "alsaglobal/...
  [/\bimport\s+"worldmonitor\//g, 'import "alsaglobal/'],
  // OpenAPI bundle metadata
  [/bundle_title=AlsaGlobal API/g, 'bundle_title=AlsaGlobal API'],
  [/bundle_output=worldmonitor\.openapi\.yaml/g, 'bundle_output=alsaglobal.openapi.yaml'],
  [/bundle_description=Unified OpenAPI bundle spanning all WorldMonitor services\./g, 'bundle_description=Unified OpenAPI bundle spanning all AlsaGlobal services.'],
  [/bundle_contact_name=AlsaGlobal/g, 'bundle_contact_name=AlsaGlobal'],
  // go_package_prefix
  [/value:\s+github\.com\/worldmonitor\/proto/g, 'value: github.com/alsaglobal/proto'],
  // buf.yaml ignore_only paths
  [/(\s+- )worldmonitor\//g, '$1alsaglobal/'],
  // Source-file comments in generated TS
  [/\/\/ source:\s+worldmonitor\//g, '// source: alsaglobal/'],
];

let totalReplaced = 0;
const filesChanged = [];

function processFile(absPath) {
  const ext = extname(absPath).toLowerCase();
  if (!EXTS.has(ext)) return;
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return; }
  let after = content;
  let count = 0;
  for (const [pat, sub] of REPLACEMENTS) {
    after = after.replace(pat, (...args) => {
      count++;
      if (typeof sub === 'function') return sub(args[0]);
      // Build a result by manually performing replacement with capture groups
      // when the replacement string contains $1/$2 etc.
      if (typeof sub === 'string' && /\$\d/.test(sub)) {
        // For string replacements with capture refs, JS already handles them
        // via the standard String.replace contract. But because we're inside
        // the replace callback, capture groups arrive as args. Reconstruct.
        let out = sub;
        const captures = args.slice(1, -2);
        for (let i = 0; i < captures.length; i++) {
          out = out.replace(new RegExp('\\$' + (i + 1), 'g'), captures[i] ?? '');
        }
        return out;
      }
      return sub;
    });
  }
  if (after !== content) {
    writeFileSync(absPath, after);
    totalReplaced += count;
    filesChanged.push([absPath.replace(ROOT, ''), count]);
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

console.log(`Files changed: ${filesChanged.length}`);
console.log(`Total replacements: ${totalReplaced}`);
// Print only the first 30 + a tail summary to keep output readable
filesChanged.slice(0, 30).forEach(([f, n]) => console.log(`  ${f}: ${n}`));
if (filesChanged.length > 30) console.log(`  ... and ${filesChanged.length - 30} more`);
