export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (code: string, message: string) => new ApiError(404, code, message);

/** Wraps a Supabase/PostgREST error so internals never reach the client. */
export function dbError(error: { message: string; code?: string }): ApiError {
  console.error("[db]", error.code, error.message);
  return new ApiError(500, "DATABASE_ERROR", "A database error occurred.");
}

/**
 * A research step failed. `kind` selects the user-facing reason (see toJobError);
 * `message` is internal and only ever logged.
 */
export class StepFailure<K extends string = string> extends Error {
  constructor(
    public readonly kind: K,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
