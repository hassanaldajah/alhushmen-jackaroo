/** YouTube Data API v3 search proxy helpers (pure parsing + one fetch). Key comes from env only. */

import { MAX_QUERY_LEN, VIDEO_ID_RE, type SearchResult } from '../shared/protocol';

export const YT_CACHE_MS = 24 * 60 * 60 * 1000;
export const YT_PER_USER_PER_MIN = 6;
/** search.list costs 100 units of the free 10,000/day quota; keep a margin. */
export const YT_DAILY_CAP = 90;

export function normalizeQuery(q: string | null): string | null {
  if (q === null) return null;
  const s = q.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!s || Array.from(s).length > MAX_QUERY_LEN) return null;
  return s;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+|#39);/g, (m, e: string) => {
    if (ENTITIES[e]) return ENTITIES[e]!;
    if (e.startsWith('#x')) { const n = parseInt(e.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    if (e.startsWith('#')) { const n = parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return m;
  });
}

function cleanTitle(t: unknown): string {
  const s = decodeEntities(typeof t === 'string' ? t : '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return Array.from(s).slice(0, 120).join('');
}

/** Thumbnail is always rebuilt server-side from the validated videoId (checklist 23); upstream URLs are ignored. */
function cleanThumb(_url: unknown, videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export function parseSearch(json: unknown): SearchResult[] {
  const items = (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: SearchResult[] = [];
  for (const it of items.slice(0, 10)) {
    const videoId = (it as { id?: { videoId?: unknown } })?.id?.videoId;
    if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) continue;
    const sn = (it as { snippet?: { title?: unknown; thumbnails?: { medium?: { url?: unknown }; default?: { url?: unknown } } } }).snippet;
    out.push({
      videoId,
      title: cleanTitle(sn?.title),
      thumb: cleanThumb(sn?.thumbnails?.medium?.url ?? sn?.thumbnails?.default?.url, videoId),
    });
  }
  return out;
}

export type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; reason: 'quota' | 'network' };

export async function ytSearch(q: string, key: string, fetcher: typeof fetch = fetch): Promise<SearchOutcome> {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part', 'snippet');
  u.searchParams.set('type', 'video');
  u.searchParams.set('videoEmbeddable', 'true');
  u.searchParams.set('safeSearch', 'moderate');
  u.searchParams.set('maxResults', '8');
  u.searchParams.set('fields', 'items(id/videoId,snippet/title,snippet/thumbnails/medium/url)');
  u.searchParams.set('q', q);
  u.searchParams.set('key', key);
  try {
    const r = await fetcher(u.toString(), { headers: { accept: 'application/json' } });
    if (r.status === 403 || r.status === 429) return { ok: false, reason: 'quota' };
    if (!r.ok) return { ok: false, reason: 'network' };
    return { ok: true, results: parseSearch(await r.json()) };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** videos.list (1 unit) for qAdd of an id not in our cache. */
export async function ytVideo(videoId: string, key: string, fetcher: typeof fetch = fetch): Promise<SearchResult | null> {
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const u = new URL('https://www.googleapis.com/youtube/v3/videos');
  u.searchParams.set('part', 'snippet,status');
  u.searchParams.set('id', videoId);
  u.searchParams.set('fields', 'items(id,snippet/title,snippet/thumbnails/medium/url,status/embeddable)');
  u.searchParams.set('key', key);
  try {
    const r = await fetcher(u.toString());
    if (!r.ok) return null;
    const j = (await r.json()) as { items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { medium?: { url?: string } } }; status?: { embeddable?: boolean } }> };
    const it = j.items?.[0];
    if (!it || it.id !== videoId || it.status?.embeddable === false) return null;
    return { videoId, title: cleanTitle(it.snippet?.title), thumb: cleanThumb(it.snippet?.thumbnails?.medium?.url, videoId) };
  } catch {
    return null;
  }
}
