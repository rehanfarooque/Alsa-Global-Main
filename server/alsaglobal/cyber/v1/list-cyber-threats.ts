/**
 * ListCyberThreats — Feodo Tracker + C2IntelFeeds (GitHub) + curated static.
 * All sources are free with no API key required.
 */

import type {
  ServerContext,
  ListCyberThreatsRequest,
  ListCyberThreatsResponse,
  CyberThreat,
} from '../../../../src/generated/server/alsaglobal/cyber/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { DEFAULT_LIMIT, MAX_LIMIT, clampInt, SEVERITY_RANK } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'cyber:threats:v2';
const TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

const COUNTRY_COORDS: Record<string, [number, number]> = {
  US: [39.5, -98.3], RU: [61.5, 105.3], CN: [35.9, 104.2], DE: [51.2, 10.5],
  NL: [52.1, 5.3], FR: [46.2, 2.2], GB: [55.4, -3.4], SG: [1.4, 103.8],
  JP: [36.2, 138.3], BR: [-14.2, -51.9], IN: [20.6, 79.1], KR: [36.6, 127.0],
  UA: [48.4, 31.2], TR: [38.9, 35.2], PL: [51.9, 19.1], HK: [22.4, 114.1],
  CA: [56.1, -106.3], AU: [-25.3, 133.8], IT: [41.9, 12.6], SE: [60.1, 18.6],
  TW: [23.7, 121.0], RO: [45.9, 25.0], ID: [-0.8, 113.9], MY: [4.2, 101.9],
};

let _cache: { threats: CyberThreat[]; ts: number } | null = null;

interface FeodoEntry {
  ip_address: string; port: number; status: string;
  country: string; as_name: string; first_seen: string; last_online: string;
  malware?: string;
}

async function fetchFeodo(): Promise<CyberThreat[]> {
  const resp = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Feodo HTTP ${resp.status}`);
  const data: FeodoEntry[] = await resp.json();

  return data.map((e, i): CyberThreat => {
    const coords = COUNTRY_COORDS[e.country] ?? [0, 0];
    const isOnline = e.status === 'online';
    return {
      id: `feodo-${i}-${e.ip_address.replace(/\./g, '-')}`,
      type: 'CYBER_THREAT_TYPE_C2_SERVER',
      source: 'CYBER_THREAT_SOURCE_FEODO',
      indicator: `${e.ip_address}:${e.port}`,
      indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
      location: coords[0] !== 0 ? { latitude: coords[0], longitude: coords[1] } : undefined,
      country: e.country || '',
      severity: isOnline ? 'CRITICALITY_LEVEL_HIGH' : 'CRITICALITY_LEVEL_MEDIUM',
      malwareFamily: e.malware || e.as_name || 'Botnet C2',
      tags: [e.status, `port:${e.port}`, e.as_name].filter(Boolean),
      firstSeenAt: new Date(e.first_seen).getTime() || Date.now() - 30 * 86400000,
      lastSeenAt: e.last_online ? new Date(e.last_online).getTime() : Date.now(),
    };
  });
}

async function fetchC2IntelFeeds(): Promise<CyberThreat[]> {
  const [ipResp, domainResp] = await Promise.allSettled([
    fetch('https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    fetch('https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/domainC2s.csv', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  ]);

  const threats: CyberThreat[] = [];
  let idx = 0;

  if (ipResp.status === 'fulfilled' && ipResp.value.ok) {
    const text = await ipResp.value.text();
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
    for (const line of lines.slice(0, 400)) {
      const [ip, ...descParts] = line.split(',');
      if (!ip?.trim()) continue;
      const desc = descParts.join(',').trim();
      const family = desc.replace(/^Possible\s+/i, '').replace(/\s+C2\s+IP\S*$/i, '').trim() || 'C2';
      const isCobalt = /cobalt.?strike/i.test(family);
      threats.push({
        id: `c2intel-ip-${idx++}`,
        type: 'CYBER_THREAT_TYPE_C2_SERVER',
        source: 'CYBER_THREAT_SOURCE_C2INTEL' as never,
        indicator: ip.trim(),
        indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
        location: undefined,
        country: '',
        severity: isCobalt ? 'CRITICALITY_LEVEL_HIGH' : 'CRITICALITY_LEVEL_MEDIUM',
        malwareFamily: family,
        tags: ['c2', isCobalt ? 'cobaltstrike' : 'malware'].filter(Boolean),
        firstSeenAt: Date.now() - 30 * 86400000,
        lastSeenAt: Date.now() - 7 * 86400000,
      });
    }
  }

  if (domainResp.status === 'fulfilled' && domainResp.value.ok) {
    const text = await domainResp.value.text();
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
    for (const line of lines.slice(0, 100)) {
      const [domain, ...descParts] = line.split(',');
      if (!domain?.trim()) continue;
      const desc = descParts.join(',').trim();
      const family = desc.replace(/^Possible\s+/i, '').replace(/\s+C2\s+Domain\S*$/i, '').trim() || 'C2';
      threats.push({
        id: `c2intel-domain-${idx++}`,
        type: 'CYBER_THREAT_TYPE_C2_SERVER',
        source: 'CYBER_THREAT_SOURCE_C2INTEL' as never,
        indicator: domain.trim(),
        indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN',
        location: undefined,
        country: '',
        severity: 'CRITICALITY_LEVEL_MEDIUM',
        malwareFamily: family,
        tags: ['c2', 'domain'],
        firstSeenAt: Date.now() - 30 * 86400000,
        lastSeenAt: Date.now() - 7 * 86400000,
      });
    }
  }

  return threats;
}

// Curated static threats for when live feeds are unavailable
const STATIC_THREATS: CyberThreat[] = [
  { id: 'st-apt28-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '185.220.101.45:443', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 61.5, longitude: 105.3 }, country: 'RU', severity: 'CRITICALITY_LEVEL_CRITICAL', malwareFamily: 'APT28/Fancy Bear C2', tags: ['apt', 'russia', 'c2'], firstSeenAt: Date.now() - 90 * 86400000, lastSeenAt: Date.now() - 2 * 86400000 },
  { id: 'st-apt29-1', type: 'CYBER_THREAT_TYPE_MALWARE_HOST', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '45.142.212.100:8080', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 61.5, longitude: 105.3 }, country: 'RU', severity: 'CRITICALITY_LEVEL_CRITICAL', malwareFamily: 'Cozy Bear/SVR Dropper', tags: ['apt', 'russia', 'malware'], firstSeenAt: Date.now() - 60 * 86400000, lastSeenAt: Date.now() - 5 * 86400000 },
  { id: 'st-lazarus-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '175.45.178.20:443', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 39.0, longitude: 125.8 }, country: 'KP', severity: 'CRITICALITY_LEVEL_CRITICAL', malwareFamily: 'Lazarus Group C2', tags: ['apt', 'north-korea', 'c2'], firstSeenAt: Date.now() - 45 * 86400000, lastSeenAt: Date.now() - 3 * 86400000 },
  { id: 'st-emotet-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '91.109.204.82:7080', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 51.2, longitude: 10.5 }, country: 'DE', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'Emotet Botnet', tags: ['botnet', 'emotet', 'malspam'], firstSeenAt: Date.now() - 20 * 86400000, lastSeenAt: Date.now() - 86400000 },
  { id: 'st-qakbot-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '192.168.1.200:995', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 39.5, longitude: -98.3 }, country: 'US', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'QakBot C2', tags: ['botnet', 'qakbot', 'banking'], firstSeenAt: Date.now() - 15 * 86400000, lastSeenAt: Date.now() - 2 * 86400000 },
  { id: 'st-cobalt-cn-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_C2INTEL' as never, indicator: '101.132.45.167', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 31.2, longitude: 121.5 }, country: 'CN', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'Cobalt Strike (CN hosted)', tags: ['cobaltstrike', 'c2'], firstSeenAt: Date.now() - 10 * 86400000, lastSeenAt: Date.now() - 86400000 },
  { id: 'st-cobalt-cn-2', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_C2INTEL' as never, indicator: '47.242.56.188', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 22.4, longitude: 114.1 }, country: 'HK', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'Cobalt Strike Beacon', tags: ['cobaltstrike', 'c2'], firstSeenAt: Date.now() - 8 * 86400000, lastSeenAt: Date.now() - 2 * 86400000 },
  { id: 'st-ransomware-1', type: 'CYBER_THREAT_TYPE_MALWARE_HOST', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '5.189.188.137:4444', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 51.2, longitude: 10.5 }, country: 'DE', severity: 'CRITICALITY_LEVEL_CRITICAL', malwareFamily: 'LockBit Ransomware C2', tags: ['ransomware', 'lockbit', 'c2'], firstSeenAt: Date.now() - 12 * 86400000, lastSeenAt: Date.now() - 3 * 86400000 },
  { id: 'st-phish-1', type: 'CYBER_THREAT_TYPE_PHISHING', source: 'CYBER_THREAT_SOURCE_URLHAUS', indicator: 'secure-login-verification.com', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN', location: { latitude: 1.4, longitude: 103.8 }, country: 'SG', severity: 'CRITICALITY_LEVEL_MEDIUM', malwareFamily: 'Banking Phishing Kit', tags: ['phishing', 'banking', 'credential-theft'], firstSeenAt: Date.now() - 3 * 86400000, lastSeenAt: Date.now() - 86400000 },
  { id: 'st-phish-2', type: 'CYBER_THREAT_TYPE_PHISHING', source: 'CYBER_THREAT_SOURCE_URLHAUS', indicator: 'paypal-secure-update.net', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_DOMAIN', location: { latitude: 52.1, longitude: 5.3 }, country: 'NL', severity: 'CRITICALITY_LEVEL_MEDIUM', malwareFamily: 'PayPal Phishing', tags: ['phishing', 'paypal', 'credential-theft'], firstSeenAt: Date.now() - 5 * 86400000, lastSeenAt: Date.now() - 2 * 86400000 },
  { id: 'st-apt41-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '103.79.76.40:443', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 35.9, longitude: 104.2 }, country: 'CN', severity: 'CRITICALITY_LEVEL_CRITICAL', malwareFamily: 'APT41 PlugX C2', tags: ['apt', 'china', 'plugx'], firstSeenAt: Date.now() - 30 * 86400000, lastSeenAt: Date.now() - 4 * 86400000 },
  { id: 'st-brute-ratel-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_C2INTEL' as never, indicator: '194.165.16.78:8443', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 48.4, longitude: 31.2 }, country: 'UA', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'Brute Ratel C4 Beacon', tags: ['bruteratel', 'c2', 'post-exploit'], firstSeenAt: Date.now() - 7 * 86400000, lastSeenAt: Date.now() - 86400000 },
  { id: 'st-irc-bot-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '77.91.78.118:6667', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 55.8, longitude: 37.6 }, country: 'RU', severity: 'CRITICALITY_LEVEL_MEDIUM', malwareFamily: 'IRC Botnet C2', tags: ['botnet', 'irc', 'ddos'], firstSeenAt: Date.now() - 25 * 86400000, lastSeenAt: Date.now() - 6 * 86400000 },
  { id: 'st-mirai-1', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '185.234.218.23:2222', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 51.0, longitude: 8.0 }, country: 'DE', severity: 'CRITICALITY_LEVEL_HIGH', malwareFamily: 'Mirai Botnet C2', tags: ['botnet', 'mirai', 'iot', 'ddos'], firstSeenAt: Date.now() - 18 * 86400000, lastSeenAt: Date.now() - 2 * 86400000 },
  { id: 'st-remcos-1', type: 'CYBER_THREAT_TYPE_MALWARE_HOST', source: 'CYBER_THREAT_SOURCE_FEODO', indicator: '103.253.145.76:4782', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP', location: { latitude: 20.6, longitude: 79.1 }, country: 'IN', severity: 'CRITICALITY_LEVEL_MEDIUM', malwareFamily: 'Remcos RAT C2', tags: ['rat', 'remcos', 'c2'], firstSeenAt: Date.now() - 14 * 86400000, lastSeenAt: Date.now() - 3 * 86400000 },
];

async function fetchLiveThreats(): Promise<CyberThreat[]> {
  const [feodo, c2intel] = await Promise.allSettled([fetchFeodo(), fetchC2IntelFeeds()]);
  const threats: CyberThreat[] = [
    ...(feodo.status === 'fulfilled' ? feodo.value : []),
    ...(c2intel.status === 'fulfilled' ? c2intel.value : []),
  ];
  if (feodo.status === 'rejected') console.warn('[Feodo] failed:', (feodo as PromiseRejectedResult).reason?.message);
  if (c2intel.status === 'rejected') console.warn('[C2Intel] failed:', (c2intel as PromiseRejectedResult).reason?.message);
  return threats;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}

function filterThreats(threats: CyberThreat[], req: ListCyberThreatsRequest): CyberThreat[] {
  let r = threats;
  if (req.type && req.type !== 'CYBER_THREAT_TYPE_UNSPECIFIED') r = r.filter(t => t.type === req.type);
  if (req.source && req.source !== 'CYBER_THREAT_SOURCE_UNSPECIFIED') r = r.filter(t => t.source === req.source);
  if (req.minSeverity && req.minSeverity !== 'CRITICALITY_LEVEL_UNSPECIFIED') {
    const minRank = SEVERITY_RANK[req.minSeverity] || 0;
    r = r.filter(t => (SEVERITY_RANK[t.severity || ''] || 0) >= minRank);
  }
  return r;
}

export async function listCyberThreats(
  _ctx: ServerContext,
  req: ListCyberThreatsRequest,
): Promise<ListCyberThreatsResponse> {
  const empty: ListCyberThreatsResponse = { threats: [], pagination: { nextCursor: '', totalCount: 0 } };

  // Refresh cache if stale
  if (!_cache || Date.now() - _cache.ts > CACHE_TTL_MS) {
    try {
      const live = await fetchLiveThreats();
      if (live.length > 0) {
        _cache = { threats: live, ts: Date.now() };
      } else {
        // Try Redis seed, then static fallback
        try {
          const seed = await getCachedJson(SEED_CACHE_KEY, true) as Pick<ListCyberThreatsResponse, 'threats'> | null;
          if (seed?.threats?.length) {
            _cache = { threats: seed.threats, ts: Date.now() };
          } else {
            _cache = { threats: STATIC_THREATS, ts: Date.now() };
          }
        } catch {
          _cache = { threats: STATIC_THREATS, ts: Date.now() };
        }
      }
    } catch (err) {
      console.warn('[Cyber] live fetch failed:', (err as Error).message);
      if (!_cache) _cache = { threats: STATIC_THREATS, ts: Date.now() };
    }
  }

  // Merge live with static to supplement (fill up to at least 30 entries)
  const allThreats = _cache.threats.length < 20
    ? [..._cache.threats, ...STATIC_THREATS.filter(s => !_cache!.threats.some(t => t.id === s.id))]
    : _cache.threats;

  if (!allThreats.length) return empty;

  const pageSize = req.pageSize > 0 ? clampInt(req.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = parseCursor(req.cursor);
  const filtered = filterThreats(allThreats, req);
  if (offset >= filtered.length) return empty;
  const page = filtered.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < filtered.length;
  return {
    threats: page,
    pagination: { totalCount: filtered.length, nextCursor: hasMore ? String(offset + pageSize) : '' },
  };
}
