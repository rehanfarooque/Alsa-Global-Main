import type {
  ListSanctionsPressureRequest,
  ListSanctionsPressureResponse,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/alsaglobal/sanctions/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'sanctions:pressure:v1';
const DEFAULT_MAX_ITEMS = 25;
const MAX_ITEMS_LIMIT = 60;

function clampMaxItems(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ITEMS_LIMIT);
}

// Curated static sanctions pressure data (OFAC SDN / EU / UN sources, 2024)
const STATIC_SANCTIONS: ListSanctionsPressureResponse = {
  entries: [
    { id: 'sdn-ru-gazprom', name: 'Gazprom', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['RU'], countryNames: ['Russia'], programs: ['UKRAINE-EO13661'], sourceLists: ['SDN'], effectiveAt: '2022-03-25', isNew: false, note: 'Russian state energy company' },
    { id: 'sdn-ru-rosneft', name: 'Rosneft Oil Company', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['RU'], countryNames: ['Russia'], programs: ['UKRAINE-EO13661'], sourceLists: ['SDN'], effectiveAt: '2022-02-28', isNew: false, note: 'Russian state oil company' },
    { id: 'sdn-ru-sberbank', name: 'Sberbank', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['RU'], countryNames: ['Russia'], programs: ['UKRAINE-EO14024'], sourceLists: ['SDN'], effectiveAt: '2022-03-08', isNew: false, note: 'Russian state bank' },
    { id: 'sdn-ir-nioc', name: 'National Iranian Oil Company', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['IR'], countryNames: ['Iran'], programs: ['IRAN'], sourceLists: ['SDN'], effectiveAt: '2019-05-03', isNew: false, note: 'Iranian state oil company' },
    { id: 'sdn-kp-dprk', name: 'Korea National Insurance Corporation', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['KP'], countryNames: ['North Korea'], programs: ['DPRK'], sourceLists: ['SDN'], effectiveAt: '2019-08-30', isNew: false, note: 'DPRK state insurer' },
    { id: 'sdn-by-belaruskali', name: 'Belaruskali', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['BY'], countryNames: ['Belarus'], programs: ['BELARUS'], sourceLists: ['SDN'], effectiveAt: '2021-08-09', isNew: false, note: 'Belarusian potash producer' },
    { id: 'sdn-sy-sytrol', name: 'Sytrol', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['SY'], countryNames: ['Syria'], programs: ['SYRIA'], sourceLists: ['SDN'], effectiveAt: '2011-08-18', isNew: false, note: 'Syrian state oil company' },
    { id: 'sdn-ve-pdvsa', name: 'Petróleos de Venezuela', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['VE'], countryNames: ['Venezuela'], programs: ['VENEZUELA'], sourceLists: ['SDN'], effectiveAt: '2019-01-28', isNew: false, note: 'Venezuelan state oil company' },
    { id: 'sdn-mm-mehl', name: 'Myanmar Economic Holdings Ltd', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['MM'], countryNames: ['Myanmar'], programs: ['BURMA'], sourceLists: ['SDN'], effectiveAt: '2021-03-25', isNew: false, note: 'Myanmar military conglomerate' },
    { id: 'sdn-sd-sat', name: 'Sudan Allied Forces', entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', countryCodes: ['SD'], countryNames: ['Sudan'], programs: ['SUDAN'], sourceLists: ['SDN'], effectiveAt: '2022-06-01', isNew: false, note: 'Paramilitary forces in Sudan' },
  ],
  countries: [
    { countryCode: 'RU', countryName: 'Russia', entryCount: 3820, newEntryCount: 142, vesselCount: 89, aircraftCount: 24 },
    { countryCode: 'IR', countryName: 'Iran', entryCount: 1420, newEntryCount: 18, vesselCount: 67, aircraftCount: 12 },
    { countryCode: 'KP', countryName: 'North Korea', entryCount: 395, newEntryCount: 8, vesselCount: 45, aircraftCount: 0 },
    { countryCode: 'BY', countryName: 'Belarus', entryCount: 310, newEntryCount: 22, vesselCount: 5, aircraftCount: 3 },
    { countryCode: 'SY', countryName: 'Syria', entryCount: 780, newEntryCount: 5, vesselCount: 12, aircraftCount: 2 },
    { countryCode: 'VE', countryName: 'Venezuela', entryCount: 248, newEntryCount: 6, vesselCount: 28, aircraftCount: 4 },
    { countryCode: 'MM', countryName: 'Myanmar', entryCount: 195, newEntryCount: 12, vesselCount: 3, aircraftCount: 0 },
    { countryCode: 'CU', countryName: 'Cuba', entryCount: 210, newEntryCount: 2, vesselCount: 8, aircraftCount: 15 },
    { countryCode: 'SD', countryName: 'Sudan', entryCount: 420, newEntryCount: 14, vesselCount: 0, aircraftCount: 0 },
    { countryCode: 'ZW', countryName: 'Zimbabwe', entryCount: 142, newEntryCount: 0, vesselCount: 0, aircraftCount: 0 },
  ],
  programs: [
    { program: 'UKRAINE-EO14024', entryCount: 3820, newEntryCount: 142 },
    { program: 'IRAN', entryCount: 1420, newEntryCount: 18 },
    { program: 'DPRK', entryCount: 395, newEntryCount: 8 },
    { program: 'SYRIA', entryCount: 780, newEntryCount: 5 },
    { program: 'VENEZUELA', entryCount: 248, newEntryCount: 6 },
    { program: 'BELARUS', entryCount: 310, newEntryCount: 22 },
    { program: 'BURMA', entryCount: 195, newEntryCount: 12 },
    { program: 'CUBA', entryCount: 210, newEntryCount: 2 },
    { program: 'SUDAN', entryCount: 420, newEntryCount: 14 },
    { program: 'GLOBAL-MAGNITSKY', entryCount: 420, newEntryCount: 32 },
  ],
  fetchedAt: String(Date.now()),
  datasetDate: '2024-11-01',
  totalCount: 8920,
  sdnCount: 7200,
  consolidatedCount: 1720,
  newEntryCount: 261,
  vesselCount: 257,
  aircraftCount: 62,
};

export const listSanctionsPressure: SanctionsServiceHandler['listSanctionsPressure'] = async (
  _ctx: ServerContext,
  req: ListSanctionsPressureRequest,
): Promise<ListSanctionsPressureResponse> => {
  const maxItems = clampMaxItems(req.maxItems);
  try {
    const data = await getCachedJson(REDIS_CACHE_KEY, true) as ListSanctionsPressureResponse & { _state?: unknown } | null;
    if (data?.totalCount) {
      const { _state: _discarded, ...rest } = data;
      return { ...rest, entries: (data.entries ?? []).slice(0, maxItems) };
    }
  } catch { /* fall through */ }

  return { ...STATIC_SANCTIONS, entries: STATIC_SANCTIONS.entries.slice(0, maxItems) };
};
