import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const LOCALES_DIR = new URL('../src/locales/', import.meta.url);
const localeRoot = LOCALES_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1');

const REPLACEMENTS = [
  [/World Monitor/g, 'AlsaGlobal'],
  [/WorldMonitor/g, 'AlsaGlobal'],
];

const files = readdirSync(localeRoot).filter((f) => extname(f) === '.json');
let total = 0;
for (const f of files) {
  const p = join(localeRoot, f);
  const before = readFileSync(p, 'utf8');
  let after = before;
  for (const [pat, sub] of REPLACEMENTS) after = after.replace(pat, sub);
  if (after !== before) {
    writeFileSync(p, after);
    const diff = (before.match(/World Monitor|WorldMonitor/g) || []).length;
    total += diff;
    console.log(`${f}: ${diff} replacements`);
  }
}
console.log(`\nDone. ${files.length} files scanned, ${total} replacements.`);
