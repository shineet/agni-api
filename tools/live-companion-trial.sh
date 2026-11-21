#!/bin/zsh
# Runs the companion's LOCAL dev server against the REAL model, for a trial. Never deployed.
#
#   ! ~/Documents/Projects/agni-api/tools/live-companion-trial.sh
#
# It asks for your Anthropic key without echoing it. The key lives only in this process's
# environment: it is not written to a file, not logged, and not passed on a command line. It
# starts a throwaway local Postgres (port 55432) and the dev server (port 3999), and stays in
# the foreground; Ctrl-C stops both and deletes the throwaway database.
#
# Cost: a handful of Haiku calls, a few cents. The day summary it sends is a FAKE fixture day.
set -e
PGB=/opt/homebrew/opt/postgresql@17/bin
DIR=${TMPDIR:-/tmp}/agni-trial-pg
cd "$(dirname "$0")/.."
printf "Anthropic API key (hidden): "; read -s ANTHROPIC_API_KEY; echo
[ -n "$ANTHROPIC_API_KEY" ] || { echo "no key, stopping"; exit 1; }
export ANTHROPIC_API_KEY AGNI_DEV_LIVE_PROVIDER=1
rm -rf "$DIR"; $PGB/initdb -D "$DIR" -U postgres --auth=trust -E UTF8 >/dev/null
$PGB/pg_ctl -D "$DIR" -o "-p 55432 -c listen_addresses=127.0.0.1" -l "$DIR/log.txt" -w start >/dev/null
trap '$PGB/pg_ctl -D "$DIR" stop -m fast >/dev/null 2>&1; rm -rf "$DIR"; echo; echo "stopped"' EXIT INT TERM
export AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres
echo "live trial server starting on http://127.0.0.1:3999 (Ctrl-C to stop)"
node tools/dev-server.mjs
