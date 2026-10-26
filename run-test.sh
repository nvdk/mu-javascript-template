#!/bin/bash

# Fail on error
set -eo pipefail

source ./helpers.sh

# Runs the tests of the service mounted in /app.  The sources are prepared the
# same way as in development (including devDependencies), the tests run from
# the transpiled sources in /usr/src/dist so they can import `mu` and use the
# same module resolution as the service.

cd /usr/src/app/

docker-rsync --delete --exclude node_modules /app/ /usr/src/app/app/

## Copy config folder
if [[ "$(ls -A /config/ 2> /dev/null)" ]]
then
    mkdir -p ./app/config/
    cp -rf /config/. ./app/config/
fi

npm_install_command=""
if [ -f /app/package-lock.json ]
then
    npm_install_command=ci
elif [ -f /app/package.json ]
then
    npm_install_command=install
fi
./npm-install-dependencies.sh test $npm_install_command
./validate-package-json.sh

./transpile-sources.sh

cp /usr/src/app/helpers/mu/package.json /usr/src/dist/node_modules/mu/

cd /usr/src/dist/

# Use the test script of the service if it has one, Node's built-in test runner
# otherwise.  Arguments are passed on to the test command.
if [ -f /app/package.json ] && [ "$(node -p 'require("/app/package.json").scripts?.test ?? ""')" != "" ]
then
    exec npm test -- "$@"
else
    exec node --test "$@"
fi
