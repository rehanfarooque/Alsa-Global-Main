/**
 * ListUnrestEvents — curated active global unrest/protest events with Redis fallback.
 */

import type {
  ServerContext,
  ListUnrestEventsRequest,
  ListUnrestEventsResponse,
  UnrestEvent,
} from '../../../../src/generated/server/alsaglobal/unrest/v1/service_server';

import { sortBySeverityAndRecency } from './_shared';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'unrest:events:v1';

const STATIC_UNREST_EVENTS: UnrestEvent[] = [
  { id: 'u-fr-pension-2025', title: 'Pension Reform Protests', summary: 'Nationwide strikes and protests against pension reform cuts across French cities.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Paris', country: 'France', region: 'Western Europe', location: { latitude: 48.86, longitude: 2.35 }, occurredAt: Date.now() - 2 * 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['AFP'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['labor', 'pension'], actors: ['CGT Union'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-ir-protest-2025', title: 'Anti-Government Protests', summary: 'Sporadic protests across Iranian cities demanding political reform and womens rights.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Tehran', country: 'Iran', region: 'Middle East', location: { latitude: 35.69, longitude: 51.39 }, occurredAt: Date.now() - 3 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 2, sources: ['HRANA'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['human-rights', 'women'], actors: ['Opposition Groups'], confidence: 'CONFIDENCE_LEVEL_MEDIUM', sourceUrls: [] },
  { id: 'u-il-protest-2025', title: 'Judicial Reform Protests', summary: 'Mass protests in Tel Aviv against judicial overhaul legislation.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Tel Aviv', country: 'Israel', region: 'Middle East', location: { latitude: 32.07, longitude: 34.79 }, occurredAt: Date.now() - 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['Haaretz'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['democracy', 'judiciary'], actors: ['Protest Movement'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-ke-protest-2025', title: 'Anti-Tax Youth Protests', summary: 'Gen-Z led protests against finance bill tax increases. Clashes with security forces.', eventType: 'UNREST_EVENT_TYPE_RIOT', city: 'Nairobi', country: 'Kenya', region: 'East Africa', location: { latitude: -1.29, longitude: 36.82 }, occurredAt: Date.now() - 4 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 3, sources: ['Nation Media'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['taxation', 'youth'], actors: ['Gen-Z Movement', 'Kenyan Police'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-ng-protest-2025', title: '#EndBadGovernance Protests', summary: 'Nationwide protests demanding end to hunger, insecurity, and poor governance.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Abuja', country: 'Nigeria', region: 'West Africa', location: { latitude: 9.07, longitude: 7.4 }, occurredAt: Date.now() - 6 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 5, sources: ['Premium Times'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['governance', 'hunger'], actors: ['Civil Society'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-sd-protest-2025', title: 'Anti-War Demonstrations', summary: 'Civilian protests demanding ceasefire between SAF and RSF in Sudan civil war.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Port Sudan', country: 'Sudan', region: 'East Africa', location: { latitude: 19.62, longitude: 37.22 }, occurredAt: Date.now() - 7 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 0, sources: ['Sudan Tribune'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['war', 'ceasefire'], actors: ['Civilian Committees'], confidence: 'CONFIDENCE_LEVEL_MEDIUM', sourceUrls: [] },
  { id: 'u-bd-protest-2025', title: 'Student Quota Reform Protests', summary: 'Student-led mass protests against civil service quota system. Clashes with security forces.', eventType: 'UNREST_EVENT_TYPE_RIOT', city: 'Dhaka', country: 'Bangladesh', region: 'South Asia', location: { latitude: 23.81, longitude: 90.41 }, occurredAt: Date.now() - 8 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 12, sources: ['Daily Star BD'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['quota', 'students'], actors: ['Student Movement', 'Police'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-pk-protest-2025', title: 'PTI Political Protests', summary: 'PTI supporters demonstrating for release of Imran Khan and fresh elections.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Islamabad', country: 'Pakistan', region: 'South Asia', location: { latitude: 33.72, longitude: 73.04 }, occurredAt: Date.now() - 3 * 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['Dawn'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['politics', 'PTI'], actors: ['PTI'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-mm-cdm-2025', title: 'Civil Disobedience Movement', summary: 'Ongoing civil disobedience against military junta across Myanmar cities.', eventType: 'UNREST_EVENT_TYPE_CIVIL_UNREST', city: 'Yangon', country: 'Myanmar', region: 'Southeast Asia', location: { latitude: 16.87, longitude: 96.19 }, occurredAt: Date.now() - 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 4, sources: ['Irrawaddy'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['junta', 'CDM'], actors: ['NUG Forces', 'Myanmar Military'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-ht-protest-2025', title: 'Protests Against Gang Violence', summary: 'Civilian protests demanding government action against gang control of Port-au-Prince.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Port-au-Prince', country: 'Haiti', region: 'Caribbean', location: { latitude: 18.54, longitude: -72.34 }, occurredAt: Date.now() - 2 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 1, sources: ['Le Nouvelliste'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['gangs', 'violence'], actors: ['Civil Society'], confidence: 'CONFIDENCE_LEVEL_MEDIUM', sourceUrls: [] },
  { id: 'u-ar-austerity-2025', title: 'Austerity Protests', summary: 'Mass protests against Milei government austerity cuts to public sector wages.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Buenos Aires', country: 'Argentina', region: 'South America', location: { latitude: -34.6, longitude: -58.38 }, occurredAt: Date.now() - 4 * 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['Clarin'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['austerity', 'economy'], actors: ['Labor Unions'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-ru-antiwar-2025', title: 'Underground Anti-War Protests', summary: 'Covert anti-war protests and acts of resistance against Ukraine war in Russian cities.', eventType: 'UNREST_EVENT_TYPE_PROTEST', city: 'Moscow', country: 'Russia', region: 'Eastern Europe', location: { latitude: 55.75, longitude: 37.62 }, occurredAt: Date.now() - 5 * 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['OVD-Info'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['anti-war', 'dissent'], actors: ['Anti-War Movement', 'FSB'], confidence: 'CONFIDENCE_LEVEL_MEDIUM', sourceUrls: [] },
  { id: 'u-ge-proeu-2025', title: 'Pro-EU Mass Protests', summary: 'Massive pro-EU protests in Tbilisi against suspension of EU accession talks.', eventType: 'UNREST_EVENT_TYPE_DEMONSTRATION', city: 'Tbilisi', country: 'Georgia', region: 'Caucasus', location: { latitude: 41.69, longitude: 44.83 }, occurredAt: Date.now() - 10 * 86400000, severity: 'SEVERITY_LEVEL_HIGH', fatalities: 0, sources: ['Civil.ge'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['EU', 'democracy'], actors: ['Pro-EU Opposition'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-de-demo-2025', title: 'Anti-Far-Right Demonstrations', summary: 'Large counter-demonstrations against far-right party rallies across German cities.', eventType: 'UNREST_EVENT_TYPE_DEMONSTRATION', city: 'Berlin', country: 'Germany', region: 'Western Europe', location: { latitude: 52.52, longitude: 13.41 }, occurredAt: Date.now() - 5 * 86400000, severity: 'SEVERITY_LEVEL_LOW', fatalities: 0, sources: ['DPA'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['politics', 'democracy'], actors: ['Civil Society'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
  { id: 'u-co-strike-2025', title: 'Coca Growers Strike', summary: 'Coca growers blockades in Catatumbo region over eradication policies.', eventType: 'UNREST_EVENT_TYPE_STRIKE', city: 'Cucuta', country: 'Colombia', region: 'South America', location: { latitude: 7.89, longitude: -72.5 }, occurredAt: Date.now() - 9 * 86400000, severity: 'SEVERITY_LEVEL_MEDIUM', fatalities: 0, sources: ['El Tiempo'], sourceType: 'UNREST_SOURCE_TYPE_RSS', tags: ['coca', 'strike'], actors: ['Cocaleros'], confidence: 'CONFIDENCE_LEVEL_HIGH', sourceUrls: [] },
];

function filterSeedEvents(events: UnrestEvent[], req: ListUnrestEventsRequest): UnrestEvent[] {
  let filtered = events;
  if (req.country) {
    const country = req.country.toLowerCase();
    filtered = filtered.filter(e => e.country.toLowerCase() === country || e.country.toLowerCase().includes(country));
  }
  if (req.start > 0) filtered = filtered.filter(e => e.occurredAt >= req.start);
  if (req.end > 0) filtered = filtered.filter(e => e.occurredAt <= req.end);
  return filtered;
}

export async function listUnrestEvents(
  _ctx: ServerContext,
  req: ListUnrestEventsRequest,
): Promise<ListUnrestEventsResponse> {
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListUnrestEventsResponse | null;
    if (seedData?.events?.length) {
      return { events: sortBySeverityAndRecency(filterSeedEvents(seedData.events, req)), clusters: [], pagination: undefined };
    }
  } catch { /* fall through */ }

  const filtered = filterSeedEvents(STATIC_UNREST_EVENTS, req);
  return { events: sortBySeverityAndRecency(filtered), clusters: [], pagination: undefined };
}
