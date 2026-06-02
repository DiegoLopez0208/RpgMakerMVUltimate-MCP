export class NotFoundError extends Error {
  constructor(dataType: string, id: number | string) {
    super(dataType + " with ID " + String(id) + " not found");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(field: string, value: unknown, message: string) {
    super("Invalid " + field + " '" + String(value) + "': " + message);
    this.name = "ValidationError";
  }
}

export class FileOperationError extends Error {
  constructor(path: string, operation: string, cause?: Error) {
    super("Failed to " + operation + " at " + path + (cause ? ": " + cause.message : ""));
    this.name = "FileOperationError";
    if (cause) this.stack = cause.stack;
  }
}

export class ExternalServiceError extends Error {
  constructor(service: string, endpoint: string, cause?: Error) {
    super(service + " request to " + endpoint + " failed" + (cause ? ": " + cause.message : ""));
    this.name = "ExternalServiceError";
    if (cause) this.stack = cause.stack;
  }
}
