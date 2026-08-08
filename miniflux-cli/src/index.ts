#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { MinifluxClient, MinifluxError, loadConfig } from "./client.js";

const program = new Command();

program
  .name("miniflux")
  .description("Miniflux RSS reader CLI (reads MINIFLUX_URL and MINIFLUX_API_KEY env vars)")
  .version("1.0.0");

function makeClient(): MinifluxClient {
  return new MinifluxClient(loadConfig());
}

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function outText(text: string): void {
  process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
}

function idArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ID: ${value}`);
  return n;
}

function intOpt(value: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boolOpt(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}

// ---------- Read commands ----------

program
  .command("healthcheck")
  .description("Check if the Miniflux instance is reachable")
  .action(async () => {
    try {
      await makeClient().healthcheck();
      outText("Miniflux instance is healthy");
    } catch (e) {
      process.exitCode = 1;
      outText((e as Error).message);
    }
  });

program
  .command("me")
  .description("Get the currently authenticated user")
  .action(() => makeClient().getMe().then(out));

program
  .command("user-by-id")
  .description("Get a user by numeric ID")
  .argument("<id>", "user ID", idArg)
  .action((id) => makeClient().getUserById(id).then(out));

program
  .command("user-by-name")
  .description("Get a user by username")
  .argument("<username>", "username")
  .action((name) => makeClient().getUserByName(name).then(out));

program
  .command("feeds")
  .description("List all subscribed feeds")
  .action(() => makeClient().getFeeds().then(out));

program
  .command("feed")
  .description("Get a single feed by ID")
  .argument("<id>", "feed ID", idArg)
  .action((id) => makeClient().getFeed(id).then(out));

program
  .command("feed-icon")
  .description("Get the favicon/icon for a feed by ID")
  .argument("<id>", "feed ID", idArg)
  .action((id) => makeClient().getFeedIcon(id).then(out));

program
  .command("discover")
  .description("Discover RSS/Atom feeds available at a URL")
  .argument("<url>", "website URL")
  .action((url) => makeClient().discover(url).then(out));

program
  .command("categories")
  .description("List all feed categories")
  .action(() => makeClient().getCategories().then(out));

addEntryFilters(program.command("entries").description("List/filter entries"));

program
  .command("entry")
  .description("Get a single entry by ID")
  .argument("<id>", "entry ID", idArg)
  .action((id) => makeClient().getEntry(id).then(out));

addEntryFilters(program.command("feed-entries").description("Get entries for a specific feed"));

program
  .command("export-opml")
  .description("Export all feeds as OPML XML")
  .action(() => makeClient().exportOpml().then(outText));

// ---------- Write commands ----------

program
  .command("import-opml")
  .description("Import feeds from an OPML XML string or file")
  .argument("<opml>", "OPML XML string, or a path to a file, or '-' for stdin")
  .action((arg: string) => {
    let opml = arg;
    if (arg === "-") {
      opml = readFileSync(0, "utf8");
    } else if (arg.startsWith("@")) {
      opml = readFileSync(arg.slice(1), "utf8");
    }
    return makeClient().importOpml(opml).then(() => outText("OPML imported successfully"));
  });

program
  .command("create-category")
  .description("Create a new feed category")
  .argument("<title>", "category title")
  .action((title) => makeClient().createCategory(title).then(out));

program
  .command("update-category")
  .description("Rename a category")
  .argument("<id>", "category ID", idArg)
  .argument("<title>", "new title")
  .action((id, title) => makeClient().updateCategory(id, title).then(out));

program
  .command("delete-category")
  .description("Delete a category (feeds move to default)")
  .argument("<id>", "category ID", idArg)
  .action((id) => makeClient().deleteCategory(id).then(() => outText("Category deleted successfully")));

program
  .command("create-feed")
  .description("Subscribe to a feed by URL and assign it to a category")
  .argument("<feed-url>", "feed URL")
  .argument("<category-id>", "category ID", idArg)
  .action((feedUrl, categoryId) => makeClient().createFeed(feedUrl, categoryId).then(out));

program
  .command("update-feed")
  .description("Update a feed's fields")
  .argument("<id>", "feed ID", idArg)
  .option("--title <title>", "new title")
  .option("--category-id <id>", "new category ID", intOpt)
  .option("--feed-url <url>", "new feed URL")
  .option("--site-url <url>", "new site URL")
  .option("--user-agent <ua>", "new user agent")
  .action((id, opts) =>
    makeClient()
      .updateFeed(id, {
        title: opts.title,
        categoryId: opts.categoryId,
        feedUrl: opts.feedUrl,
        siteUrl: opts.siteUrl,
        userAgent: opts.userAgent,
      })
      .then(out),
  );

program
  .command("delete-feed")
  .description("Unsubscribe from a feed by ID")
  .argument("<id>", "feed ID", idArg)
  .action((id) => makeClient().deleteFeed(id).then(() => outText("Feed deleted successfully")));

program
  .command("refresh-feed")
  .description("Trigger a synchronous refresh of a feed")
  .argument("<id>", "feed ID", idArg)
  .action((id) => makeClient().refreshFeed(id).then(() => outText("Feed refreshed successfully")));

program
  .command("mark")
  .description("Mark one or more entries as read/unread/removed")
  .argument("<entry-ids...>", "entry IDs")
  .requiredOption("--status <status>", "read, unread, or removed")
  .action((ids, opts) => {
    const parsed = ids.map(idArg);
    return makeClient().updateEntryStatus(parsed, opts.status).then(() => outText("Entry status updated successfully"));
  });

program
  .command("bookmark")
  .description("Toggle the bookmark/star status of an entry")
  .argument("<id>", "entry ID", idArg)
  .action((id) => makeClient().toggleBookmark(id).then(() => outText("Bookmark toggled successfully")));

// ---------- Shared filter options ----------

function addEntryFilters(cmd: Command): Command {
  return cmd
    .option("--status <status>", 'entry status: read, unread, removed')
    .option("--offset <n>", "pagination offset", intOpt)
    .option("--limit <n>", "result limit (recommend 20)", intOpt)
    .option("--order <order>", "id, status, published_at, category_title, category_id")
    .option("--direction <dir>", "asc or desc")
    .option("--before <ts>", "unix timestamp", intOpt)
    .option("--after <ts>", "unix timestamp", intOpt)
    .option("--before-entry-id <id>", "entries before this entry id", intOpt)
    .option("--after-entry-id <id>", "entries after this entry id", intOpt)
    .option("--starred <bool>", "filter by starred: true/false", boolOpt)
    .option("--feed-id <id>", "feed ID (for feed-entries)", idArg)
    .action(async (opts) => {
      const filters = {
        status: opts.status,
        offset: opts.offset,
        limit: opts.limit,
        order: opts.order,
        direction: opts.direction,
        before: opts.before,
        after: opts.after,
        beforeEntryId: opts.beforeEntryId,
        afterEntryId: opts.afterEntryId,
        starred: opts.starred,
      };
      const client = makeClient();
      const result = opts.feedId !== undefined
        ? await client.getFeedEntries(opts.feedId, filters)
        : await client.getEntries(filters);
      out(result);
    });
}

program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
});

program.action(async (...args: unknown[]) => {
  // no subcommand
});

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof MinifluxError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();