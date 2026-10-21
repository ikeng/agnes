export class AgnesCliError extends Error {
  code: string;
  details?: unknown;
  exitCode: number;

  constructor(code: string, message: string, details?: unknown, exitCode = 1) {
    super(message);
    this.name = "AgnesCliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function isAgnesCliError(error: unknown): error is AgnesCliError {
  return error instanceof AgnesCliError;
}
