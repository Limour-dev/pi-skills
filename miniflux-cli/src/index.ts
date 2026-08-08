#!/usr/bin/env node
/**
 * miniflux CLI entry point.
 * Reads MINIFLUX_URL and MINIFLUX_API_KEY (or MINIFLUX_API_TOKEN) from the environment.
 */
import { MinifluxClient } from "./api/client.js";
import { loadConfig } from "./api/config.js";
import { MinifluxError } from "./api/error.js";
import { createProgram } from "./cli/program.js";
import { printError } from "./cli/output.js";

const program = createProgram(() => new MinifluxClient(loadConfig()));

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof MinifluxError) {
      printError(err.message);
      process.exitCode = 1;
      return;
    }
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main();
