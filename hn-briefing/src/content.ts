/**
 * Readable-content extraction from an arbitrary URL.
 *
 * Pure TypeScript, no external deps. Fetches the page, strips <script>/<style>
 * and markup, collapses whitespace, and returns the plain text (capped).
 * Good enough to grab the substance of a story for summarising.
 */
import { decode } from "./entities.ts";

const MAX_CHARS = 20000;

export interface Extracted {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
}

export async function extractReadable(url: string): Promise<Extracted> {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const html = await res.text();

  // Grab <title> before stripping markup.
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let title: string | undefined;
  if (titleMatch) {
    title = decode(titleMatch[1].replace(/<[^>]+>/g, "")).trim();
  }

  const text = clean(html);
  const truncated = text.length > MAX_CHARS;
  return { url, title, text: text.slice(0, MAX_CHARS), truncated };
}

function clean(html: string): string {
  let s = html;
  // Remove comment nodes.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Remove script, style, head-relevant blocks.
  s = s.replace(/<(script|style|noscript|svg|head|template)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Turn block boundaries into spaces.
  s = s.replace(/<\/?(?:p|div|br|li|h[1-6]|tr|section|article|blockquote|pre)[^>]*>/gi, " ");
  // Drop remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode entities.
  s = decode(s);
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}