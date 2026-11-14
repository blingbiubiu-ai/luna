export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string;

  constructor(code: string, message: string, status: number, traceId = "") {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.traceId = traceId;
  }

  toJSON(): Record<string, string | number> {
    const data: Record<string, string | number> = {
      code: this.code,
      message: this.message,
      status: this.status,
    };
    if (this.traceId) {
      data.traceId = this.traceId;
    }
    return data;
  }
}
