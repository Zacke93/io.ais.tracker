#!/usr/bin/env bash
# Skyddskoll: arbetskopian får bara skilja sig från huvudträdet i motorns egna filer.
S=/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
C=$S/hunt-build/C/repo
F=$S/hunt-fix
now=$(diff -rq --exclude=node_modules --exclude=.git "$C" /home/user/io.ais.tracker 2>&1 | grep -v '/bugHunt\|BUGGJAKT.md\|buggjakt-triage-2026-11-04.md' | sort)
if [ "$now" != "$(cat $F/input/diff-baseline.txt)" ]; then
  echo "AVVIKELSE: mängden ändrade filer utanför motorn har ändrats:"
  diff <(echo "$now") $F/input/diff-baseline.txt
  exit 1
fi
if ! (cd "$C" && sha256sum -c --quiet $F/input/sha-baseline.txt); then
  echo "AVVIKELSE: package.json, docs/VALIDATION.md eller CLAUDE.md har ändrats"
  exit 1
fi
if [ -n "$(cd /home/user/io.ais.tracker && git status --porcelain)" ]; then
  echo "AVVIKELSE: huvudträdet är inte rent"
  exit 1
fi
echo OK
