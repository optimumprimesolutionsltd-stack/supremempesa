#!/usr/bin/env bash
#
# Start or stop the local Postgres + Redis this project develops against.
#
# The binaries live under .devstack/, which is deliberately NOT committed --
# it is ~350 MB of vendor build. This script is committed so the commands in
# package.json exist in a fresh clone; see README for how to populate
# .devstack/ (or just point DATABASE_URL and REDIS_URL at your own servers and
# ignore this entirely).
#
# Nothing here needs admin rights and nothing is registered as a service:
# deleting .devstack/ removes every trace.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/.devstack"
PG_PORT="${PG_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"

PG_CTL="$STACK/pgsql/bin/pg_ctl.exe"
PG_READY="$STACK/pgsql/bin/pg_isready.exe"
REDIS_SERVER="$STACK/redis/redis-server.exe"
REDIS_CLI="$STACK/redis/redis-cli.exe"

# Unix builds if the .exe ones are absent, so the script works outside Windows.
[ -x "$PG_CTL" ] || PG_CTL="$STACK/pgsql/bin/pg_ctl"
[ -x "$PG_READY" ] || PG_READY="$STACK/pgsql/bin/pg_isready"
[ -x "$REDIS_SERVER" ] || REDIS_SERVER="$STACK/redis/redis-server"
[ -x "$REDIS_CLI" ] || REDIS_CLI="$STACK/redis/redis-cli"

missing() {
  cat >&2 <<MSG
No portable stack found at $STACK

Either populate it (see "Running it" in README.md), or point the app at
databases you already have:

  DATABASE_URL=postgres://user:pass@host:5432/mpesa_tally
  REDIS_URL=redis://host:6379
MSG
  exit 1
}

# Note: CONFIG GET dir will report a mangled path like /.devstack/data/redis on
# Windows. That is msys2 reporting its own idea of the cwd -- the files really
# are written under .devstack/data/redis. Verified, not assumed.
#
# This Redis build accepts a native path (C:/x) only inside the config FILE:
# on the command line msys2 rewrites it to /x, and a POSIX path (/c/x) is
# rejected outright. So the runtime config is generated from the committed
# template with absolute paths baked in, and handed over as a relative path.
pg_up()    { "$PG_READY" -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; }
redis_up() { "$REDIS_CLI" -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; }

start() {
  [ -x "$PG_CTL" ] || missing
  mkdir -p "$STACK/logs"

  if pg_up; then
    echo "postgres already running on $PG_PORT"
  else
    # Every child is detached from this script's stdin/stdout. A server that
    # inherits them holds the caller's pipe open, so the command looks hung
    # long after both databases are accepting connections.
    "$PG_CTL" -D "$STACK/data/pg" \
      -l "$STACK/logs/postgres.log" \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1" start \
      </dev/null >>"$STACK/logs/pg_ctl.log" 2>&1
    for _ in $(seq 1 40); do pg_up && break; sleep 0.5; done
    pg_up && echo "postgres started on $PG_PORT" || {
      echo "postgres failed to start; see $STACK/logs/postgres.log" >&2
      exit 1
    }
  fi

  if redis_up; then
    echo "redis already running on $REDIS_PORT"
  else
    mkdir -p "$STACK/data/redis" "$STACK/logs"

    TEMPLATE="$ROOT/scripts/mpesa-redis.conf"
    [ -f "$TEMPLATE" ] || { echo "missing $TEMPLATE" >&2; exit 1; }

    RUNTIME_CONF="$STACK/redis/mpesa.runtime.conf"
    {
      grep -vE '^[[:space:]]*(dir|logfile|port)[[:space:]]' "$TEMPLATE"
      echo "port $REDIS_PORT"
      echo "dir \"$STACK/data/redis\""
      echo "logfile \"$STACK/logs/redis.log\""
    } > "$RUNTIME_CONF"

    (
      cd "$STACK/redis" || exit 1
      "$REDIS_SERVER" ./mpesa.runtime.conf </dev/null >>"$STACK/logs/redis-stdout.log" 2>&1 &
    )
    for _ in $(seq 1 40); do redis_up && break; sleep 0.5; done
    redis_up && echo "redis started on $REDIS_PORT" || {
      echo "redis failed to start; see $STACK/logs/redis.log" >&2
      exit 1
    }
  fi
}

stop() {
  [ -x "$REDIS_CLI" ] || missing

  if redis_up; then
    "$REDIS_CLI" -p "$REDIS_PORT" shutdown nosave 2>/dev/null
    echo "redis stopped"
  else
    echo "redis was not running"
  fi

  if pg_up; then
    # -m fast: roll back open transactions rather than waiting for clients.
    "$PG_CTL" -D "$STACK/data/pg" -m fast stop </dev/null >>"$STACK/logs/pg_ctl.log" 2>&1
    echo "postgres stopped"
  else
    echo "postgres was not running"
  fi
}

status() {
  pg_up && echo "postgres: up on $PG_PORT" || echo "postgres: down"
  redis_up && echo "redis:    up on $REDIS_PORT" || echo "redis:    down"
}

case "${1:-start}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *) echo "usage: devstack.sh [start|stop|status]" >&2; exit 2 ;;
esac
