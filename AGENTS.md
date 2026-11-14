# AGENTS.md

## Runtime Verification

For changes that affect the Luna service, dashboard UI, routes, plugin loading, runners, artifacts, or Feishu delivery, automated tests are not enough. After implementation:

1. Run the relevant tests, typecheck, and build.
2. Stop the old local Luna service on port `8090`.
3. Restart the real service from the current worktree/build.
4. Confirm the new process is listening with `lsof -nP -iTCP:8090 -sTCP:LISTEN`.
5. Verify the changed dashboard or API behavior against `http://127.0.0.1:8090`.

For dashboard changes, log in to the real dashboard and inspect the affected routes in a browser. Do not claim the dashboard behavior is verified from component tests alone.

When manually running the local agent in this environment, `bun dist/luna-service.js start --foreground --port 8090` may need to stay attached to a persistent terminal session. If a detached background command exits immediately, do not treat that as a successful restart; rerun in a persistent session and verify the port and page response.

## Architecture Documentation

When a change affects component responsibilities, module boundaries, core data
flows, persistence models, runtime topology, plugin mechanisms, runner
isolation, authorization models, or deployment structure, update the relevant
current-state architecture document under `docs/designs/` in the same change.

If no current-state document covers the affected architecture, add one under
`docs/designs/`. A change-specific spec or plan under `docs/superpowers/` does
not replace this requirement.

Changes limited to implementation details do not require a documentation diff
when they leave the documented architecture unchanged. Confirm that the
existing architecture documents remain accurate before completing the change.
