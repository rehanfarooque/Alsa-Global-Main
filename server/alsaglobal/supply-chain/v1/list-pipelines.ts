import { getCachedJson } from '../../../_shared/redis';
import { PIPELINES_GAS_KEY, PIPELINES_OIL_KEY } from '../../../_shared/cache-keys';
import type {
  ListPipelinesRequest,
  ListPipelinesResponse,
  PipelineEntry,
} from '../../../../src/generated/server/alsaglobal/supply_chain/v1/service_server';
import { derivePublicBadge } from './_pipeline-evidence';
import { pickNewerClassifierVersion, pickNewerIsoTimestamp } from '../../../../src/shared/pipeline-evidence';

/**
 * Shape of the JSON emitted by scripts/seed-pipelines-{gas,oil}.mjs.
 * Kept loose (`unknown`) at the seam because Upstash returns `unknown`;
 * the projection function below narrows it to the proto shape.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  pipelines?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceLatLon(v: unknown): { lat: number; lon: number } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    return { lat: coerceNumber(obj.lat), lon: coerceNumber(obj.lon) };
  }
  return { lat: 0, lon: 0 };
}

export function projectPipeline(raw: unknown): PipelineEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const evidence = (r.evidence ?? null) as Record<string, unknown> | null;
  const operatorStatement =
    evidence && typeof evidence.operatorStatement === 'object' && evidence.operatorStatement
      ? {
          text: coerceString((evidence.operatorStatement as Record<string, unknown>).text),
          url: coerceString((evidence.operatorStatement as Record<string, unknown>).url),
          date: coerceString((evidence.operatorStatement as Record<string, unknown>).date),
        }
      : undefined;
  const sanctionRefs = Array.isArray(evidence?.sanctionRefs)
    ? (evidence.sanctionRefs as unknown[]).map(s => {
        const ref = (s ?? {}) as Record<string, unknown>;
        return {
          authority: coerceString(ref.authority),
          listId: coerceString(ref.listId),
          date: coerceString(ref.date),
          url: coerceString(ref.url),
        };
      })
    : [];

  const ev = evidence
    ? {
        physicalState: coerceString(evidence.physicalState, 'unknown'),
        physicalStateSource: coerceString(evidence.physicalStateSource, 'operator'),
        operatorStatement,
        commercialState: coerceString(evidence.commercialState, 'unknown'),
        sanctionRefs,
        lastEvidenceUpdate: coerceString(evidence.lastEvidenceUpdate),
        classifierVersion: coerceString(evidence.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(evidence.classifierConfidence, 0),
      }
    : undefined;

  const publicBadge = derivePublicBadge(ev);

  const waypoints = Array.isArray(r.waypoints)
    ? (r.waypoints as unknown[]).map(coerceLatLon)
    : [];

  return {
    id: coerceString(r.id),
    name: coerceString(r.name),
    operator: coerceString(r.operator),
    commodityType: coerceString(r.commodityType),
    fromCountry: coerceString(r.fromCountry),
    toCountry: coerceString(r.toCountry),
    transitCountries: Array.isArray(r.transitCountries)
      ? (r.transitCountries as unknown[]).map(t => coerceString(t))
      : [],
    capacityBcmYr: coerceNumber(r.capacityBcmYr),
    capacityMbd: coerceNumber(r.capacityMbd),
    lengthKm: coerceNumber(r.lengthKm),
    inService: coerceNumber(r.inService),
    startPoint: coerceLatLon(r.startPoint),
    endPoint: coerceLatLon(r.endPoint),
    waypoints,
    evidence: ev,
    publicBadge,
  };
}

function collect(raw: RawRegistry | null): PipelineEntry[] {
  if (!raw?.pipelines) return [];
  return Object.values(raw.pipelines)
    .map(projectPipeline)
    .filter((p): p is PipelineEntry => p != null);
}

// Built-in static pipeline entries shown when Redis seed is absent.
// Sources: operator reports, ENTSOG, EIA, IEA. Last reviewed 2025-Q4.
const BUILTIN_PIPELINES: PipelineEntry[] = [
  {
    id: 'pl-taps',
    name: 'Trans-Alaska Pipeline System',
    operator: 'Alyeska Pipeline Service',
    commodityType: 'oil',
    fromCountry: 'US',
    toCountry: 'US',
    transitCountries: ['US'],
    capacityBcmYr: 0,
    capacityMbd: 0.52,
    lengthKm: 1287,
    inService: 1977,
    startPoint: { lat: 70.3, lon: -148.5 },
    endPoint: { lat: 61.1, lon: -146.4 },
    waypoints: [],
    publicBadge: 'flowing',
  },
  {
    id: 'pl-keystone',
    name: 'Keystone Pipeline',
    operator: 'TC Energy',
    commodityType: 'oil',
    fromCountry: 'CA',
    toCountry: 'US',
    transitCountries: ['CA', 'US'],
    capacityBcmYr: 0,
    capacityMbd: 0.83,
    lengthKm: 4324,
    inService: 2010,
    startPoint: { lat: 53.5, lon: -110.0 },
    endPoint: { lat: 38.1, lon: -92.3 },
    waypoints: [{ lat: 49.0, lon: -100.0 }],
    publicBadge: 'flowing',
  },
  {
    id: 'pl-druzhba',
    name: 'Druzhba Pipeline',
    operator: 'Transneft',
    commodityType: 'oil',
    fromCountry: 'RU',
    toCountry: 'DE',
    transitCountries: ['RU', 'BY', 'PL', 'DE', 'SK', 'HU', 'CZ'],
    capacityBcmYr: 0,
    capacityMbd: 1.2,
    lengthKm: 5500,
    inService: 1964,
    startPoint: { lat: 55.7, lon: 49.0 },
    endPoint: { lat: 51.8, lon: 12.4 },
    waypoints: [{ lat: 53.9, lon: 27.6 }, { lat: 52.2, lon: 21.0 }],
    publicBadge: 'reduced',
  },
  {
    id: 'pl-turkstream',
    name: 'TurkStream',
    operator: 'South Stream Transport',
    commodityType: 'gas',
    fromCountry: 'RU',
    toCountry: 'TR',
    transitCountries: ['RU', 'TR'],
    capacityBcmYr: 31.5,
    capacityMbd: 0,
    lengthKm: 930,
    inService: 2020,
    startPoint: { lat: 43.7, lon: 38.2 },
    endPoint: { lat: 41.5, lon: 28.0 },
    waypoints: [],
    publicBadge: 'flowing',
  },
  {
    id: 'pl-tanap',
    name: 'Trans-Anatolian Pipeline (TANAP)',
    operator: 'BOTAŞ / SOCAR',
    commodityType: 'gas',
    fromCountry: 'AZ',
    toCountry: 'TR',
    transitCountries: ['AZ', 'GE', 'TR'],
    capacityBcmYr: 16,
    capacityMbd: 0,
    lengthKm: 1850,
    inService: 2018,
    startPoint: { lat: 41.7, lon: 46.6 },
    endPoint: { lat: 41.8, lon: 26.7 },
    waypoints: [{ lat: 41.7, lon: 43.4 }],
    publicBadge: 'flowing',
  },
  {
    id: 'pl-tap',
    name: 'Trans Adriatic Pipeline (TAP)',
    operator: 'TAP AG',
    commodityType: 'gas',
    fromCountry: 'TR',
    toCountry: 'IT',
    transitCountries: ['TR', 'GR', 'AL', 'IT'],
    capacityBcmYr: 10,
    capacityMbd: 0,
    lengthKm: 878,
    inService: 2020,
    startPoint: { lat: 41.8, lon: 26.7 },
    endPoint: { lat: 40.5, lon: 18.3 },
    waypoints: [{ lat: 41.1, lon: 23.7 }, { lat: 41.3, lon: 20.0 }],
    publicBadge: 'flowing',
  },
  {
    id: 'pl-nord-stream-1',
    name: 'Nord Stream 1',
    operator: 'Nord Stream AG',
    commodityType: 'gas',
    fromCountry: 'RU',
    toCountry: 'DE',
    transitCountries: ['RU', 'DE'],
    capacityBcmYr: 55,
    capacityMbd: 0,
    lengthKm: 1224,
    inService: 2011,
    startPoint: { lat: 59.9, lon: 29.1 },
    endPoint: { lat: 54.1, lon: 13.6 },
    waypoints: [{ lat: 57.5, lon: 19.0 }],
    publicBadge: 'offline',
  },
  {
    id: 'pl-nord-stream-2',
    name: 'Nord Stream 2',
    operator: 'Nord Stream 2 AG',
    commodityType: 'gas',
    fromCountry: 'RU',
    toCountry: 'DE',
    transitCountries: ['RU', 'DE'],
    capacityBcmYr: 55,
    capacityMbd: 0,
    lengthKm: 1230,
    inService: 0,
    startPoint: { lat: 59.9, lon: 29.1 },
    endPoint: { lat: 54.1, lon: 13.6 },
    waypoints: [{ lat: 57.5, lon: 19.0 }],
    publicBadge: 'offline',
  },
  {
    id: 'pl-yamal-europe',
    name: 'Yamal-Europe Pipeline',
    operator: 'EuropolGaz / Gazprom',
    commodityType: 'gas',
    fromCountry: 'RU',
    toCountry: 'DE',
    transitCountries: ['RU', 'BY', 'PL', 'DE'],
    capacityBcmYr: 33,
    capacityMbd: 0,
    lengthKm: 2000,
    inService: 1999,
    startPoint: { lat: 67.0, lon: 74.5 },
    endPoint: { lat: 52.5, lon: 13.4 },
    waypoints: [{ lat: 54.0, lon: 27.6 }, { lat: 52.2, lon: 21.0 }],
    publicBadge: 'offline',
  },
  {
    id: 'pl-sco',
    name: 'Southern Gas Corridor (SGC)',
    operator: 'BP / SOCAR / Total',
    commodityType: 'gas',
    fromCountry: 'AZ',
    toCountry: 'IT',
    transitCountries: ['AZ', 'GE', 'TR', 'GR', 'AL', 'IT'],
    capacityBcmYr: 10,
    capacityMbd: 0,
    lengthKm: 3500,
    inService: 2020,
    startPoint: { lat: 40.5, lon: 49.9 },
    endPoint: { lat: 40.5, lon: 18.3 },
    waypoints: [{ lat: 41.7, lon: 43.4 }, { lat: 41.8, lon: 26.7 }, { lat: 41.1, lon: 23.7 }],
    publicBadge: 'flowing',
  },
];

export async function listPipelines(
  _ctx: unknown,
  req: ListPipelinesRequest,
): Promise<ListPipelinesResponse> {
  const wantGas = !req.commodityType || req.commodityType === 'gas';
  const wantOil = !req.commodityType || req.commodityType === 'oil';

  const [gasRaw, oilRaw] = await Promise.all([
    wantGas ? getCachedJson(PIPELINES_GAS_KEY) as Promise<RawRegistry | null> : Promise.resolve(null),
    wantOil ? getCachedJson(PIPELINES_OIL_KEY) as Promise<RawRegistry | null> : Promise.resolve(null),
  ]);

  const anyRequested = wantGas || wantOil;
  const anyReturned = (wantGas && gasRaw) || (wantOil && oilRaw);
  if (anyRequested && !anyReturned) {
    const pipelines = BUILTIN_PIPELINES.filter(p =>
      (!req.commodityType) || p.commodityType === req.commodityType
    );
    return {
      pipelines,
      fetchedAt: new Date().toISOString(),
      classifierVersion: 'v1-builtin',
      upstreamUnavailable: false,
    };
  }

  const pipelines = [...collect(gasRaw), ...collect(oilRaw)];

  // Pick the newest classifier version present across the registries. Gas
  // and oil are now seeded by separate Railway cron processes, so a
  // mixed-version window (gas=v2, oil=v1) during rollouts is a real expected
  // state — must actually compare, not prefer one side. Same logic for
  // fetchedAt: the newer seeder cycle is the accurate "last refresh" signal.
  const classifierVersion = pickNewerClassifierVersion(
    gasRaw?.classifierVersion,
    oilRaw?.classifierVersion,
  );
  const fetchedAt = pickNewerIsoTimestamp(gasRaw?.updatedAt, oilRaw?.updatedAt)
    || new Date().toISOString();

  return {
    pipelines,
    fetchedAt,
    classifierVersion,
    upstreamUnavailable: false,
  };
}
