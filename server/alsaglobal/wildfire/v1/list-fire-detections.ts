/**
 * AlsaGlobal: ListFireDetections — NASA FIRMS API direct.
 * Uses MODIS_NRT (near real-time) or VIIRS_NOAA20_NRT satellite data.
 * MAP_KEY from NASA_FIRMS_API_KEY env.
 */

import type {
  WildfireServiceHandler,
  ServerContext,
  ListFireDetectionsRequest,
  ListFireDetectionsResponse,
  FireDetection,
  FireConfidence,
} from '../../../../src/generated/server/alsaglobal/wildfire/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';

const FIRMS_TIMEOUT_MS = 15_000;
const MAX_FIRE_POINTS = 2_000;

function parseConfidence(raw: string, source: 'MODIS' | 'VIIRS'): FireConfidence {
  if (source === 'VIIRS') {
    if (raw === 'h') return 'FIRE_CONFIDENCE_HIGH';
    if (raw === 'n') return 'FIRE_CONFIDENCE_NOMINAL';
    return 'FIRE_CONFIDENCE_LOW';
  }
  const n = parseInt(raw, 10);
  if (n >= 80) return 'FIRE_CONFIDENCE_HIGH';
  if (n >= 30) return 'FIRE_CONFIDENCE_NOMINAL';
  return 'FIRE_CONFIDENCE_LOW';
}

async function fetchFirmsData(
  mapKey: string,
  source: 'MODIS_NRT' | 'VIIRS_NOAA20_NRT',
  days: number,
): Promise<FireDetection[]> {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/world/${days}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(FIRMS_TIMEOUT_MS),
  });
  if (!resp.ok) {
    console.warn(`[FIRMS] ${source} HTTP ${resp.status}`);
    return [];
  }

  const csv = await resp.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header to find column indices
  const header = lines[0]!.toLowerCase().split(',');
  const ci = (name: string) => header.indexOf(name);

  const latIdx = ci('latitude');
  const lonIdx = ci('longitude');
  const brightIdx = ci('brightness') >= 0 ? ci('brightness') : ci('bright_ti4') >= 0 ? ci('bright_ti4') : ci('bright_ti5');
  const frpIdx = ci('frp');
  const confIdx = ci('confidence');
  const satIdx = ci('satellite');
  const dateIdx = ci('acq_date');
  const timeIdx = ci('acq_time');
  const dayNightIdx = ci('daynight');

  if (latIdx < 0 || lonIdx < 0) return [];

  const isViirs = source.startsWith('VIIRS');
  const detections: FireDetection[] = [];

  for (let i = 1; i < Math.min(lines.length, MAX_FIRE_POINTS + 1); i++) {
    const cols = lines[i]!.split(',');
    const lat = parseFloat(cols[latIdx] ?? '');
    const lon = parseFloat(cols[lonIdx] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const brightness = frpIdx >= 0 ? parseFloat(cols[brightIdx] ?? '0') : 0;
    const frp = frpIdx >= 0 ? parseFloat(cols[frpIdx] ?? '0') : 0;
    const confRaw = confIdx >= 0 ? (cols[confIdx] ?? '').trim() : '';
    const satellite = satIdx >= 0 ? (cols[satIdx] ?? '') : source;
    const dayNight = dayNightIdx >= 0 ? (cols[dayNightIdx] ?? 'D') : 'D';

    let detectedAt = Date.now();
    if (dateIdx >= 0 && timeIdx >= 0) {
      const dateStr = (cols[dateIdx] ?? '').trim();
      const timeStr = (cols[timeIdx] ?? '').trim().padStart(4, '0');
      const hours = timeStr.slice(0, 2);
      const mins = timeStr.slice(2, 4);
      const d = new Date(`${dateStr}T${hours}:${mins}:00Z`);
      if (!isNaN(d.getTime())) detectedAt = d.getTime();
    }

    detections.push({
      id: `${source}-${i}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
      location: { latitude: lat, longitude: lon },
      brightness: Number.isFinite(brightness) ? brightness : 0,
      frp: Number.isFinite(frp) ? frp : 0,
      confidence: parseConfidence(confRaw, isViirs ? 'VIIRS' : 'MODIS'),
      satellite: satellite.trim(),
      detectedAt,
      region: '',
      dayNight: dayNight.trim(),
      possibleExplosion: false,
    });
  }

  return detections;
}

export const listFireDetections: WildfireServiceHandler['listFireDetections'] = async (
  _ctx: ServerContext,
  req: ListFireDetectionsRequest,
): Promise<ListFireDetectionsResponse> => {
  const mapKey = process.env.NASA_FIRMS_API_KEY;
  if (!mapKey) {
    console.warn('[FIRMS] NASA_FIRMS_API_KEY not set');
    return { fireDetections: [], pagination: undefined };
  }

  const days = 1;

  try {
    // Try VIIRS first (higher resolution), fall back to MODIS
    let detections = await fetchFirmsData(mapKey, 'VIIRS_NOAA20_NRT', days);
    if (!detections.length) {
      detections = await fetchFirmsData(mapKey, 'MODIS_NRT', days);
    }

    const pageSize = req.pageSize > 0 ? req.pageSize : MAX_FIRE_POINTS;
    const cursor = req.cursor ? parseInt(req.cursor, 10) || 0 : 0;
    const page = detections.slice(cursor, cursor + pageSize);
    const hasMore = cursor + pageSize < detections.length;

    return {
      fireDetections: page,
      pagination: {
        nextCursor: hasMore ? String(cursor + pageSize) : '',
        totalCount: detections.length,
      },
    };
  } catch (err) {
    console.warn('[FIRMS] fetch failed:', (err as Error).message);
    return { fireDetections: [], pagination: undefined };
  }
};
