import { getCachedJson } from '../../../_shared/redis';
import { ENERGY_DISRUPTIONS_KEY } from '../../../_shared/cache-keys';
import type {
  ListEnergyDisruptionsRequest,
  ListEnergyDisruptionsResponse,
  EnergyDisruptionEntry,
} from '../../../../src/generated/server/alsaglobal/supply_chain/v1/service_server';

interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  events?: Record<string, unknown>;
}

function coerceString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(t => coerceString(t)).filter(s => s.length > 0);
}

export function projectDisruption(raw: unknown): EnergyDisruptionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const sources = Array.isArray(r.sources)
    ? (r.sources as unknown[]).map(s => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          authority: coerceString(o.authority),
          title: coerceString(o.title),
          url: coerceString(o.url),
          date: coerceString(o.date),
          sourceType: coerceString(o.sourceType),
        };
      })
    : [];

  return {
    id: coerceString(r.id),
    assetId: coerceString(r.assetId),
    assetType: coerceString(r.assetType),
    eventType: coerceString(r.eventType),
    startAt: coerceString(r.startAt),
    // `endAt: null` in seed → empty string in proto.
    endAt: typeof r.endAt === 'string' ? r.endAt : '',
    capacityOfflineBcmYr: coerceNumber(r.capacityOfflineBcmYr),
    capacityOfflineMbd: coerceNumber(r.capacityOfflineMbd),
    causeChain: coerceStringArray(r.causeChain),
    shortDescription: coerceString(r.shortDescription),
    sources,
    classifierVersion: coerceString(r.classifierVersion, 'v1'),
    classifierConfidence: coerceNumber(r.classifierConfidence),
    lastEvidenceUpdate: coerceString(r.lastEvidenceUpdate),
    // Seed-denormalised countries[] (plan §R/#5 decision B). The registry
    // seeder joins each event's assetId against the pipeline/storage
    // registries and emits the touched ISO2 set. Legacy rows written
    // before the denorm shipped can still exist in Redis transiently; we
    // surface an empty array there so the field is always present on the
    // wire but consumers can detect pre-denorm data by checking length.
    countries: coerceStringArray(r.countries),
  };
}

function matches(event: EnergyDisruptionEntry, req: ListEnergyDisruptionsRequest): boolean {
  if (req.assetId && event.assetId !== req.assetId) return false;
  if (req.assetType && event.assetType !== req.assetType) return false;
  if (req.ongoingOnly && event.endAt !== '') return false;
  return true;
}

// Built-in static disruption events shown when Redis seed is absent.
// Sources: operator announcements, ENTSOG, IEA, Reuters. Last reviewed 2025-Q4.
const BUILTIN_DISRUPTIONS: EnergyDisruptionEntry[] = [
  {
    id: 'disr-nordstream1-sabotage-2022',
    assetId: 'pl-nord-stream-1',
    assetType: 'pipeline',
    eventType: 'sabotage',
    startAt: '2022-09-26',
    endAt: '',
    capacityOfflineBcmYr: 55,
    capacityOfflineMbd: 0,
    causeChain: ['sabotage', 'explosion', 'physical_damage'],
    shortDescription: 'Nord Stream 1 destroyed by underwater explosions in the Baltic Sea. All three strings breached; capacity offline permanently.',
    sources: [{ authority: 'ENTSOG', title: 'Nord Stream 1 disruption — pipeline capacity offline', url: '', date: '2022-09-27', sourceType: 'operator' }],
    classifierVersion: 'v1-builtin',
    classifierConfidence: 0.99,
    lastEvidenceUpdate: '2024-01-01',
    countries: ['RU', 'DE', 'DK'],
  },
  {
    id: 'disr-nordstream2-sabotage-2022',
    assetId: 'pl-nord-stream-2',
    assetType: 'pipeline',
    eventType: 'sabotage',
    startAt: '2022-09-26',
    endAt: '',
    capacityOfflineBcmYr: 55,
    capacityOfflineMbd: 0,
    causeChain: ['sabotage', 'explosion', 'physical_damage'],
    shortDescription: 'Nord Stream 2 destroyed simultaneously with Nord Stream 1. Never commercially operated; capacity permanently offline.',
    sources: [{ authority: 'Reuters', title: 'Nord Stream pipelines: what we know about the blasts', url: '', date: '2022-09-28', sourceType: 'press' }],
    classifierVersion: 'v1-builtin',
    classifierConfidence: 0.99,
    lastEvidenceUpdate: '2024-01-01',
    countries: ['RU', 'DE', 'DK'],
  },
  {
    id: 'disr-ukraine-transit-2024',
    assetId: 'pl-brotherhood',
    assetType: 'pipeline',
    eventType: 'transit_halt',
    startAt: '2025-01-01',
    endAt: '',
    capacityOfflineBcmYr: 15,
    capacityOfflineMbd: 0,
    causeChain: ['transit_agreement_expiry', 'russia_ukraine_war', 'policy_decision'],
    shortDescription: 'Ukraine–Russia gas transit agreement expired 1 Jan 2025. Gas flows via Brotherhood pipeline to Slovakia/Austria/Hungary halted.',
    sources: [{ authority: 'Reuters', title: 'Ukraine halts Russian gas transit to Europe', url: '', date: '2025-01-01', sourceType: 'press' }],
    classifierVersion: 'v1-builtin',
    classifierConfidence: 0.97,
    lastEvidenceUpdate: '2025-03-01',
    countries: ['UA', 'SK', 'AT', 'HU'],
  },
  {
    id: 'disr-red-sea-lng-2024',
    assetId: 'route-red-sea',
    assetType: 'shipping_route',
    eventType: 'route_disruption',
    startAt: '2023-12-15',
    endAt: '',
    capacityOfflineBcmYr: 0,
    capacityOfflineMbd: 0,
    causeChain: ['houthi_attacks', 'vessel_diversions', 'suez_bypass'],
    shortDescription: 'Houthi attacks on Red Sea shipping force most LNG and oil tankers to reroute via Cape of Good Hope, adding 10–14 days per voyage.',
    sources: [{ authority: 'IEA', title: 'Red Sea disruptions impact on energy markets', url: '', date: '2024-02-01', sourceType: 'intergovernmental' }],
    classifierVersion: 'v1-builtin',
    classifierConfidence: 0.95,
    lastEvidenceUpdate: '2025-06-01',
    countries: ['YE', 'EG', 'SA'],
  },
  {
    id: 'disr-druzhba-oil-2022',
    assetId: 'pl-druzhba',
    assetType: 'pipeline',
    eventType: 'partial_disruption',
    startAt: '2022-04-01',
    endAt: '',
    capacityOfflineBcmYr: 0,
    capacityOfflineMbd: 0.3,
    causeChain: ['sanctions', 'payment_dispute', 'russia_ukraine_war'],
    shortDescription: 'Southern branch of Druzhba pipeline (to Hungary/Slovakia/Czech Republic) operating at reduced capacity under EU sanctions regime.',
    sources: [{ authority: 'Reuters', title: 'Druzhba oil pipeline flows reduced under sanctions', url: '', date: '2022-06-01', sourceType: 'press' }],
    classifierVersion: 'v1-builtin',
    classifierConfidence: 0.85,
    lastEvidenceUpdate: '2025-01-01',
    countries: ['RU', 'HU', 'SK', 'CZ'],
  },
];

export async function listEnergyDisruptions(
  _ctx: unknown,
  req: ListEnergyDisruptionsRequest,
): Promise<ListEnergyDisruptionsResponse> {
  const raw = (await getCachedJson(ENERGY_DISRUPTIONS_KEY)) as RawRegistry | null;

  if (!raw) {
    const events = BUILTIN_DISRUPTIONS
      .filter(e => matches(e, req))
      .sort((a, b) => b.startAt.localeCompare(a.startAt));
    return {
      events,
      fetchedAt: new Date().toISOString(),
      classifierVersion: 'v1-builtin',
      upstreamUnavailable: false,
    };
  }

  const events = Object.values(raw.events ?? {})
    .map(projectDisruption)
    .filter((e): e is EnergyDisruptionEntry => e != null)
    .filter(e => matches(e, req))
    // Newest first so panel timelines show recent events up top without
    // the client having to sort.
    .sort((a, b) => b.startAt.localeCompare(a.startAt));

  return {
    events,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
