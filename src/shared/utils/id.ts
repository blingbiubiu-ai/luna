import { uuid } from "./uuid";

/**
 * Creates a prefixed stable identifier for persisted Luna records.
 */
export function createId(prefix: string): string {
  return `${prefix}_${uuid()}`;
}
