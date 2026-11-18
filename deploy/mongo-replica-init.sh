#!/usr/bin/env bash
set -euo pipefail

host='mongo:27017'
for attempt in $(seq 1 60); do
  if mongosh --host "$host" --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -qx 1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo 'Local MongoDB did not become reachable.' >&2
    exit 1
  fi
  sleep 1
done

mongosh --host "$host" --quiet --eval '
  try { rs.status(); print("Replica set already configured"); }
  catch (error) {
    if (error.codeName !== "NotYetInitialized") throw error;
    rs.initiate({_id:"rs0", members:[{_id:0, host:"mongo:27017"}]});
  }
'

for attempt in $(seq 1 60); do
  if mongosh --host "$host" --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qx true; then
    echo 'Local MongoDB replica set is PRIMARY.'
    exit 0
  fi
  if [ "$attempt" -eq 60 ]; then
    echo 'Local MongoDB replica set did not elect a PRIMARY.' >&2
    exit 1
  fi
  sleep 1
done
