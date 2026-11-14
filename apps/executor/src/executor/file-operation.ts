import { FileOperation } from "@luna/runner-protocol";
import { ContextFiles } from "./files";
import type { ExecutionContext } from "./contexts";

/** Synchronous operations finish before the HTTP response; writes replace files atomically. */
export function executeFileOperation(context: ExecutionContext, input: unknown): unknown {
  const operation = FileOperation.parse(input);
  const files = new ContextFiles(context.cwd, context.uid, context.gid);
  switch (operation.kind) {
    case "provision":
      for (const path of ["workspace", ".luna"]) files.mkdir(path);
      return { home: context.home, cwd: context.cwd };
    case "mkdir": files.mkdir(operation.path); return null;
    case "write_batch": return operation.files.map(file => files.write(file.path, file.content, file.sha256, file.executable));
    case "write": return files.write(operation.path, operation.content, operation.sha256, operation.executable);
    case "read": return files.read(operation.path);
    case "list": return files.list(operation.path);
    case "stat": return files.stat(operation.path);
    case "delete": files.delete(operation.path); return null;
  }
}
