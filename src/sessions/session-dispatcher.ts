import type { DrizzleDB } from "@/data";

export type SessionDispatchInput =
  | { kind: "user_messages"; sessionId: string }
  | { kind: "task_result"; sessionId: string }
  | { kind: "session_trigger"; sessionId: string }
  | { kind: "message_delivery"; sessionId: string };

/** One execution lane per session, shared by every ingress using this database.
 * Persistence and domain recovery belong to the source inbox, not this lock.
 */
export class SessionDispatcher {
  private readonly tails = new Map<string, Promise<void>>();

  async dispatch<T>(input: SessionDispatchInput, execute: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(input.sessionId, tail);
    await previous;
    try {
      return await execute();
    } finally {
      release();
      if (this.tails.get(input.sessionId) === tail) this.tails.delete(input.sessionId);
    }
  }
}

const dispatchers = new WeakMap<DrizzleDB, SessionDispatcher>();
export function sessionDispatcherFor(db: DrizzleDB): SessionDispatcher {
  let dispatcher = dispatchers.get(db);
  if (!dispatcher) {
    dispatcher = new SessionDispatcher();
    dispatchers.set(db, dispatcher);
  }
  return dispatcher;
}
