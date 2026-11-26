import { z } from "zod";
/** Opaque identifiers are never interpreted as filesystem paths. */
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/)
  .refine(id => id !== "." && id !== "..", "Invalid identifier");
