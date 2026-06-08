#!/usr/bin/env node
/**
 * One-shot probe that opens a WebSocket to Gemini Live with the local
 * GEMINI_API_KEY, sends the same `setup` frame VoiceSession.ts sends, and
 * waits for `setupComplete`. Tells us in one run whether the key works
 * against the Live API at all.
 *
 * Usage: node scripts/test-gemini-live.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadDotenv(path) {
  try {
    const txt = readFileSync(path, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // .env optional
  }
}

loadDotenv(resolve(ROOT, '.env'));
loadDotenv(resolve(ROOT, '.env.local'));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('FAIL: GEMINI_API_KEY not found in .env or environment');
  process.exit(2);
}

const masked = `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
console.log(`Using GEMINI_API_KEY ${masked} (length ${apiKey.length})`);

// Candidate Live API models, ordered newest → fallback. We try each until one
// returns setupComplete or we exhaust the list.
const CANDIDATES = [
  'gemini-2.0-flash-live-001',
  'gemini-live-2.5-flash-preview',
  'gemini-2.5-flash-preview-native-audio-dialog',
  'gemini-2.0-flash-exp',
];

async function tryModel(model) {
  return new Promise((resolveOut) => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    const ws = new WebSocket(url);
    const t0 = Date.now();
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolveOut({ model, ms: Date.now() - t0, ...verdict });
    };
    const killer = setTimeout(() => finish({ ok: false, reason: 'timeout (15s)' }), 15_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ['AUDIO'] },
        },
      }));
    });
    ws.on('message', (data) => {
      let text;
      try { text = data.toString(); } catch { text = '<binary>'; }
      let msg;
      try { msg = JSON.parse(text); } catch { msg = null; }
      if (msg?.setupComplete) {
        clearTimeout(killer);
        finish({ ok: true });
      } else {
        // Surface upstream-provided diagnostics
        clearTimeout(killer);
        finish({ ok: false, reason: `unexpected first message: ${text.slice(0, 240)}` });
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(killer);
      finish({ ok: false, reason: `closed code=${code}${reason && reason.length ? ` reason="${reason.toString()}"` : ''}` });
    });
    ws.on('error', (err) => {
      clearTimeout(killer);
      finish({ ok: false, reason: `ws error: ${err.message}` });
    });
  });
}

let firstSuccess = null;
const results = [];
for (const model of CANDIDATES) {
  process.stdout.write(`→ ${model.padEnd(50)} `);
  const r = await tryModel(model);
  results.push(r);
  if (r.ok) {
    console.log(`OK (${r.ms}ms)`);
    if (!firstSuccess) firstSuccess = r.model;
  } else {
    console.log(`FAIL — ${r.reason}`);
  }
}

console.log('');
if (firstSuccess) {
  console.log(`PASS: key works with model "${firstSuccess}"`);
  process.exit(0);
} else {
  console.log('FAIL: key did not work with any Live API model.');
  console.log('Likely causes:');
  console.log('  • Key has Generative Language API enabled but not the Live (Bidi) endpoint');
  console.log('  • Key is for a region that does not yet have Live API');
  console.log('  • Quota exhausted for the day');
  console.log('Get a fresh key at https://aistudio.google.com/apikey');
  process.exit(1);
}
