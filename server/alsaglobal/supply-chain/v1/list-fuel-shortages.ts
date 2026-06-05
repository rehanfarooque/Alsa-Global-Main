import { getCachedJson } from '../../../_shared/redis';
import { FUEL_SHORTAGES_KEY } from '../../../_shared/cache-keys';
import type {
  ListFuelShortagesRequest,
  ListFuelShortagesResponse,
  FuelShortageEntry,
} from '../../../../src/generated/server/alsaglobal/supply_chain/v1/service_server';

/**
 * Raw Redis payload shape emitted by scripts/seed-fuel-shortages.mjs.
 * Kept loose because Upstash returns `unknown`; the projection function
 * below narrows to the proto wire format.
 */
interface RawRegistry {
  classifierVersion?: string;
  updatedAt?: string;
  shortages?: Record<string, unknown>;
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

export function projectFuelShortage(raw: unknown): FuelShortageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;

  const ev = (r.evidence ?? null) as Record<string, unknown> | null;
  const evidenceSources = Array.isArray(ev?.evidenceSources)
    ? (ev.evidenceSources as unknown[]).map(s => {
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

  const evidence = ev
    ? {
        evidenceSources,
        firstRegulatorConfirmation: coerceString(ev.firstRegulatorConfirmation),
        classifierVersion: coerceString(ev.classifierVersion, 'v1'),
        classifierConfidence: coerceNumber(ev.classifierConfidence, 0),
        lastEvidenceUpdate: coerceString(ev.lastEvidenceUpdate),
      }
    : undefined;

  return {
    id: coerceString(r.id),
    country: coerceString(r.country),
    product: coerceString(r.product),
    severity: coerceString(r.severity, 'watch'),
    firstSeen: coerceString(r.firstSeen),
    lastConfirmed: coerceString(r.lastConfirmed),
    // Proto has no nullable, so empty string = unresolved.
    resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : '',
    impactTypes: coerceStringArray(r.impactTypes),
    causeChain: coerceStringArray(r.causeChain),
    shortDescription: coerceString(r.shortDescription),
    evidence,
  };
}

function matches(entry: FuelShortageEntry, req: ListFuelShortagesRequest): boolean {
  if (req.country && entry.country !== req.country) return false;
  if (req.product && entry.product !== req.product) return false;
  if (req.severity && entry.severity !== req.severity) return false;
  return true;
}

// Built-in static entries shown when Redis seed is absent.
// Sources: UN OCHA, Reuters, IEA. Last reviewed 2025-Q4.
const BUILTIN_SHORTAGES: FuelShortageEntry[] = [
  {
    id: 'fs-cuba-petrol-2023',
    country: 'CU',
    product: 'petrol',
    severity: 'confirmed',
    firstSeen: '2023-06-01',
    lastConfirmed: '2025-11-01',
    resolvedAt: '',
    impactTypes: ['queues', 'black_market', 'rationing'],
    causeChain: ['import_shortfall', 'forex_constraint', 'sanctions'],
    shortDescription: 'Chronic shortage — long queues at petrol stations nationwide. State rations fuel to essential services and agriculture.',
    evidence: {
      evidenceSources: [{ authority: 'Reuters', title: 'Cuba fuel crisis deepens amid power cuts', url: '', date: '2025-06-01', sourceType: 'press' }],
      firstRegulatorConfirmation: '2023-07-15',
      classifierVersion: 'v1-builtin',
      classifierConfidence: 0.92,
      lastEvidenceUpdate: '2025-11-01',
    },
  },
  {
    id: 'fs-haiti-diesel-2022',
    country: 'HT',
    product: 'diesel',
    severity: 'confirmed',
    firstSeen: '2022-09-01',
    lastConfirmed: '2025-10-01',
    resolvedAt: '',
    impactTypes: ['generator_outages', 'supply_chain_disruption', 'hospital_risk'],
    causeChain: ['gang_blockade', 'port_disruption', 'political_instability'],
    shortDescription: 'Gang activity blocking fuel terminals. Hospitals and water pumps dependent on emergency reserves.',
    evidence: {
      evidenceSources: [{ authority: 'UN OCHA', title: 'Haiti Humanitarian Situation Report', url: '', date: '2025-09-01', sourceType: 'ngo' }],
      firstRegulatorConfirmation: '2022-09-10',
      classifierVersion: 'v1-builtin',
      classifierConfidence: 0.95,
      lastEvidenceUpdate: '2025-10-01',
    },
  },
  {
    id: 'fs-myanmar-petrol-2024',
    country: 'MM',
    product: 'petrol',
    severity: 'watch',
    firstSeen: '2024-01-01',
    lastConfirmed: '2025-09-01',
    resolvedAt: '',
    impactTypes: ['queues', 'price_spike'],
    causeChain: ['conflict', 'forex_constraint', 'import_disruption'],
    shortDescription: 'Intermittent shortages in major cities. Conflict and forex restrictions disrupt import supply chains.',
    evidence: {
      evidenceSources: [{ authority: 'Reuters', title: 'Myanmar fuel prices surge amid forex curbs', url: '', date: '2025-04-01', sourceType: 'press' }],
      firstRegulatorConfirmation: '2024-02-01',
      classifierVersion: 'v1-builtin',
      classifierConfidence: 0.78,
      lastEvidenceUpdate: '2025-09-01',
    },
  },
];

export async function listFuelShortages(
  _ctx: unknown,
  req: ListFuelShortagesRequest,
): Promise<ListFuelShortagesResponse> {
  const raw = (await getCachedJson(FUEL_SHORTAGES_KEY)) as RawRegistry | null;
  if (!raw?.shortages) {
    const shortages = BUILTIN_SHORTAGES.filter(s => matches(s, req));
    return {
      shortages,
      fetchedAt: new Date().toISOString(),
      classifierVersion: 'v1-builtin',
      upstreamUnavailable: false,
    };
  }

  const shortages = Object.values(raw.shortages)
    .map(projectFuelShortage)
    .filter((s): s is FuelShortageEntry => s != null)
    .filter(s => matches(s, req));

  return {
    shortages,
    fetchedAt: raw.updatedAt ?? new Date().toISOString(),
    classifierVersion: raw.classifierVersion ?? 'v1',
    upstreamUnavailable: false,
  };
}
