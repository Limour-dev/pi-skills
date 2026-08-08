# Architecture

Guidance for agents (and humans) modifying this CLI. Read this before making
changes; `README.md` covers user-facing usage, `SKILL.md` is the AI-agent
contract (command names/flags there are **load-bearing** — agents rely on
them, so don't rename commands without updating SKILL.md).

## Layered structure

```
src/index.ts          entry point only: wires client factory into the program,
                      parses argv, maps errors to stderr + exit code 1
│
├─ src/api/           framework-free Miniflux v2 API layer (no commander, no process.*)
│    types.ts         API types + const unions (ENTRY_STATUSES, ENTRY_ORDER_FIELDS,
│                     SORT_DIRECTIONS). Const arrays are the single source of truth;
│                     types are derived from them via `(typeof X)[number]`.
│    error.ts         MinifluxError { message, status? }. `status` set iff the error
│                     came from an HTTP response (used by healthcheck fallback logic).
│    config.ts        loadConfig(env) reads MINIFLUX_URL / MINIFLUX_API_KEY (fallback
│                     MINIFLUX_API_TOKEN); normalizeBaseUrl() strips trailing "/" and
│                     one trailing "/v1" (case-insensitive), requires http(s) scheme.
│    client.ts        MinifluxClient: one method per API endpoint, all typed.
│                     Pure helpers exported for testability: buildEntryQuery(),
│                     buildUpdateFeedBody().
│
└─ src/cli/           arg-parsing layer (imports api/, never the reverse)
     parsers.ts       parseId / parseIntOption / parseBoolOption — throw CliUsageError
                      so failures become clean one-line errors.
     output.ts        printJson (pretty, stdout) / printText (stdout) / printError
                      (stderr). Data commands print JSON; confirmation messages and
                      OPML print text — this split is documented in SKILL.md.
     program.ts       createProgram(clientFactory): builds every subcommand.
                      The client is injected as a factory (lazy — constructed inside
                      each action, so missing env vars fail per-command, and tests
                      can inject a mock-backed client).
```

Dependency rule: `cli → api`, never `api → cli`. Nothing in `api/` may touch
`process.stdout`/`process.exit`; it communicates via return values and
`MinifluxError`.

## Request flow

```
argv → parseArgs → command handler → clientFactory() (= new MinifluxClient(loadConfig()))
     → client method → fetchWithTimeout (AbortController, default 30s)
     → parseResponse: !ok → MinifluxError with server's error_message;
                      204 / content-length:0 / empty body → undefined;
                      JSON parse failure → MinifluxError (never a raw SyntaxError)
action prints via output.ts; thrown errors bubble to main() in index.ts
```

- Auth: `X-Auth-Token` header on every request.
- Paths: `endpoint()` always produces `{baseUrl}/v1/{path}` — client methods
  pass paths *without* a leading `/v1`.
- Raw-text endpoints (OPML) go through `requestRaw()` instead of `request()`:
  no JSON parse, `Content-Type: text/xml` only when there is a body.

## healthcheck fallback (intentional subtlety)

`client.healthcheck()` calls `/v1/healthcheck` first. It falls back to probing
`{baseUrl}/` **only** when that endpoint is missing (404, older Miniflux
versions) or unreachable (network error, `status === undefined`). Any other
HTTP error — notably 401 — is rethrown, so bad credentials fail loudly
instead of being masked by a reachable homepage. Preserve this logic.

## CLI conventions

- IDs go through `parseId` (positive integer). Counts/timestamps through
  `parseIntOption`, booleans through `parseBoolOption`. Don't re-implement
  parsing in actions.
- Constrained values use `new Option(...).choices([...CONST_ARRAY])` so the
  CLI and client share one vocabulary (e.g. `mark --status`, `--order`,
  `--direction`). `mark --status` is also mandatory (`makeOptionMandatory`).
- `feed-entries` requires `--feed-id` (requiredOption); plain `entries` has no
  `--feed-id` by design.
- Shared filter set for `entries`/`feed-entries` lives in
  `addEntryFilterOptions()` + `filtersFromOptions()`; a new filter needs both,
  plus the field in `EntryFilters` (types.ts) and a line in `buildEntryQuery`.
- Success messages: `"<Noun> <verb>ed successfully"` via `printText`.

## How to add…

**A new read endpoint**
1. Add response type to `src/api/types.ts`.
2. Add typed method to `MinifluxClient`.
3. Add subcommand in `src/cli/program.ts` (read section), action:
   `printJson(await makeClient().method(...))`.
4. Document it in `SKILL.md` and `README.md`.
5. Mock route in `test/client.test.ts` (`beforeEach` route table) + assertion
   on recorded request; if user-visible, an e2e case in `test/cli.test.ts`.

**A new write endpoint** — same, but confirm with `printText("… successfully")`
on void responses, and add runtime validation where the API constrains values
(see `updateEntryStatus`).

**A new entry filter** — types.ts (`EntryFilters`) → client.ts
(`buildEntryQuery`, snake_case API param!) → program.ts (`addEntryFilterOptions`
+ `filtersFromOptions`) → SKILL.md filter list → tests.

## Testing

`npm test` = `tsx --test test/*.test.ts` (node:test runner, zero extra deps,
runs fully offline).

- `test/helpers/mock-server.ts` — `startMockServer(routes)` boots an HTTP
  server on a random port; records every request (method, url, pathname,
  headers, body) for assertions; `close()` destroys open sockets (needed by
  the hanging-server timeout test).
- `client.test.ts` — per-test server via `beforeEach`/`afterEach`; tests that
  need a *different* route table start their own server and close it in
  `finally`.
- `cli.test.ts` — spawns the real CLI: `node_modules/.bin/tsx src/index.ts`
  (paths resolved from `import.meta.url`, so it works from any cwd). Env vars
  point at the mock server. Assert on exit code, stdout JSON, stderr text.
  Note: the CLI exits 1 itself for both usage errors (`CliUsageError`) and
  runtime errors (`MinifluxError`); `main()` sets `exitCode = 1`.

`npm run typecheck` checks src with `tsconfig.json` and tests with
`tsconfig.test.json` (extends the base config, `noEmit`, includes `test/`).
Don't add `test/` to the base tsconfig — keep it scoped to `src/`.

## Build & constraints

- ESM (`"type": "module"`); relative imports use `.ts` extensions so Node's
  native type stripping (Node >= 22.6) runs the sources directly — no build step.
  `tsc --noEmit` typechecks; `tsconfig.json` sets `allowImportingTsExtensions`
  and `noEmit`.
- `bin/miniflux` is the entry point: a bash wrapper that runs
  `node src/index.ts`. No compilation, no `dist/`, no `npm install` needed.
- Node >= 22.6 required (global `fetch`, `AbortController`, type stripping).
  Zero runtime dependencies — commander is gone; args are parsed by hand in
  `src/cli/program.ts` and `src/cli/parsers.ts` (errors via `CliUsageError`).
- Keep the public command surface stable: SKILL.md compatibility is the
  contract. Tests run via tsx (dev-only), typecheck via tsc.
## Known intentional behaviors

- `normalizeBaseUrl` strips only **one** trailing `/v1` (`/v1/v1` → `/v1`).
- `parseIntOption` accepts negatives/zero (needed for future timestamp math),
  `parseId` rejects them.
- `import-opml` argument forms: inline XML, `@/path/to/file`, `-` (stdin,
  via `readFileSync(0)`).
- `updateEntryStatus` double-validates status (CLI-side check + client
