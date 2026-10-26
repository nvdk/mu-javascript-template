#!/bin/bash
# Integration tests for the template.
#
# Builds the template image, then runs a fixture service on top of it in
# production mode, production mode with a mounted /config and development
# mode, and checks its endpoints.
#
# Only talks to the docker daemon (docker cp and docker exec instead of bind
# mounts and published ports) so it works against docker-in-docker in CI too.
#
# Usage: ./test/run.sh

set -euo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$TEST_DIR")"
ID="mu-js-template-test-$$"
TEMPLATE_IMAGE="$ID-template"
SERVICE_IMAGE="$ID-service"
LOCKED_IMAGE="$ID-locked"
NETWORK="$ID"
WORK_DIR="$(mktemp -d)"
CONTAINERS=()
FAILURES=0

cleanup() {
  docker rm -f "${CONTAINERS[@]}" > /dev/null 2>&1 || true
  docker network rm "$NETWORK" > /dev/null 2>&1 || true
  docker volume rm -f "$ID-config" > /dev/null 2>&1 || true
  docker rmi -f "$LOCKED_IMAGE" "$SERVICE_IMAGE" "$TEMPLATE_IMAGE" > /dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log() {
  echo "==> $*"
}

pass() {
  echo "  ok   $1"
}

# fail DESCRIPTION [DETAIL...]
fail() {
  echo "  FAIL $1"
  shift
  for detail in "$@"; do
    echo "       $detail"
  done
  FAILURES=$((FAILURES + 1))
}

# create NAME [docker create args...]
create() {
  local name="$ID-$1"
  shift
  docker create --name "$name" --network "$NETWORK" --network-alias "${name#$ID-}" "$@" > /dev/null
  CONTAINERS+=("$name")
}

# request CONTAINER PATH [wget args...]
# Requests PATH on the service from inside its own container.
request() {
  local container="$ID-$1" path="$2"
  shift 2
  docker exec "$container" wget -qO- --content-on-error "$@" "http://localhost:80$path"
}

# wait_for CONTAINER
wait_for() {
  local container="$1"
  for _ in $(seq 1 180); do
    if request "$container" /status > /dev/null 2>&1; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$ID-$container")" != "true" ]; then
      break
    fi
    sleep 1
  done
  echo "Service $container did not come up, logs:"
  docker logs "$ID-$container" 2>&1 | tail -50
  return 1
}

# check CONTAINER DESCRIPTION JQ_EXPRESSION PATH [wget args...]
check() {
  local container="$1" description="$2" expression="$3" path="$4"
  shift 4
  local body
  body="$(request "$container" "$path" "$@" 2>&1 || true)"
  if echo "$body" | docker exec -i "$ID-$container" jq -e "$expression" > /dev/null 2>&1; then
    pass "$description"
  else
    fail "$description" "expected $path to match: $expression" "got: $body"
  fi
}

# check_header CONTAINER DESCRIPTION HEADER_REGEX PATH [wget args...]
# Checks the response headers the service sends to its client.
check_header() {
  local container="$1" description="$2" pattern="$3" path="$4"
  shift 4
  local headers
  headers="$(docker exec "$ID-$container" wget -S -qO /dev/null --content-on-error "$@" "http://localhost:80$path" 2>&1 || true)"
  if echo "$headers" | grep -qiE "$pattern"; then
    pass "$description"
  else
    fail "$description" "expected a header matching: $pattern" "got: $headers"
  fi
}

# check_file CONTAINER DESCRIPTION PATH
check_file() {
  local container="$1" description="$2" path="$3"
  if docker exec "$ID-$container" test -e "$path"; then
    pass "$description"
  else
    fail "$description" "$path does not exist"
  fi
}

# check_service CONTAINER CONFIG_SOURCE
# CONFIG_SOURCE is either default or mounted.
check_service() {
  local container="$1" source="$2" extra='null'
  if [ "$source" == "mounted" ]; then
    extra='"mounted"'
  fi
  check "$container" "runs on node 24" '.node | startswith("v24.")' /status
  check "$container" "mu import (uuid)" '.uuid | test("^[0-9a-f-]{36}$")' /status
  check "$container" "mu import (sparqlEscapeString)" '.escaped == "\"\"\"say \\\"hi\\\"\"\"\""' /status
  check "$container" "mu default import" '.defaultImport == "function"' /status
  check "$container" "commonjs dependency" '.dependency == 7200000' /status
  check "$container" "esm-only dependency" '.esmDependency == 21' /status
  check "$container" "typescript source" '.typescript == "hello template"' /status
  check "$container" "coffeescript source" '.coffeescript == "TEMPLATE!"' /status
  check "$container" "js config is $source" ".config == \"$source\"" /status
  check "$container" "json config is $source" ".jsonConfig == \"$source\"" /status
  check "$container" "nested config is $source" ".nestedConfig == \"$source\"" /status
  check "$container" "typescript config is $source" ".typescriptConfig == \"$source\"" /status
  check "$container" "config without default is $extra" ".extraConfig == $extra" /status
  check "$container" "sparql query reaches endpoint" \
        '.result.results.bindings[0].query.value | contains("\"\"\"o\"\"\"")' /sparql
  check "$container" "sparql query forwards mu-session-id" \
        '.result.results.bindings[0].session.value == "http://test/session"' /sparql \
        --header "mu-session-id: http://test/session"
}

# mu_header HEADER
# jq expression extracting a mu header as received by the SPARQL endpoint.
mu_header() {
  echo ".result.results.bindings[0].headers.value | fromjson | .[\"$1\"]"
}

# check_mu_auth CONTAINER SUDO_ALLOWED DEFAULT_SCOPE
check_mu_auth() {
  local container="$1" sudo_allowed="$2" default_scope="$3"
  check "$container" "sparql query forwards mu-call-id" \
        "$(mu_header mu-call-id) == \"42\"" /sparql --header "mu-call-id: 42"
  check "$container" "sparql query forwards incoming mu-auth-allowed-groups" \
        "$(mu_header mu-auth-allowed-groups) == \"[{\\\"name\\\":\\\"from-client\\\"}]\"" /sparql \
        --header 'mu-auth-allowed-groups: [{"name":"from-client"}]'
  check_header "$container" "response carries mu-auth-allowed-groups from database" \
               'mu-auth-allowed-groups: \[\{"name":"from-database"\}\]' /sparql
  check_header "$container" "response carries mu-auth-used-groups from database" \
               'mu-auth-used-groups: \[\{"name":"used-by-database"\}\]' /sparql
  if [ "$sudo_allowed" == "true" ]; then
    check "$container" "sudo query sends mu-auth-sudo" "$(mu_header mu-auth-sudo) == \"true\"" '/sparql?sudo=true'
  else
    check "$container" "sudo query is refused without ALLOW_MU_AUTH_SUDO" \
          '.error | contains("ALLOW_MU_AUTH_SUDO")' '/sparql?sudo=true'
    check "$container" "regular query does not send mu-auth-sudo" \
          "$(mu_header mu-auth-sudo) == null" /sparql
  fi
  if [ -n "$default_scope" ]; then
    check "$container" "query uses DEFAULT_MU_AUTH_SCOPE" "$(mu_header mu-auth-scope) == \"$default_scope\"" /sparql
  else
    check "$container" "query sends no mu-auth-scope by default" "$(mu_header mu-auth-scope) == null" /sparql
  fi
  check "$container" "query scope option is sent" \
        "$(mu_header mu-auth-scope) == \"http://test/scope\"" '/sparql?scope=http%3A%2F%2Ftest%2Fscope'
}

# check_sparql_errors CONTAINER
check_sparql_errors() {
  local container="$1"
  check "$container" "sparql server error rejects the query" '.error | contains("HTTP 500")' '/sparql?respond=500'
  check "$container" "sparql non-json response resolves to null" '.result == null' '/sparql?respond=text'
  check "$container" "service keeps running after sparql errors" '.node | startswith("v24.")' /status
}

# check_debugger CONTAINER
# Attaches to the inspector from another container, like a developer's
# debugger would through a forwarded port.
check_debugger() {
  local container="$1" ip output
  ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$ID-$container")"
  if output="$(docker exec "$ID-database" node /inspect.mjs "$ip" 2>&1)" \
      && echo "$output" | grep -q 'start-server.js'; then
    pass "debugger attaches and evaluates code"
  else
    fail "debugger attaches and evaluates code" "got: $output"
  fi
}

# check_shutdown CONTAINER
# docker stop should run beforeExit callbacks and stop well within its timeout.
check_shutdown() {
  local container="$1" start elapsed logs
  start="$(date +%s)"
  docker stop -t 20 "$ID-$container" > /dev/null
  elapsed=$(( $(date +%s) - start ))
  logs="$(docker logs "$ID-$container" 2>&1)"
  if [ "$elapsed" -lt 10 ]; then
    pass "docker stop finishes quickly (${elapsed}s)"
  else
    fail "docker stop finishes quickly" "took ${elapsed}s, the process was likely killed"
  fi
  if echo "$logs" | grep -q 'beforeExit callback ran'; then
    pass "beforeExit callbacks run on stop"
  else
    fail "beforeExit callbacks run on stop" "last logs: $(echo "$logs" | tail -5)"
  fi
  if echo "$logs" | grep -q 'Shut down complete'; then
    pass "server closes on stop"
  else
    fail "server closes on stop" "last logs: $(echo "$logs" | tail -5)"
  fi
}

log "Building template image"
docker build -q -t "$TEMPLATE_IMAGE" "$ROOT_DIR" > /dev/null

log "Building fixture service image (ONBUILD)"
echo "FROM $TEMPLATE_IMAGE" | docker build -q -t "$SERVICE_IMAGE" -f - "$TEST_DIR/fixtures/service" > /dev/null

docker network create "$NETWORK" > /dev/null

log "Starting mock SPARQL endpoint"
create database --entrypoint node "$TEMPLATE_IMAGE" /mock-sparql.mjs
docker cp "$TEST_DIR/mock-sparql.mjs" "$ID-database:/mock-sparql.mjs"
docker cp "$TEST_DIR/inspect.mjs" "$ID-database:/inspect.mjs"
docker start "$ID-database" > /dev/null

log "Production mode"
create production "$SERVICE_IMAGE"
docker start "$ID-production" > /dev/null
wait_for production
check_service production default
check_mu_auth production false ""
check_sparql_errors production

log "Production mode with mu-auth options"
create production-auth -e ALLOW_MU_AUTH_SUDO=true -e DEFAULT_MU_AUTH_SCOPE=http://test/default-scope "$SERVICE_IMAGE"
docker start "$ID-production-auth" > /dev/null
wait_for production-auth
check_mu_auth production-auth true http://test/default-scope

log "Production mode with mounted /config"
create production-config "$SERVICE_IMAGE"
docker cp "$TEST_DIR/fixtures/config/." "$ID-production-config:/config"
docker start "$ID-production-config" > /dev/null
wait_for production-config
check_service production-config mounted

log "Production mode as an arbitrary user with a read-only filesystem and ConfigMap"
# Lay out the volume like Kubernetes mounts a ConfigMap: the files live in a
# timestamped folder, linked through ..data
docker volume create "$ID-config" > /dev/null
create config-fill -v "$ID-config:/data" --entrypoint sh "$TEMPLATE_IMAGE" \
       -c 'cd /data && ln -s ..2026_01_01_00_00_00.0 ..data && for f in ..data/*; do ln -s "$f" "$(basename "$f")"; done'
docker cp "$TEST_DIR/fixtures/config/." "$ID-config-fill:/data/..2026_01_01_00_00_00.0"
docker start -a "$ID-config-fill" > /dev/null
create production-readonly --user 1001:0 --read-only --tmpfs /tmp -v "$ID-config:/config:ro" "$SERVICE_IMAGE"
docker start "$ID-production-readonly" > /dev/null
wait_for production-readonly
check_service production-readonly mounted

log "Production build with package-lock.json"
cp -r "$TEST_DIR/fixtures/service" "$WORK_DIR/locked"
docker run --rm -i --entrypoint sh "$TEMPLATE_IMAGE" \
       -c 'mkdir /tmp/lock && cd /tmp/lock && cat > package.json && npm install --package-lock-only > /dev/null 2>&1 && cat package-lock.json' \
       < "$WORK_DIR/locked/package.json" > "$WORK_DIR/locked/package-lock.json"
if output="$(echo "FROM $TEMPLATE_IMAGE" | docker build --no-cache --progress=plain -t "$LOCKED_IMAGE" -f - "$WORK_DIR/locked" 2>&1)"; then
  pass "build with package-lock.json succeeds"
else
  fail "build with package-lock.json succeeds" "$(echo "$output" | tail -20)"
fi
if echo "$output" | grep -q 'Installing dependencies from package-lock.json'; then
  pass "build installs from package-lock.json"
else
  fail "build installs from package-lock.json"
fi
create production-locked "$LOCKED_IMAGE"
docker start "$ID-production-locked" > /dev/null
wait_for production-locked
check production-locked "locked dependencies are installed" '.dependency == 7200000 and .esmDependency == 21' /status

log "Production build with outdated package-lock.json"
cp -r "$WORK_DIR/locked" "$WORK_DIR/outdated"
docker run --rm -i --entrypoint jq "$TEMPLATE_IMAGE" '.dependencies.pluralize = "^8.0.0"' \
       < "$WORK_DIR/locked/package.json" > "$WORK_DIR/outdated/package.json"
if echo "FROM $TEMPLATE_IMAGE" | docker build --no-cache -q -f - "$WORK_DIR/outdated" > /dev/null 2>&1; then
  fail "build with outdated package-lock.json fails"
else
  pass "build with outdated package-lock.json fails"
fi

log "Development mode with mounted /app and /config"
create development -e NODE_ENV=development "$TEMPLATE_IMAGE"
docker cp "$TEST_DIR/fixtures/service/." "$ID-development:/app"
docker cp "$TEST_DIR/fixtures/config/." "$ID-development:/config"
docker start "$ID-development" > /dev/null
wait_for development
check_service development mounted
check_file development "package-lock.json is copied to the mounted sources" /app/package-lock.json
check_file development "node_modules are copied to the mounted sources" /app/node_modules/nanoid/package.json
check_file development "mu is available in the mounted node_modules" /app/node_modules/mu/index.js

log "Development mode debugger"
check_debugger development

log "Development mode live reload"
docker exec "$ID-development" sh -c '
  sed -i "s/hello/hi/" /app/lib/greeting.ts
  echo "{ \"source\": \"reloaded\" }" > /config/data.json
  jq ".dependencies.pluralize = \"^8.0.0\"" /app/package.json > /tmp/package.json && mv /tmp/package.json /app/package.json
  echo "import pluralize from \"pluralize\"; import { app } from \"mu\"; app.get(\"/added\", (req, res) => res.send({ word: pluralize(\"service\") }));" > /app/added.js
  echo "import \"./added\";" >> /app/app.js
'
for _ in $(seq 1 120); do
  if request development /added 2> /dev/null | grep -q services; then
    break
  fi
  sleep 1
done
# give watchexec a moment to settle in case more restarts were queued
sleep 5
check development "typescript change is picked up" '.typescript == "hi template"' /status
check development "json config change is picked up" '.jsonConfig == "reloaded"' /status
check development "new file and new dependency are picked up" '.word == "services"' /added
running="$(docker exec "$ID-development" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline 2> /dev/null; echo; done | grep -c "^node .*start-server\.js"')"
if [ "$running" == "1" ]; then
  pass "a single server process is running after reload"
else
  fail "a single server process is running after reload" "got $running processes"
fi
check_debugger development

log "Shutdown in production mode"
check_shutdown production

log "Shutdown in development mode"
check_shutdown development

if [ "$FAILURES" -gt 0 ]; then
  log "$FAILURES check(s) failed"
  exit 1
fi
log "All checks passed"
