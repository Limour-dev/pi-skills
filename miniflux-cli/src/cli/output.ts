/**
 * Output helpers: JSON for data, plain text for messages and OPML.
 */

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function printText(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}
