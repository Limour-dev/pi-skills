/**
 * CLI command definitions and argument parsing. No external dependencies:
 * arguments are parsed by hand so the CLI can run with plain `node` (type
 * stripping) from any directory, with no build step and no npm install.
 * The client factory is injected so tests can supply a mock-backed client.
 */
import { readFileSync } from "node:fs";
import type { MinifluxClient } from "../api/client.ts";
import type { EntryFilters, EntryStatus } from "../api/types.ts";
import { ENTRY_ORDER_FIELDS, ENTRY_STATUSES, SORT_DIRECTIONS } from "../api/types.ts";
import { printJson, printText } from "./output.ts";
import { CliUsageError, parseBoolOption, parseId, parseIntOption } from "./parsers.ts";

export const CLI_VERSION = "1.0.0";

type ClientFactory = () => MinifluxClient;

export interface CliProgram {
  /** Parse argv (without node/script) and run the matching command. */
  parseAsync(argv: string[]): Promise<void>;
}

export function createProgram(makeClient: ClientFactory): CliProgram {
  return { parseAsync: (argv) => run(makeClient, argv) };
}

/** Split argv into ordered positional args and `--flag value` pairs. */
function parseArgs(
  argv: string[],
): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      flags.help = "true";
    } else if (a === "--version" || a === "-V") {
      flags.version = "true";
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = "true";
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function run(makeClient: ClientFactory, argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);

  if (flags.help && positionals.length === 0) {
    printText(help());
    return;
  }
  if (flags.version && positionals.length === 0) {
    printText(`miniflux ${CLI_VERSION}`);
    return;
  }

  const command = positionals.shift();
  if (!command) {
    throw new CliUsageError(`missing command\n\n${help()}`);
  }

  const client = makeClient();

  switch (command) {
    // ---------- Read commands ----------

    case "healthcheck": {
      await client.healthcheck();
      printText("Miniflux instance is healthy");
      return;
    }

    case "me": {
      printJson(await client.getMe());
      return;
    }

    case "user-by-id": {
      printJson(await client.getUserById(parseId(requirePos(command, positionals, 0))));
      return;
    }

    case "user-by-name": {
      printJson(await client.getUserByName(requirePos(command, positionals, 0)));
      return;
    }

    case "feeds": {
      printJson(await client.getFeeds());
      return;
    }

    case "feed": {
      printJson(await client.getFeed(parseId(requirePos(command, positionals, 0))));
      return;
    }

    case "feed-icon": {
      printJson(await client.getFeedIcon(parseId(requirePos(command, positionals, 0))));
      return;
    }

    case "discover": {
      printJson(await client.discover(requirePos(command, positionals, 0)));
      return;
    }

    case "categories": {
      printJson(await client.getCategories());
      return;
    }

    case "entries": {
      printJson(await client.getEntries(filtersFromFlags(command, flags)));
      return;
    }

    case "entry": {
      printJson(await client.getEntry(parseId(requirePos(command, positionals, 0))));
      return;
    }

    case "feed-entries": {
      const feedId = FlagValue(flags, "feed-id");
      if (feedId === undefined) {
        throw new CliUsageError("feed-entries requires --feed-id <id>");
      }
      if (positionals.length > 0) {
        throw new CliUsageError(`feed-entries does not take positional arguments`);
      }
      printJson(await client.getFeedEntries(parseId(feedId), filtersFromFlags(command, flags)));
      return;
    }

    case "export-opml": {
      printText(await client.exportOpml());
      return;
    }

    // ---------- Write commands ----------

    case "import-opml": {
      const arg = requirePos(command, positionals, 0);
      printText(await importOpmlFromArg(client, arg));
      return;
    }

    case "create-category": {
      const title = requirePos(command, positionals, 0);
      printJson(await client.createCategory(title));
      return;
    }

    case "update-category": {
      const id = parseId(requirePos(command, positionals, 0));
      const title = requirePos(command, positionals, 1);
      printJson(await client.updateCategory(id, title));
      return;
    }

    case "delete-category": {
      await client.deleteCategory(parseId(requirePos(command, positionals, 0)));
      printText("Category deleted successfully");
      return;
    }

    case "create-feed": {
      const feedUrl = requirePos(command, positionals, 0);
      const categoryId = parseId(requirePos(command, positionals, 1));
      printJson(await client.createFeed(feedUrl, categoryId));
      return;
    }

    case "update-feed": {
      const id = parseId(requirePos(command, positionals, 0));
      printJson(
        await client.updateFeed(id, {
          title: FlagValue(flags, "title"),
          categoryId:
            FlagValue(flags, "category-id") !== undefined
              ? parseIntOption(FlagValue(flags, "category-id")!)
              : undefined,
          feedUrl: FlagValue(flags, "feed-url"),
          siteUrl: FlagValue(flags, "site-url"),
          userAgent: FlagValue(flags, "user-agent"),
        }),
      );
      return;
    }

    case "delete-feed": {
      await client.deleteFeed(parseId(requirePos(command, positionals, 0)));
      printText("Feed deleted successfully");
      return;
    }

    case "refresh-feed": {
      await client.refreshFeed(parseId(requirePos(command, positionals, 0)));
      printText("Feed refreshed successfully");
      return;
    }

    case "mark": {
      if (positionals.length === 0) {
        throw new CliUsageError("mark requires at least one <entry-id>");
      }
      const statusRaw = FlagValue(flags, "status");
      if (statusRaw === undefined) {
        throw new CliUsageError(`mark requires --status <status> (one of ${ENTRY_STATUSES.join(", ")})`);
      }
      if (!isEntryStatus(statusRaw)) {
        throw new CliUsageError(
          `invalid --status "${statusRaw}" (expected one of ${ENTRY_STATUSES.join(", ")})`,
        );
      }
      const ids = positionals.map((p) => parseId(p));
      await client.updateEntryStatus(ids, statusRaw);
      printText("Entry status updated successfully");
      return;
    }

    case "bookmark": {
      await client.toggleBookmark(parseId(requirePos(command, positionals, 0)));
      printText("Bookmark toggled successfully");
      return;
    }

    default:
      throw new CliUsageError(`unknown command "${command}"\n\n${help()}`);
  }
}

/** Return the positional argument at `index` or throw a clean usage error. */
function requirePos(command: string, positionals: string[], index: number): string {
  const v = positionals[index];
  if (v === undefined) {
    throw new CliUsageError(`"${command}" is missing required argument #${index + 1}`);
  }
  return v;
}

function FlagValue(flags: Record<string, string>, name: string): string | undefined {
  return flags[name];
}

function isEntryStatus(v: string): v is EntryStatus {
  return (ENTRY_STATUSES as readonly string[]).includes(v);
}

/** Resolve the import-opml argument: inline XML, @file, or '-' for stdin. */
async function importOpmlFromArg(client: MinifluxClient, arg: string): Promise<string> {
  let opml = arg;
  if (arg === "-") {
    opml = readFileSync(0, "utf8");
  } else if (arg.startsWith("@")) {
    opml = readFileSync(arg.slice(1), "utf8");
  }
  await client.importOpml(opml);
  return "OPML imported successfully";
}

/** Build EntryFilters from the entry-listing command's flags. */
function filtersFromFlags(command: string, flags: Record<string, string>): EntryFilters {
  const f: EntryFilters = {};
  if (flags.status !== undefined) {
    if (!isEntryStatus(flags.status)) {
      throw new CliUsageError(
        `invalid --status "${flags.status}" (expected one of ${ENTRY_STATUSES.join(", ")})`,
      );
    }
    f.status = flags.status;
  }
  if (flags.offset !== undefined) f.offset = parseIntOption(flags.offset);
  if (flags.limit !== undefined) f.limit = parseIntOption(flags.limit);
  if (flags.order !== undefined) {
    if (!(ENTRY_ORDER_FIELDS as readonly string[]).includes(flags.order)) {
      throw new CliUsageError(
        `invalid --order "${flags.order}" (expected one of ${ENTRY_ORDER_FIELDS.join(", ")})`,
      );
    }
    f.order = flags.order as EntryFilters["order"];
  }
  if (flags.direction !== undefined) {
    if (!(SORT_DIRECTIONS as readonly string[]).includes(flags.direction)) {
      throw new CliUsageError(
        `invalid --direction "${flags.direction}" (expected one of ${SORT_DIRECTIONS.join(", ")})`,
      );
    }
    f.direction = flags.direction as EntryFilters["direction"];
  }
  if (flags.before !== undefined) f.before = parseIntOption(flags.before);
  if (flags.after !== undefined) f.after = parseIntOption(flags.after);
  if (flags["before-entry-id"] !== undefined) f.beforeEntryId = parseIntOption(flags["before-entry-id"]);
  if (flags["after-entry-id"] !== undefined) f.afterEntryId = parseIntOption(flags["after-entry-id"]);
  if (flags.starred !== undefined) f.starred = parseBoolOption(flags.starred);
  return f;
}

function help(): string {
  return `Usage:
  miniflux <command> [args]

Read commands:
  healthcheck                          Check if the Miniflux instance is reachable
  me                                   Get the currently authenticated user
  user-by-id <id>                      Get a user by numeric ID
  user-by-name <username>              Get a user by username
  feeds                                List all subscribed feeds
  feed <id>                            Get a single feed by ID
  feed-icon <id>                       Get the favicon/icon for a feed by ID
  discover <url>                       Discover RSS/Atom feeds available at a URL
  categories                           List all feed categories
  entries [filters]                    List/filter entries
  entry <id>                           Get a single entry by ID
  feed-entries --feed-id <id> [filters]  Get entries for a specific feed
  export-opml                          Export all feeds as OPML XML

Write commands:
  import-opml <opml|@file|->           Import feeds from an OPML XML string or file
  create-category <title>              Create a new feed category
  update-category <id> <title>         Rename a category
  delete-category <id>                 Delete a category (feeds move to default)
  create-feed <feed-url> <category-id> Subscribe to a feed by URL
  update-feed <id> [--title <t>] [--category-id <n>] [--feed-url <u>] [--site-url <u>] [--user-agent <ua>]
  delete-feed <id>                     Unsubscribe from a feed by ID
  refresh-feed <id>                    Trigger a synchronous refresh of a feed
  mark <entry-ids...> --status <s>     Mark one or more entries as read/unread/removed
  bookmark <id>                        Toggle the bookmark/star status of an entry

Entry filters (for entries / feed-entries):
  --status <s>      read | unread | removed
  --offset <n>      pagination offset
  --limit <n>       result limit (recommend 20)
  --order <o>       id | status | published_at | category_title | category_id | author | title
  --direction <d>   asc | desc
  --before <ts> / --after <ts>                 Unix timestamps
  --before-entry-id <id> / --after-entry-id <id>
  --starred <bool>  true/false

Options:
  -h, --help        Show this help
  -V, --version     Show version

Environment: MINIFLUX_URL and MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) are required.
Output: JSON on stdout, errors on stderr. Exit: 0 ok, 1 error.`;
}