export class McjsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "McjsError";
  }
}

export function errorData(error: unknown) {
  return {
    code: error instanceof McjsError ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: error instanceof McjsError && error.retryable,
  };
}

export function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new McjsError("INVALID_ARGUMENT", message);
  return value;
}
