import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const OUT_DIR = new URL('../public/favico/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT_DIR, { recursive: true });

const BG = '#0a0f0a';
const ACCENT = '#4ade80';
const FG = '#ffffff';

function iconSvg(size) {
  const padding = Math.round(size * 0.08);
  const inner = size - padding * 2;
  const fontSize = Math.round(inner * 0.5);
  const strokeW = Math.max(1, Math.round(size / 64));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${inner / 2 - strokeW}" fill="none" stroke="${ACCENT}" stroke-width="${strokeW}" opacity="0.55"/>
  <text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="${FG}" text-anchor="middle" dominant-baseline="central" letter-spacing="-2">AG</text>
</svg>`;
}

function ogSvg() {
  const w = 1200, h = 630;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#0a2a20" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w / 2}" cy="${h / 2 - 20}" r="180" fill="none" stroke="${ACCENT}" stroke-width="2" opacity="0.4"/>
  <circle cx="${w / 2}" cy="${h / 2 - 20}" r="110" fill="none" stroke="${ACCENT}" stroke-width="1.5" opacity="0.3"/>
  <text x="50%" y="42%" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="140" fill="${FG}" text-anchor="middle" dominant-baseline="central" letter-spacing="-4">AlsaGlobal</text>
  <text x="50%" y="62%" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="32" fill="#a8b8a8" text-anchor="middle" dominant-baseline="central" letter-spacing="2">REAL-TIME GLOBAL INTELLIGENCE DASHBOARD</text>
</svg>`;
}

async function renderPng(svg, size, out) {
  await sharp(Buffer.from(svg)).resize(size, size, { fit: 'cover' }).png().toFile(out);
  console.log(`wrote ${out}`);
}

async function main() {
  // App / favicon sizes
  for (const size of [16, 32, 48, 180, 192, 512]) {
    const svg = iconSvg(size);
    const out = join(OUT_DIR, size === 180 ? 'apple-touch-icon.png' :
                              size === 192 ? 'android-chrome-192x192.png' :
                              size === 512 ? 'android-chrome-512x512.png' :
                              `favicon-${size}x${size}.png`);
    await renderPng(svg, size, out);
  }

  // OG image
  const og = ogSvg();
  await sharp(Buffer.from(og)).resize(1200, 630, { fit: 'cover' }).png().toFile(join(OUT_DIR, 'og-image.png'));
  console.log(`wrote ${join(OUT_DIR, 'og-image.png')}`);

  // favicon.ico = composite of 16/32/48
  // sharp doesn't write ICO natively, so we use 32x32 PNG renamed (browsers accept this fallback)
  const ico32 = await sharp(Buffer.from(iconSvg(32))).resize(32, 32).png().toBuffer();
  writeFileSync(join(OUT_DIR, 'favicon.ico'), ico32);
  console.log(`wrote ${join(OUT_DIR, 'favicon.ico')} (32x32 PNG-in-ICO; modern browsers accept this)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
