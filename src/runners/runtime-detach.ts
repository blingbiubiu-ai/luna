/** Service shutdown drops local observation while the durable remote Job keeps running. */
export class RuntimeDetachedError extends Error {
  constructor() { super("Service detached from the Runtime Job"); this.name = "RuntimeDetachedError"; }
}
