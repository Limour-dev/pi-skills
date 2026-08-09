#!/usr/bin/env node
/**
 * hn-briefing CLI
 *
 *   hn-briefing top [N]          # top N front-page stories (HN ranking, default 100)
 *   hn-briefing top --by-score   # same, but sorted by points descending
 *   hn-briefing item <id>        # fetch a single story by id
 *   hn-briefing content <url>    # fetch a URL and extract readable text (for summarising)
 *
 * All commands print JSON to stdout.
 */
import { topStories, topStoriesByScore, getItem } from "./src/hn.ts";
import { extractReadable } from "./src/content.ts";

const args = process.argv.slice(2);

function usageAndExit(code = 1): never {
  console.error(
    [
      "usage:",
      "  hn-briefing top [N]                top N front-page stories (HN ranking, default 100)",
      "  hn-briefing top --by-score [N]      same, sorted by points descending",
      "  hn-briefing item <id>               fetch a single story by id",
      "  hn-briefing content <url>           fetch a URL and extract readable text",
    ].join("\n")
  );
  process.exit(code);
}

async function main() {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "top": {
      const byScore = rest.includes("--by-score");
      const nArg = rest.find((a) => !a.startsWith("--"));
      const n = nArg ? parseInt(nArg, 10) : 100;
      const stories = byScore ? await topStoriesByScore(n) : await topStories(n);
      console.log(JSON.stringify(stories, null, 2));
      break;
    }
    case "item": {
      const id = parseInt(rest[0] ?? "", 10);
      if (!id) return usageAndExit();
      console.log(JSON.stringify(await getItem(id), null, 2));
      break;
    }
    case "content": {
      const url = rest[0];
      if (!url) return usageAndExit();
      console.log(JSON.stringify(await extractReadable(url), null, 2));
      break;
    }
    default:
      return usageAndExit();
  }
}

main().catch((e) => {
  console.error(`error: ${e?.message ?? e}`);
  process.exit(1);
});