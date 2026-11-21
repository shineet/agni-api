#!/bin/zsh
# Runs the companion's LOCAL dev server against the REAL model, for a trial. Never deployed.
#
#   ~/Documents/Projects/agni-api/tools/live-companion-trial.sh            (asks, hidden)
#   ~/Documents/Projects/agni-api/tools/live-companion-trial.sh --clipboard (copy the key first)
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
if [ "$1" = "--clipboard" ]; then
  # For a shell that cannot take typed input: copy the key first, then run this. The clipboard is
  # read once and CLEARED straight away; the key is never printed, written or put on a command line.
  ANTHROPIC_API_KEY="$(pbpaste)"
  printf "" | pbcopy
  echo "key read from the clipboard and the clipboard cleared"
else
  printf "Anthropic API key (hidden): "; read -s ANTHROPIC_API_KEY; echo
fi
case "$ANTHROPIC_API_KEY" in sk-ant-*) ;; *) echo "that does not look like an Anthropic key (it should start sk-ant-), stopping"; exit 1;; esac
export ANTHROPIC_API_KEY AGNI_DEV_LIVE_PROVIDER=1
rm -rf "$DIR"; $PGB/initdb -D "$DIR" -U postgres --auth=trust -E UTF8 >/dev/null
$PGB/pg_ctl -D "$DIR" -o "-p 55432 -c listen_addresses=127.0.0.1" -l "$DIR/log.txt" -w start >/dev/null
trap '$PGB/pg_ctl -D "$DIR" stop -m fast >/dev/null 2>&1; rm -rf "$DIR"; echo; echo "stopped"' EXIT INT TERM
export AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres
echo "live trial server starting on http://127.0.0.1:3999 (Ctrl-C to stop)"
node tools/dev-server.mjs
