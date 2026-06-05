/**
 * On-demand insights generation — fetches live headlines from public RSS
 * feeds and uses Gemini to produce a ServerInsights payload.
 *
 * Designed for self-hosted builds without Redis. Called by the Vite dev
 * server plugin (onDemandInsightsPlugin) and potentially the Vercel edge
 * fallback when news:insights:v1 is absent from Redis.
 */

import type { ServerInsights, ServerInsightStory } from '../../../../src/services/insights-loader';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  category: string;
  description: string;
}

function extractCdata(xml: string): string {
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml);
  if (cdata) return cdata[1].trim();
  return xml.replace(/<[^>]+>/g, '').trim();
}

function parseRssItems(xml: string, maxItems: number): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];

    const titleRaw = (/<title>([\s\S]*?)<\/title>/.exec(block) || [])[1] || '';
    const linkRaw = (/<link>([\s\S]*?)<\/link>/.exec(block) || (/<link[^>]*\/?>/.exec(block)) || [])[1] || '';
    const pubDateRaw = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block) || [])[1] || '';
    const catRaw = (/<category>([\s\S]*?)<\/category>/.exec(block) || [])[1] || 'World';
    const descRaw = (/<description>([\s\S]*?)<\/description>/.exec(block) || [])[1] || '';

    const title = extractCdata(titleRaw);
    if (!title || title === 'BBC News' || title === 'Reuters') continue;

    items.push({
      title,
      link: extractCdata(linkRaw),
      pubDate: pubDateRaw.trim(),
      category: extractCdata(catRaw),
      description: extractCdata(descRaw).slice(0, 200),
    });
  }
  return items;
}

async function fetchFeed(url: string, maxItems: number): Promise<RssItem[]> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'AlsaGlobal/2.8.0 (+https://alsatronix.com)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseRssItems(xml, maxItems);
  } catch {
    return [];
  }
}

// Infer threat level from headline keywords
function inferThreatLevel(title: string): string {
  const t = title.toLowerCase();
  if (/attack|killed|bomb|explosion|war|missile|airstrike|strike|conflict|fighting|casualties|dead/.test(t)) return 'high';
  if (/crisis|emergency|sanctions|protest|arrest|coup|nuclear|threat/.test(t)) return 'medium';
  if (/tension|concern|warning|dispute|election|summit/.test(t)) return 'low';
  return 'info';
}

// Infer country code from headline text
function inferCountryCode(title: string): string | null {
  const MAP: Record<string, string> = {
    ukraine: 'UA', russia: 'RU', israel: 'IL', gaza: 'PS', iran: 'IR',
    china: 'CN', taiwan: 'TW', 'north korea': 'KP', usa: 'US', 'united states': 'US',
    america: 'US', uk: 'GB', britain: 'GB', france: 'FR', germany: 'DE',
    india: 'IN', pakistan: 'PK', myanmar: 'MM', haiti: 'HT', venezuela: 'VE',
    turkey: 'TR', saudi: 'SA', iraq: 'IQ', syria: 'SY', sudan: 'SD',
    ethiopia: 'ET', somalia: 'SO', afghanistan: 'AF', libya: 'LY', yemen: 'YE',
    japan: 'JP', brazil: 'BR', mexico: 'MX', argentina: 'AR',
  };
  const t = title.toLowerCase();
  for (const [name, code] of Object.entries(MAP)) {
    if (t.includes(name)) return code;
  }
  return null;
}

async function generateGeminiBrief(headlines: string[]): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  const prompt = `You are a global intelligence analyst. Based on these current world headlines, write a 2-3 sentence concise intelligence brief summarizing the most significant developments and their geopolitical implications. Be specific and analytical.

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Intelligence Brief:`;

  try {
    const resp = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// Public RSS feeds — no API key required
const FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC News' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', source: 'NYT' },
  { url: 'https://feeds.reuters.com/reuters/worldNews', source: 'Reuters' },
];

export async function getOnDemandInsights(): Promise<ServerInsights | null> {
  // Fetch headlines from multiple feeds concurrently
  const results = await Promise.allSettled(
    FEEDS.map(f => fetchFeed(f.url, 6).then(items => items.map(i => ({ ...i, source: f.source }))))
  );

  const allItems: (RssItem & { source: string })[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value);
  }

  if (allItems.length === 0) return null;

  // De-duplicate by title similarity and cap at 10
  const seen = new Set<string>();
  const deduped: (RssItem & { source: string })[] = [];
  for (const item of allItems) {
    const key = item.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
    if (deduped.length >= 10) break;
  }

  const headlines = deduped.map(i => i.title);
  const worldBrief = await generateGeminiBrief(headlines.slice(0, 8));

  const topStories: ServerInsightStory[] = deduped.map((item, idx) => ({
    primaryTitle: item.title,
    primarySource: item.source,
    primaryLink: item.link,
    pubDate: item.pubDate,
    sourceCount: 1,
    importanceScore: Math.max(1, 10 - idx),
    velocity: { level: 'normal', sourcesPerHour: 1 },
    isAlert: inferThreatLevel(item.title) === 'high',
    category: item.category || 'world',
    threatLevel: inferThreatLevel(item.title),
    countryCode: inferCountryCode(item.title),
  }));

  return {
    worldBrief: worldBrief || headlines.slice(0, 2).join(' | '),
    briefProvider: worldBrief ? 'gemini' : 'rss-fallback',
    status: 'ok',
    topStories,
    generatedAt: new Date().toISOString(),
    clusterCount: deduped.length,
    multiSourceCount: deduped.filter(i => i.source !== deduped[0]?.source).length,
    fastMovingCount: deduped.filter(i => inferThreatLevel(i.title) === 'high').length,
  };
}
