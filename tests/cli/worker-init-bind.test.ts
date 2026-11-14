import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkerCli } from "../../apps/worker/src/cli";

test("init is local; bind preserves execution settings and start requires a binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "luna-init-bind-"));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    expect(await request.json()).toEqual({ code: "test-code" });
    expect(request.headers.has("authorization")).toBe(false);
    return Response.json({ workerId: "remote", runtimeId: "runtime", token: "t".repeat(43), projectId: "server-project" });
  }});
  try {
    const home = join(root, "worker"), bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho sha256:${"a".repeat(64)}\n`, { mode: 0o755 });
    const args = ["--home", home], env = { PATH: bin, LUNA_WORKER_BIND_CODE: "test-code" };
    expect((await runWorkerCli(["bind", "--service", server.url.origin, ...args], env)).code).toBe("worker_not_initialized");
    expect((await runWorkerCli(["init", "--image", "custom:android", "--port", "8192", ...args], env)).status).toBe("ok");
    const before = readFileSync(join(home, "worker.json"), "utf8");
    expect(JSON.parse(before)).toMatchObject({ port: 8192, imageDigest: `sha256:${"a".repeat(64)}` });
    expect(JSON.parse(before).runtimeId).toBeUndefined();
    expect(existsSync(join(home, "binding.json"))).toBe(false);
    expect(requests).toBe(0);
    expect((await runWorkerCli(["start", ...args], env)).code).toBe("worker_not_bound");
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    expect((await runWorkerCli(["bind", "--service", server.url.origin, ...args], env)).status).toBe("ok");
    expect(requests).toBe(1);
    expect(readFileSync(join(home, "worker.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(home, "binding.json"), "utf8"))).toEqual({ workerId: "remote", runtimeId: "runtime", controlToken: "t".repeat(43), serviceUrl: server.url.origin });
    expect((await runWorkerCli(["bind", "--service", server.url.origin, "--image", "other", ...args], env)).code).toBe("worker_local_option");
    expect((await runWorkerCli(["init", ...args], env)).code).toBe("configuration_exists");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
