export class UnlocalhostError extends Error {
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, exitCode = 1, details?: unknown) {
    super(message);
    this.name = "UnlocalhostError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
