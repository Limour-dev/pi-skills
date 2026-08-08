#!/usr/bin/env node
/**
 * miniflux CLI entry point.
 * Reads MINIFLUX_URL and MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) from the environment.
 */
import { MinifluxClient } from "./api/client.ts";
import { loadConfig } from "./api/config.ts";
import { MinifluxError } from "./api/error.ts";
import { createProgram } from "./cli/program.ts";
import { printError } from "./cli/output.ts";
import { CliUsageError } from "./cli/parsers.ts";
const program = createProgram(() => new MinifluxClient(loadConfig()));

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv.slice(2));
  } catch (err) {
    if (err instanceof MinifluxError || err instanceof CliUsageError) {
      printError(err.message);
      process.exitCode = 1;
      return;
    }
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
