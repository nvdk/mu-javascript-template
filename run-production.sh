#!/bin/bash

# Production startup must not write to the filesystem: /config and the image
# may be read-only.  Overrides in /config are picked up by config-overrides.js.

diff -rq /app /app.original > /dev/null
APP_FILES_CHANGED="$?"

if [ ! -f /usr/src/dist/app.js ]
then
    echo "No built sources found.  If you mount new sources, please set the NODE_ENV=\"development\" environment variable."
    sleep 5;
    exit 1;
elif [ $APP_FILES_CHANGED == "1" ]
then
    echo "Built sources are not the same as sources available in /app.  If you mount new sources, please set the NODE_ENV=\"development\" environment variable."
    sleep 5;
    exit 1;
elif [ $APP_FILES_CHANGED != "0" ]
then
    echo "[WARNING] Could not verify sources in /app match the built sources (e.g. unreadable files).  Continuing."
fi

cd /usr/src/dist/
exec node --import /usr/src/app/config-overrides.js ./start-server.js
