import { getCachedJson } from '../../../_shared/redis';
import { STORAGE_FACILITIES_KEY } from '../../../_shared/cache-keys';
import type {
  ListStorageFacilitiesRequest,
  ListStorageFacilitiesResponse,
  StorageFacilityEntry,
} from '../../../../src/generated/server/alsaglobal/supply_chain/v1/service_server';
import { deriveStorageBadge } from './_storage-evidence';

/**
 * Shape of the JSON emitted by scripts/seed-storage-facilities.mjs.
 * Kept loose at the seam (Upstash returns `unknown`); the projection
 * function below narrows to the proto shape.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  facilities?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceBoolean(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function coerceLatLon(v: unknown): { lat: number; lon: number } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    return { lat: coerceNumber(obj.lat), lon: coerceNumber(obj.lon) };
  }
  return { lat: 0, lon: 0 };
}

export function projectStorageFacility(raw: unknown): StorageFacilityEntry | null {
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
        fillDisclosed: coerceBoolean(evidence.fillDisclosed),
        fillSource: coerceString(evidence.fillSource),
        lastEvidenceUpdate: coerceString(evidence.lastEvidenceUpdate),
        classifierVersion: coerceString(evidence.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(evidence.classifierConfidence, 0),
      }
    : undefined;

  const publicBadge = deriveStorageBadge(ev);

  return {
    id: coerceString(r.id),
    name: coerceString(r.name),
    operator: coerceString(r.operator),
    facilityType: coerceString(r.facilityType),
    country: coerceString(r.country),
    location: coerceLatLon(r.location),
    capacityTwh: coerceNumber(r.capacityTwh),
    capacityMb: coerceNumber(r.capacityMb),
    capacityMtpa: coerceNumber(r.capacityMtpa),
    workingCapacityUnit: coerceString(r.workingCapacityUnit),
    inService: coerceNumber(r.inService),
    evidence: ev,
    publicBadge,
  };
}

function collect(raw: RawRegistry | null, filterType: string): StorageFacilityEntry[] {
  if (!raw?.facilities) return [];
  const entries = Object.values(raw.facilities)
    .map(projectStorageFacility)
    .filter((f): f is StorageFacilityEntry => f != null);
  if (!filterType) return entries;
  return entries.filter(f => f.facilityType === filterType);
}

// Built-in static facilities shown when Redis seed is absent.
// Sources: EIA, IEA, ENTSOG, company reports. Last reviewed 2025-Q4.
const BUILTIN_FACILITIES: StorageFacilityEntry[] = [
  {
    id: 'sf-us-spr-bryanbig',
    name: 'US Strategic Petroleum Reserve — Bryan Mound',
    operator: 'US Dept of Energy',
    facilityType: 'crude_oil_spr',
    country: 'US',
    location: { lat: 29.1, lon: -95.5 },
    capacityTwh: 0,
    capacityMb: 247,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 1978,
    publicBadge: 'operational',
  },
  {
    id: 'sf-us-spr-bighil',
    name: 'US Strategic Petroleum Reserve — Big Hill',
    operator: 'US Dept of Energy',
    facilityType: 'crude_oil_spr',
    country: 'US',
    location: { lat: 30.0, lon: -94.1 },
    capacityTwh: 0,
    capacityMb: 170,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 1980,
    publicBadge: 'operational',
  },
  {
    id: 'sf-us-cushing',
    name: 'Cushing, Oklahoma — Tank Farm Hub',
    operator: 'Multiple operators (Magellan, Enbridge, OPIS)',
    facilityType: 'crude_oil_storage',
    country: 'US',
    location: { lat: 35.9, lon: -96.7 },
    capacityTwh: 0,
    capacityMb: 90,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 1912,
    publicBadge: 'operational',
  },
  {
    id: 'sf-eu-rehden-gas',
    name: 'Rehden Underground Gas Storage',
    operator: 'Astora GmbH (Securing Energy)',
    facilityType: 'natural_gas_storage',
    country: 'DE',
    location: { lat: 52.5, lon: 8.5 },
    capacityTwh: 43,
    capacityMb: 0,
    capacityMtpa: 0,
    workingCapacityUnit: 'twh',
    inService: 1955,
    publicBadge: 'operational',
  },
  {
    id: 'sf-ukraine-gas-storage',
    name: 'Ukraine Underground Gas Storage System',
    operator: 'UGSF / Naftogaz',
    facilityType: 'natural_gas_storage',
    country: 'UA',
    location: { lat: 49.5, lon: 24.0 },
    capacityTwh: 310,
    capacityMb: 0,
    capacityMtpa: 0,
    workingCapacityUnit: 'twh',
    inService: 1964,
    publicBadge: 'reduced',
  },
  {
    id: 'sf-spimex-primorsk',
    name: 'Primorsk Oil Export Terminal',
    operator: 'Transneft',
    facilityType: 'crude_oil_storage',
    country: 'RU',
    location: { lat: 60.4, lon: 28.6 },
    capacityTwh: 0,
    capacityMb: 12,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 2001,
    publicBadge: 'operational',
  },
  {
    id: 'sf-ras-tanura',
    name: 'Ras Tanura Oil Terminal & Storage',
    operator: 'Saudi Aramco',
    facilityType: 'crude_oil_storage',
    country: 'SA',
    location: { lat: 26.6, lon: 50.1 },
    capacityTwh: 0,
    capacityMb: 50,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 1945,
    publicBadge: 'operational',
  },
  {
    id: 'sf-rotterdam-oil',
    name: 'Rotterdam Oil Terminal (Europoort)',
    operator: 'Multiple (Vopak, Royal Vopak, Koole)',
    facilityType: 'crude_oil_storage',
    country: 'NL',
    location: { lat: 51.9, lon: 4.1 },
    capacityTwh: 0,
    capacityMb: 32,
    capacityMtpa: 0,
    workingCapacityUnit: 'mb',
    inService: 1958,
    publicBadge: 'operational',
  },
];

export async function listStorageFacilities(
  _ctx: unknown,
  req: ListStorageFacilitiesRequest,
): Promise<ListStorageFacilitiesResponse> {
  const raw = (await getCachedJson(STORAGE_FACILITIES_KEY)) as RawRegistry | null;

  if (!raw) {
    const filterType = req.facilityType ?? '';
    const facilities = filterType
      ? BUILTIN_FACILITIES.filter(f => f.facilityType === filterType)
      : BUILTIN_FACILITIES;
    return {
      facilities,
      fetchedAt: new Date().toISOString(),
      classifierVersion: 'v1-builtin',
      upstreamUnavailable: false,
    };
  }

  const facilities = collect(raw, req.facilityType ?? '');

  return {
    facilities,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
