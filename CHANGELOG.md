# Changelog

See [Upgrade from v1 to v2](README.md#upgrade-from-v1-to-v2) in the README for the changes to check when upgrading a microservice to v2.

## v2.0.0-beta.3 (2026-10-26)

### New features
- Node.js 24 (was 22). Babel and TypeScript target it.
- `/config` overrides are applied in a temporary folder (`$TMPDIR`, default `/tmp`) at startup instead of being resolved by a module loader. This is closer to how v1 works:
  - files read with `fs` from the microservice's `config/` folder pick up overrides again, as in v1
  - Babel runs in a separate process at startup, which saves about 45MB of memory in the running service when overrides are used
  - without overrides, the microservice starts from the image as before
- Integration tests for the template itself: `./test/run.sh`

### Fixes
- The image is about 5MB smaller: leftovers in `/tmp` from the build are removed
- Development mode copies a `/config` mounted as a Kubernetes ConfigMap correctly (its `..data` entries are skipped and symlinked files are followed) and picks up changed files of the same size

### Breaking changes since v2.0.0-beta.2
- Node.js 24: make sure the dependencies of your microservice support it
- With a read-only root filesystem and overrides in `/config`, mount a writable volume (e.g. an `emptyDir`) on `/tmp`
- `MU_CONFIG_WARN_DELAY_MS` is removed, overrides read with `fs` work without changes

## v2.0.0-beta.2 (2026-10-07)

### New features
- Test mode: `NODE_ENV=test` runs the tests of the service

### Fixes
- JSON imports work: they keep their extension and get an import attribute instead of being rewritten to `.json.js`
- The build no longer fails when the config folder only contains dotfiles (e.g. a `.gitkeep`)
- Development mode as a non-root user no longer fails on rsync setting times on symlinks

## v2.0.0-beta.1 (2026-10-05)

### New features
- Node.js 22 on a slim base image (about 3x smaller)
- `/config` overrides are resolved at runtime: `/config` may be mounted read-only (e.g. a Kubernetes ConfigMap) and overrides may be written in JavaScript, TypeScript or CoffeeScript
- Run as an arbitrary non-root user (e.g. OpenShift)
- arm64 images for feature and latest builds
- `on-build.sh` runs before dependencies are installed, so it can install system libraries required by npm packages

### Fixes
- The build fails when installing dependencies or transpiling fails, instead of producing an image which does not start
- No SELinux xattr errors from rsync in the logs
- No longer adds a second `"type"` to `package.json`

### Breaking changes
- Node.js 22 and a slim base image without build tools
- `sparql-client-2` is replaced by `fetch`; `newSparqlClient` is removed
- Files in `/config` read with `fs` must be read from `/config` directly

Earlier releases are listed on the [releases page of mu-semtech/mu-javascript-template](https://github.com/mu-semtech/mu-javascript-template/releases).
