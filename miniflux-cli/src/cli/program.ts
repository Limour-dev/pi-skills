/**
 * Commander program definition: all subcommands of the CLI.
 * The client factory is injected so tests can supply a mock-backed client.
 */
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import type { MinifluxClient } from "../api/client.js";
import type { EntryFilters, EntryStatus } from "../api/types.js";
import { ENTRY_ORDER_FIELDS, ENTRY_STATUSES, SORT_DIRECTIONS } from "../api/types.js";
import { printJson, printText } from "./output.js";
import { parseBoolOption, parseId, parseIntOption } from "./parsers.js";

export const CLI_VERSION = "1.0.0";

type ClientFactory = () => MinifluxClient;

export function createProgram(makeClient: ClientFactory): Command {
  const program = new Command();
  program
    .name("miniflux")
    .description("Miniflux RSS reader CLI (reads MINIFLUX_URL and MINIFLUX_API_KEY env vars)")
    .version(CLI_VERSION)
    .showHelpAfterError("(run with --help for usage)");

  // ---------- Read commands ----------

  program
    .command("healthcheck")
    .description("Check if the Miniflux instance is reachable")
    .action(async () => {
      await makeClient().healthcheck();
      printText("Miniflux instance is healthy");
    });

  program
    .command("me")
    .description("Get the currently authenticated user")
    .action(async () => printJson(await makeClient().getMe()));

  program
    .command("user-by-id")
    .description("Get a user by numeric ID")
    .argument("<id>", "user ID", parseId)
    .action(async (id: number) => printJson(await makeClient().getUserById(id)));

  program
    .command("user-by-name")
    .description("Get a user by username")
    .argument("<username>", "username")
    .action(async (name: string) => printJson(await makeClient().getUserByName(name)));

  program
    .command("feeds")
    .description("List all subscribed feeds")
    .action(async () => printJson(await makeClient().getFeeds()));

  program
    .command("feed")
    .description("Get a single feed by ID")
    .argument("<id>", "feed ID", parseId)
    .action(async (id: number) => printJson(await makeClient().getFeed(id)));

  program
    .command("feed-icon")
    .description("Get the favicon/icon for a feed by ID")
    .argument("<id>", "feed ID", parseId)
    .action(async (id: number) => printJson(await makeClient().getFeedIcon(id)));

  program
    .command("discover")
    .description("Discover RSS/Atom feeds available at a URL")
    .argument("<url>", "website URL")
    .action(async (url: string) => printJson(await makeClient().discover(url)));

  program
    .command("categories")
    .description("List all feed categories")
    .action(async () => printJson(await makeClient().getCategories()));

  addEntryFilterOptions(program.command("entries").description("List/filter entries")).action(
    async (opts) => {
      printJson(await makeClient().getEntries(filtersFromOptions(opts)));
    },
  );

  program
    .command("entry")
    .description("Get a single entry by ID")
    .argument("<id>", "entry ID", parseId)
    .action(async (id: number) => printJson(await makeClient().getEntry(id)));

  addEntryFilterOptions(program.command("feed-entries").description("Get entries for a specific feed"))
    .requiredOption("--feed-id <id>", "feed ID", parseId)
    .action(async (opts) => {
      printJson(await makeClient().getFeedEntries(opts.feedId, filtersFromOptions(opts)));
    });

  program
    .command("export-opml")
    .description("Export all feeds as OPML XML")
    .action(async () => printText(await makeClient().exportOpml()));

  // ---------- Write commands ----------

  program
    .command("import-opml")
    .description("Import feeds from an OPML XML string or file")
    .argument("<opml>", "OPML XML string, or @/path/to/file, or '-' for stdin")
    .action(async (arg: string) => {
      printText(await importOpmlFromArg(makeClient, arg));
    });

  program
    .command("create-category")
    .description("Create a new feed category")
    .argument("<title>", "category title")
    .action(async (title: string) => printJson(await makeClient().createCategory(title)));

  program
    .command("update-category")
    .description("Rename a category")
    .argument("<id>", "category ID", parseId)
    .argument("<title>", "new title")
    .action(async (id: number, title: string) => printJson(await makeClient().updateCategory(id, title)));

  program
    .command("delete-category")
    .description("Delete a category (feeds move to default)")
    .argument("<id>", "category ID", parseId)
    .action(async (id: number) => {
      await makeClient().deleteCategory(id);
      printText("Category deleted successfully");
    });

  program
    .command("create-feed")
    .description("Subscribe to a feed by URL and assign it to a category")
    .argument("<feed-url>", "feed URL")
    .argument("<category-id>", "category ID", parseId)
    .action(async (feedUrl: string, categoryId: number) =>
      printJson(await makeClient().createFeed(feedUrl, categoryId)),
    );

  program
    .command("update-feed")
    .description("Update a feed's fields")
    .argument("<id>", "feed ID", parseId)
    .option("--title <title>", "new title")
    .option("--category-id <id>", "new category ID", parseIntOption)
    .option("--feed-url <url>", "new feed URL")
    .option("--site-url <url>", "new site URL")
    .option("--user-agent <ua>", "new user agent")
    .action(async (id: number, opts) =>
      printJson(
        await makeClient().updateFeed(id, {
          title: opts.title,
          categoryId: opts.categoryId,
          feedUrl: opts.feedUrl,
          siteUrl: opts.siteUrl,
          userAgent: opts.userAgent,
        }),
      ),
    );

  program
    .command("delete-feed")
    .description("Unsubscribe from a feed by ID")
    .argument("<id>", "feed ID", parseId)
    .action(async (id: number) => {
      await makeClient().deleteFeed(id);
      printText("Feed deleted successfully");
    });

  program
    .command("refresh-feed")
    .description("Trigger a synchronous refresh of a feed")
    .argument("<id>", "feed ID", parseId)
    .action(async (id: number) => {
      await makeClient().refreshFeed(id);
      printText("Feed refreshed successfully");
    });

  program
    .command("mark")
    .description("Mark one or more entries as read/unread/removed")
    .argument("<entry-ids...>", "entry IDs", parseId)
    .addOption(
      new Option("--status <status>", "target status")
        .choices([...ENTRY_STATUSES])
        .makeOptionMandatory(),
    )
    .action(async (ids: number[], opts: { status: EntryStatus }) => {
      await makeClient().updateEntryStatus(ids, opts.status);
      printText("Entry status updated successfully");
    });

  program
    .command("bookmark")
    .description("Toggle the bookmark/star status of an entry")
    .argument("<id>", "entry ID", parseId)
    .action(async (id: number) => {
      await makeClient().toggleBookmark(id);
      printText("Bookmark toggled successfully");
    });

  return program;
}

/** Resolve the import-opml argument: inline XML, @file, or '-' for stdin. */
async function importOpmlFromArg(makeClient: ClientFactory, arg: string): Promise<string> {
  let opml = arg;
  if (arg === "-") {
    opml = readFileSync(0, "utf8");
  } else if (arg.startsWith("@")) {
    opml = readFileSync(arg.slice(1), "utf8");
  }
  await makeClient().importOpml(opml);
  return "OPML imported successfully";
}

/** Entry filter options shared by `entries` and `feed-entries`. */
function addEntryFilterOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option("--status <status>", "entry status").choices([...ENTRY_STATUSES]))
    .option("--offset <n>", "pagination offset", parseIntOption)
    .option("--limit <n>", "result limit (recommend 20)", parseIntOption)
    .addOption(new Option("--order <field>", "sort field").choices([...ENTRY_ORDER_FIELDS]))
    .addOption(new Option("--direction <dir>", "sort direction").choices([...SORT_DIRECTIONS]))
    .option("--before <ts>", "published before this Unix timestamp", parseIntOption)
    .option("--after <ts>", "published after this Unix timestamp", parseIntOption)
    .option("--before-entry-id <id>", "entries before this entry ID", parseIntOption)
    .option("--after-entry-id <id>", "entries after this entry ID", parseIntOption)
    .option("--starred <bool>", "filter bookmarked entries (true/false)", parseBoolOption);
}

function filtersFromOptions(opts: {
  status?: EntryStatus;
  offset?: number;
  limit?: number;
  order?: EntryFilters["order"];
  direction?: EntryFilters["direction"];
  before?: number;
  after?: number;
  beforeEntryId?: number;
  afterEntryId?: number;
  starred?: boolean;
}): EntryFilters {
  return {
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
}
