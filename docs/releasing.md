# Release checklist

## Verify a clean checkout

Use Bun 1.3.11 or later and Git:

```sh
bun install --frozen-lockfile
bun run typecheck
LUNA_HOME="$(mktemp -d)" bun test
bun run build
bun dist/luna-client.js version
bun dist/luna-service.js version
bun dist/luna-worker.js --help
```

A temporary `LUNA_HOME` keeps tests from reading an existing installation.
Clean it up afterward. CI checks pushes and pull requests; it does not publish
npm packages or deploy services. Configure the required CI check in branch
protection when appropriate.

For runtime changes, follow [AGENTS.md](../AGENTS.md): restart the current build,
confirm the listener and verify real API behavior. Dashboard changes require an
authenticated browser check. Skipped integration tests do not establish Docker,
provider or channel readiness. Verify enabled integrations in the target
environment without injecting production credentials into public PR jobs.

## Review distribution contents

Review the candidate tree and Git history for credentials, private business data,
internal links and local deployment files. `.gitignore` prevents new additions;
it does not remove tracked files or historical content. Revoke exposed real
credentials before addressing repository history.

Maintainers must confirm source and dependency distribution rights and provide
an appropriate license before publication. Check external plugin packages and
provider configuration independently. Public docs must not depend on files in
`docs/local/` or `container/local/`.

## Verify deployment configuration

Use a unique Dashboard token and HTTPS. Protect Service environment files,
databases, encryption keys and Worker credentials. A reverse proxy does not
remove the need for an explicit token. See
[Authorization](designs/auth-and-permissions.md) for initial administrator setup
and the [deployment guide](runbooks/deploy-luna.md) for configuration and backups.

## Source and package releases

GitHub source publication and npm package publication are separate actions.
The root workspace is private. Scripts under `scripts/release/` assist packaging;
they do not establish that packages have been published or installed correctly.
Verify packaged resources and a clean-machine installation before distributing
an installable release. Use a specific source revision and image tag so the
release can be reproduced and rolled back.
