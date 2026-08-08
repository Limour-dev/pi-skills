/**
 * Error type for Miniflux API and connectivity failures.
 */
export class MinifluxError extends Error {
  /** HTTP status code, when the error came from an API response. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MinifluxError";
    this.status = status;
  }
}
