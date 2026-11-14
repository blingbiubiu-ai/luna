import { v4 as uuidv4 } from "uuid";

/**
 * Executes uuid logic for shared utility.
 */
export function uuid(): string {
  return uuidv4();
}
