#!/usr/bin/env bash
# Säkerhetskopia av kampanjens arbetsmaterial till grenen claude/wonderful-wozniak-yhk4kz-wip.
# Användning: backup.sh "<kort status>"
set -u
S=/tmp/claude-0/-home-user-io-ais-tracker/c4a2d5a0-8da0-57bb-b8aa-b758fc3f45a8/scratchpad
K=$S/kampanj; B=$S/backup; R=/home/user/io.ais.tracker
WT=$B/wt; OUT=$WT/wip-kampanj
cd $R || exit 1
BASE=$(git rev-parse HEAD)
if [ ! -d $WT ]; then git worktree add --detach $WT $BASE >/dev/null 2>&1 || exit 2; fi
cd $WT && git checkout -q --detach $BASE && rm -rf $OUT && mkdir -p $OUT
cp $K/KAMPANJ.md $OUT/ 2>/dev/null
[ -f $B/RESUME.md ] && cp $B/RESUME.md $OUT/
[ -f $B/OVERLAMNING.md ] && cp $B/OVERLAMNING.md $OUT/
mkdir -p $OUT/skript
cp $S/port/battery.sh $B/backup.sh $B/revision3.js $OUT/skript/ 2>/dev/null
cp $K/*.js $OUT/skript/ 2>/dev/null
cp $K/registerforfragningar.json $OUT/ 2>/dev/null
for f in K K2 R1 R2 N M E E2; do
  d=$K/$f; [ -d $d ] || continue; mkdir -p $OUT/$f
  cp $d/*.md $d/*.json $d/*.diff $d/*.txt $OUT/$f/ 2>/dev/null
  for w in wt mwt; do
    if [ -d $d/$w ]; then
      base=7699cbe; [ $f = E2 ] && [ $w = wt ] && base=e949ae1
      (cd $d/$w && git format-patch -q $base..HEAD -o $OUT/$f/$w-patchar >/dev/null 2>&1; echo "$(git rev-parse HEAD)" > $OUT/$f/$w-HEAD.txt
       git diff HEAD --binary -- . ':!tests/replay-validation/bugHunt' ':!node_modules' > $OUT/$f/$w-ocommittat.diff)
    fi
  done
done
mkdir -p $OUT/motor
cp $S/hunt-fix/result.json $S/hunt-fix/result2.json $OUT/motor/ 2>/dev/null
cp -r $S/hunt-fix/input $OUT/motor/input 2>/dev/null
(cd $S/hunt-build/C/repo && diff -ruN $R/tests/replay-validation/bugHunt tests/replay-validation/bugHunt > $OUT/motor/C-bugHunt-mot-HEAD.diff; diff -u $R/docs/BUGGJAKT.md docs/BUGGJAKT.md > $OUT/motor/C-BUGGJAKT-mot-HEAD.diff)
(cd $S/integ/wt 2>/dev/null && git log --oneline -5 > $OUT/integ-log.txt && git diff HEAD --binary -- . ':!node_modules' > $OUT/integ-ocommittat.diff)
# Varv 2: brief, triage, skisser och familjernas worktrees (bas c14938f).
V=$S/varv2
if [ -d $V ]; then
  mkdir -p $OUT/varv2
  cp $V/*.md $V/*.json $V/*.js $V/*.sh $OUT/varv2/ 2>/dev/null
  for d in $V/*/; do
    n=$(basename $d); mkdir -p $OUT/varv2/$n
    cp $d/*.md $d/*.json $d/*.diff $d/*.txt $d/*.js $d/*.py $d/*.sh $OUT/varv2/$n/ 2>/dev/null
    for w in wt rwt prov; do
      if [ -d $d/$w ]; then
        (cd $d/$w && git format-patch -q c14938f..HEAD -o $OUT/varv2/$n/$w-patchar >/dev/null 2>&1
         git rev-parse HEAD > $OUT/varv2/$n/$w-HEAD.txt
         git diff HEAD --binary -- . ':!node_modules' > $OUT/varv2/$n/$w-ocommittat.diff
         git ls-files -z --others --exclude-standard | grep -zv '^node_modules$' | tar --null -T - -czf $OUT/varv2/$n/$w-otrackade.tgz 2>/dev/null)
      fi
    done
  done
fi
cd $WT && git add -A wip-kampanj && git commit -q -m "WIP-backup av rättningskampanjen: ${1:-ögonblicksbild}

Arbetsmaterial, inte produktkod. Se wip-kampanj/RESUME.md.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DNCqwt4q1MF8G4Aw5jG5pc" && \
for i in 1 2 3 4 5; do git push -q --force origin HEAD:refs/heads/claude/wonderful-wozniak-yhk4kz-wip && break; sleep $((2**i)); done
git ls-remote origin claude/wonderful-wozniak-yhk4kz-wip
du -sh $OUT
