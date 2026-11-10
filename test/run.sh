#!/bin/sh
# Every test of this repository, on this machine:
#
#   sh test/run.sh [arguments passed to every test]
#   NODE=/path/to/node sh test/run.sh        another Node (the head unit's is 8.16.2: npm install node@8.16.2)
#
# It builds each native tool for this machine (native/<tool>/build.sh host), stages each app without the SDK
# (kit/tools/build.py --preview-only), then runs native/<tool>/test/run.js and test/<app>/test_*.js.
# To test the head-unit binary of the YouTube player instead of the host build:
#   sh test/run.sh --bin tools/hrybak-ytplay/hrybak-ytplay --loader /lib64/ld-linux-x86-64.so.2
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-node}
cd "$ROOT"

for b in native/*/build.sh; do
    [ -f "$b" ] || continue
    sh "$b" host
done
for a in apps/*/app.json; do
    [ -f "$a" ] || continue
    python3 kit/tools/build.py --preview-only "$(basename "$(dirname "$a")")"
done

fail=0
for t in native/*/test/run.js test/*/test_*.js; do
    [ -f "$t" ] || continue
    echo "== $t"
    "$NODE" "$t" "$@" || fail=1
done
if [ "$fail" = 0 ]; then
    echo "every test passed ($("$NODE" --version))"
else
    echo "TESTS FAILED"
    exit 1
fi
