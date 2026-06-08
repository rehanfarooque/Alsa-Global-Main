/**
 * Downloads the default ARGUS avatar (Ready Player Me GLB) to public/avatar-argus.glb.
 *
 * Run: `node scripts/download-avatar.mjs`
 *      `node scripts/download-avatar.mjs --force`  (overwrite existing)
 *      `ARGUS_AVATAR_URL=https://... node scripts/download-avatar.mjs`  (custom URL)
 *
 * Ready Player Me avatars (with ?morphTargets=ARKit,Oculus+Visemes) ship with
 * ~15 viseme blendshapes for accurate lip-sync.
 *
 * To use your own avatar:
 *   1. Visit https://readyplayer.me — pick "Male" or "Female"
 *   2. Use a selfie or design from scratch (free, no signup)
 *   3. Click "Next" → copy your GLB URL (https://models.readyplayer.me/<id>.glb)
 *   4. Append morph-target query: ?morphTargets=ARKit,Oculus+Visemes
 *   5. Run: ARGUS_AVATAR_URL='<your URL>' node scripts/download-avatar.mjs --force
 */
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'public', 'avatar-argus.glb');

// Public Ready Player Me sample avatars (verified working, male professional).
// First entry wins; fallbacks try in order.
const CANDIDATES = [
  process.env.ARGUS_AVATAR_URL,
  'https://models.readyplayer.me/64bfa9f1e2cdf81f17d1aff5.glb?morphTargets=ARKit,Oculus+Visemes&textureAtlas=1024',
  'https://models.readyplayer.me/638df693d72bffc6fa179492.glb?morphTargets=ARKit,Oculus+Visemes&textureAtlas=1024',
  'https://models.readyplayer.me/63d7c9824f7d540b1ea5167a.glb?morphTargets=ARKit,Oculus+Visemes&textureAtlas=1024',
  // Final fallback: bundled Three.js demo soldier (rigged humanoid, no visemes)
  'https://threejs.org/examples/models/gltf/Soldier.glb',
].filter(Boolean);

async function fetchAvatar(url) {
  console.log(`[avatar] Trying: ${url.slice(0, 90)}${url.length > 90 ? '...' : ''}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AlsaGlobal/1.0 (ARGUS avatar downloader)' },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 10_000) throw new Error(`unexpectedly small (${buf.length} bytes)`);
  // GLB files start with "glTF"
  const magic = buf.subarray(0, 4).toString('utf8');
  if (magic !== 'glTF') throw new Error(`not a GLB (magic=${magic})`);
  return buf;
}

async function alreadyDownloaded() {
  try {
    const s = await stat(OUT_PATH);
    return s.size > 10_000;
  } catch {
    return false;
  }
}

async function main() {
  if (!process.argv.includes('--force') && await alreadyDownloaded()) {
    console.log(`[avatar] ${OUT_PATH} already exists. Use --force to overwrite.`);
    return;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });

  for (const url of CANDIDATES) {
    try {
      const buf = await fetchAvatar(url);
      await writeFile(OUT_PATH, buf);
      console.log(`[avatar] OK — saved ${buf.length.toLocaleString()} bytes to ${OUT_PATH}`);
      console.log(`[avatar] Source: ${url}`);
      return;
    } catch (err) {
      console.warn(`[avatar] Failed: ${err.message}`);
    }
  }

  console.error('[avatar] All sources failed.');
  console.error('  - Check your network (some firewalls block CDNs)');
  console.error('  - Manually download a Ready Player Me GLB and save to public/avatar-argus.glb');
  console.error('  - The app falls back to a procedural humanoid if no GLB is present');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[avatar] Fatal: ${err.message}`);
  process.exit(1);
});
