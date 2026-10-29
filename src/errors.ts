export type ErrorCode =
  | "USAGE"
  | "NOT_A_NOTEBOOK"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "SECRET_DETECTED"
  | "STALE_REVISION"
  | "INVALID_TRANSITION"
  | "LOCK_TIMEOUT"
  | "DIRTY_TARGET"
  | "REPO_STATE"
  | "COMMIT_FAILED"
  | "ATTACHMENT_TOO_LARGE"
  | "PORT_IN_USE"
  | "UNSAFE_PATH"
  | "INTERNAL";

export class NotebookError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "NotebookError";
    this.code = code;
    this.details = details;
  }
}
