/**
 * Command-handled sentinel.
 *
 * Thrown by slash-command handlers to signal that the command output
 * has already been injected and no further processing is needed.
 */

export const COMMAND_HANDLED_SENTINEL = "__QUOTA_COMMAND_HANDLED__" as const;

/**
 * Throw the command-handled sentinel.
 * Use this instead of `throw new Error("__QUOTA_COMMAND_HANDLED__")`.
 */
export function handled(): never {
  throw new Error(COMMAND_HANDLED_SENTINEL);
}

/**
 * Returns true when an error is the command-handled sentinel.
 */
export function isCommandHandledError(err: unknown): boolean {
  return err instanceof Error && err.message === COMMAND_HANDLED_SENTINEL;
}
