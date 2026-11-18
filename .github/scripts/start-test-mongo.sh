#!/usr/bin/env bash
set -euo pipefail

# Only for ephemeral CI runners. It creates an isolated local MongoDB replica set
# with no external data and no production credentials.
docker run --detach --name salon-test-mongo \
  --publish 127.0.0.1:27017:27017 \
  mongo:7 mongod --replSet rs0 --bind_ip_all

for attempt in $(seq 1 45); do
  if docker exec salon-test-mongo mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' 2>/dev/null | grep -qx 1; then
    break
  fi
  if [ "$attempt" -eq 45 ]; then
    echo 'MongoDB did not become ready' >&2
    exit 1
  fi
  sleep 1
done

docker exec salon-test-mongo mongosh --quiet --eval \
  'rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]})'

for attempt in $(seq 1 45); do
  if docker exec salon-test-mongo mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qx true; then
    echo 'MongoDB test replica set is PRIMARY'
    exit 0
  fi
  if [ "$attempt" -eq 45 ]; then
    echo 'MongoDB test replica set did not elect a PRIMARY' >&2
    exit 1
  fi
  sleep 1
done
