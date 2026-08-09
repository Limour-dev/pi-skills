/**
 * Hacker News API client — fetch top/front-page stories and article content.
 *
 * Zero-dependency, uses the built-in `fetch` (Node >= 22). All commands print
 * JSON to stdout.
 */

const API = "https://hacker-news.firebaseio.com/v0";

export interface Story {
  id: number;
  title: string;
  score: number;
  descendants: number; // comment count
  url?: string;
  by?: string;
  time?: number;
  type?: string;
  text?: string;
}

export interface RankedStory extends Story {
  rank: number;
}

function hn(path: string): Promise<any> {
  return fetch(`${API}/${path}`).then((r) => {
    if (!r.ok) throw new Error(`HN API ${path} -> HTTP ${r.status}`);
    return r.json();
  });
}

/** Fetch a single item by id. */
export async function getItem(id: number): Promise<any> {
  return hn(`item/${id}.json`);
}

/** Fetch many items in parallel with a concurrency limit. */
export async function getItems(
  ids: number[],
  concurrency = 12
): Promise<any[]> {
  const out: any[] = new Array(ids.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= ids.length) return;
      out[idx] = await getItem(ids[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Fetch the top front-page stories (default 100), returned in HN's own
 * ranking order (not re-sorted by points).
 */
export async function topStories(limit = 100): Promise<RankedStory[]> {
  const ids: number[] = await hn("topstories.json");
  const slice = ids.slice(0, limit);
  const items = await getItems(slice);
  return items
    .filter((s): s is Story => s && s.type === "story")
    .map((s, idx) => ({ ...s, rank: idx + 1 }));
}

/**
 * Fetch many stories and sort them by score (descending). Useful for building
 * a "top by points" briefing.
 */
export async function topStoriesByScore(limit = 100): Promise<RankedStory[]> {
  const stories = await topStories(limit);
  return stories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}