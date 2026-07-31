/**
 * Runnable demo / smoke test for the pure-TypeScript PubMed client.
 *
 * Run (Node >= 23.6, or any Node via tsx):
 *   node scripts/demo.ts
 *   # or: npx tsx scripts/demo.ts
 *
 * Configuration comes from the environment by default:
 *   PUBMED_EMAIL=you@example.com NCBI_API_KEY=... node scripts/demo.ts
 * (NCBI asks for an email; pass requireEmail:false below to skip the check.)
 */
import { PubMedSource, DataSourceError } from "../src/pubmed.ts";
import type { SearchResponse, UnifiedResult } from "../src/pubmed.ts";

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printArticle(a: UnifiedResult, i: number): void {
  console.log(`  [${i}] ${a.title}`);
  console.log(`      authors : ${a.authors.join("; ") || "(none)"}`);
  console.log(
    `      journal : ${a.journal}${a.year ? ` (${a.year})` : ""}  PMID=${a.pmid}  DOI=${a.doi || "-"}`,
  );
  console.log(`      abstract: ${truncate(a.abstract)}`);
}

async function main(): Promise<void> {
  const source = new PubMedSource({ requireEmail: false });

  // 1. Search
  console.log("== search: \"deep learning MRI Alzheimer's disease\" (rows=3, sort=relevance) ==");
  const search: SearchResponse = await source.search(
    "deep learning MRI Alzheimer's disease",
    3,
    "relevance",
  );
  console.log(`total matches: ${search.total}`);
  search.results.forEach((a, i) => printArticle(a, i + 1));

  // 2. Fetch by PMID
  console.log("\n== getByPmid: 28344011 ==");
  const byId: UnifiedResult = await source.getByPmid("28344011");
  printArticle(byId, 1);

  // 3. MeSH lookup
  console.log('\n== lookupMesh: "Alzheimer Disease" =="');
  const mesh = await source.lookupMesh("Alzheimer Disease");
  mesh.results.slice(0, 5).forEach((d, i) =>
    console.log(`  [${i + 1}] ${d.name}  (UI=${d.ui})`),
  );

  // 4. Error handling
  console.log("\n== error handling ==");
  try {
    await source.getByPmid("not-a-pmid");
  } catch (err) {
    console.log(`  invalid PMID -> ${(err as DataSourceError).message}`);
  }
  try {
    await source.getByPmid("9999999999");
  } catch (err) {
    console.log(`  missing PMID -> ${(err as DataSourceError).message}`);
  }

  console.log("\nDemo complete.");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
