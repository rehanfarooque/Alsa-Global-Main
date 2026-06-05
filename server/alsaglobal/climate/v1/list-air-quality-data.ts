import type {
  ClimateServiceHandler,
  ListAirQualityDataRequest,
  ListAirQualityDataResponse,
  AirQualityStation,
  ServerContext,
} from '../../../../src/generated/server/alsaglobal/climate/v1/service_server';

import { normalizeAirQualityFetchedAt, normalizeAirQualityStations } from '../../../_shared/air-quality-stations';
import { CLIMATE_AIR_QUALITY_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const WAQI_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache: { stations: AirQualityStation[]; ts: number } | null = null;

// Major global cities with typical seasonal AQI ranges (realistic approximation)
const MAJOR_CITIES: Array<{ city: string; countryCode: string; lat: number; lng: number; waqiSlug: string }> = [
  { city: 'Delhi', countryCode: 'IN', lat: 28.65, lng: 77.23, waqiSlug: 'delhi' },
  { city: 'Lahore', countryCode: 'PK', lat: 31.55, lng: 74.34, waqiSlug: 'lahore' },
  { city: 'Dhaka', countryCode: 'BD', lat: 23.81, lng: 90.41, waqiSlug: 'dhaka' },
  { city: 'Beijing', countryCode: 'CN', lat: 39.90, lng: 116.41, waqiSlug: 'beijing' },
  { city: 'Shanghai', countryCode: 'CN', lat: 31.23, lng: 121.47, waqiSlug: 'shanghai' },
  { city: 'Karachi', countryCode: 'PK', lat: 24.86, lng: 67.01, waqiSlug: 'karachi' },
  { city: 'Jakarta', countryCode: 'ID', lat: -6.21, lng: 106.85, waqiSlug: 'jakarta' },
  { city: 'Cairo', countryCode: 'EG', lat: 30.06, lng: 31.25, waqiSlug: 'cairo' },
  { city: 'Mumbai', countryCode: 'IN', lat: 19.08, lng: 72.88, waqiSlug: 'mumbai' },
  { city: 'Bangkok', countryCode: 'TH', lat: 13.75, lng: 100.52, waqiSlug: 'bangkok' },
  { city: 'Istanbul', countryCode: 'TR', lat: 41.01, lng: 28.96, waqiSlug: 'istanbul' },
  { city: 'London', countryCode: 'GB', lat: 51.51, lng: -0.13, waqiSlug: 'london' },
  { city: 'New York', countryCode: 'US', lat: 40.71, lng: -74.01, waqiSlug: 'new-york' },
  { city: 'Los Angeles', countryCode: 'US', lat: 34.05, lng: -118.24, waqiSlug: 'los-angeles' },
  { city: 'Paris', countryCode: 'FR', lat: 48.86, lng: 2.35, waqiSlug: 'paris' },
  { city: 'Tokyo', countryCode: 'JP', lat: 35.69, lng: 139.69, waqiSlug: 'tokyo' },
  { city: 'São Paulo', countryCode: 'BR', lat: -23.55, lng: -46.63, waqiSlug: 'sao-paulo' },
  { city: 'Moscow', countryCode: 'RU', lat: 55.75, lng: 37.62, waqiSlug: 'moscow' },
  { city: 'Riyadh', countryCode: 'SA', lat: 24.69, lng: 46.72, waqiSlug: 'riyadh' },
  { city: 'Tehran', countryCode: 'IR', lat: 35.69, lng: 51.39, waqiSlug: 'tehran' },
];

function aqiToRisk(aqi: number): string {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very-unhealthy';
  return 'hazardous';
}

async function fetchWAQI(apiKey: string): Promise<AirQualityStation[]> {
  const results = await Promise.allSettled(
    MAJOR_CITIES.map(async (c) => {
      const url = `https://api.waqi.info/feed/${c.waqiSlug}/?token=${apiKey}`;
      const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(WAQI_TIMEOUT_MS) });
      if (!resp.ok) return null;
      const d = await resp.json() as { status: string; data?: { aqi: number; iaqi?: { pm25?: { v: number } }; time?: { iso: string } } };
      if (d.status !== 'ok' || !d.data) return null;
      const aqi = d.data.aqi;
      if (!isFinite(aqi) || aqi < 0) return null;
      return {
        city: c.city,
        countryCode: c.countryCode,
        lat: c.lat,
        lng: c.lng,
        pm25: d.data.iaqi?.pm25?.v ?? Math.round(aqi * 0.7),
        aqi,
        riskLevel: aqiToRisk(aqi),
        pollutant: 'PM2.5',
        measuredAt: d.data.time?.iso ? new Date(d.data.time.iso).getTime() : Date.now(),
        source: 'WAQI',
      } as AirQualityStation;
    }),
  );
  return results.filter((r): r is PromiseFulfilledResult<AirQualityStation> => r.status === 'fulfilled' && r.value !== null).map(r => r.value);
}

// Static fallback with typical AQI values for major cities
const STATIC_STATIONS: AirQualityStation[] = [
  { city: 'Delhi', countryCode: 'IN', lat: 28.65, lng: 77.23, pm25: 85, aqi: 165, riskLevel: 'unhealthy', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Lahore', countryCode: 'PK', lat: 31.55, lng: 74.34, pm25: 95, aqi: 175, riskLevel: 'unhealthy', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Dhaka', countryCode: 'BD', lat: 23.81, lng: 90.41, pm25: 70, aqi: 155, riskLevel: 'unhealthy', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Beijing', countryCode: 'CN', lat: 39.90, lng: 116.41, pm25: 45, aqi: 120, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Shanghai', countryCode: 'CN', lat: 31.23, lng: 121.47, pm25: 35, aqi: 95, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Karachi', countryCode: 'PK', lat: 24.86, lng: 67.01, pm25: 65, aqi: 145, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Jakarta', countryCode: 'ID', lat: -6.21, lng: 106.85, pm25: 50, aqi: 130, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Cairo', countryCode: 'EG', lat: 30.06, lng: 31.25, pm25: 55, aqi: 135, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Mumbai', countryCode: 'IN', lat: 19.08, lng: 72.88, pm25: 55, aqi: 135, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Bangkok', countryCode: 'TH', lat: 13.75, lng: 100.52, pm25: 40, aqi: 105, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Istanbul', countryCode: 'TR', lat: 41.01, lng: 28.96, pm25: 25, aqi: 72, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'London', countryCode: 'GB', lat: 51.51, lng: -0.13, pm25: 12, aqi: 48, riskLevel: 'good', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'New York', countryCode: 'US', lat: 40.71, lng: -74.01, pm25: 15, aqi: 52, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Los Angeles', countryCode: 'US', lat: 34.05, lng: -118.24, pm25: 22, aqi: 68, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Paris', countryCode: 'FR', lat: 48.86, lng: 2.35, pm25: 14, aqi: 50, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Tokyo', countryCode: 'JP', lat: 35.69, lng: 139.69, pm25: 16, aqi: 55, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'São Paulo', countryCode: 'BR', lat: -23.55, lng: -46.63, pm25: 28, aqi: 82, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Moscow', countryCode: 'RU', lat: 55.75, lng: 37.62, pm25: 18, aqi: 62, riskLevel: 'moderate', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Riyadh', countryCode: 'SA', lat: 24.69, lng: 46.72, pm25: 60, aqi: 142, riskLevel: 'sensitive', pollutant: 'PM10', measuredAt: Date.now() - 3600000, source: 'Estimate' },
  { city: 'Tehran', countryCode: 'IR', lat: 35.69, lng: 51.39, pm25: 48, aqi: 125, riskLevel: 'sensitive', pollutant: 'PM2.5', measuredAt: Date.now() - 3600000, source: 'Estimate' },
];

export const listAirQualityData: ClimateServiceHandler['listAirQualityData'] = async (
  _ctx: ServerContext,
  _req: ListAirQualityDataRequest,
): Promise<ListAirQualityDataResponse> => {
  // Try Redis seed first
  const payload = (await getCachedJson(CLIMATE_AIR_QUALITY_KEY, true)) as Record<string, unknown> | null;
  const sourceStations = payload?.stations ?? payload?.alerts;
  const redisStations = normalizeAirQualityStations(sourceStations);
  if (redisStations.length > 0) {
    return { stations: redisStations, fetchedAt: normalizeAirQualityFetchedAt(payload) };
  }

  // Try WAQI if token is set
  const waqiToken = process.env.WAQI_TOKEN;
  if (waqiToken && (!_cache || Date.now() - _cache.ts > CACHE_TTL_MS)) {
    try {
      const stations = await fetchWAQI(waqiToken);
      if (stations.length > 0) {
        _cache = { stations, ts: Date.now() };
        return { stations, fetchedAt: Date.now() };
      }
    } catch (err) {
      console.warn('[WAQI] fetch failed:', (err as Error).message);
    }
  }

  if (_cache && _cache.stations.length > 0) {
    return { stations: _cache.stations, fetchedAt: _cache.ts };
  }

  // Static fallback
  return { stations: STATIC_STATIONS, fetchedAt: Date.now() };
};
