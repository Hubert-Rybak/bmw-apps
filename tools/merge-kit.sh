#!/usr/bin/env bash
# tools/merge-kit.sh - merge the upstream-kit branch (tools/sync-kit.sh) into the current branch.
#
# Translation rows merge by keeping both sides' (.gitattributes: merge=union). The files made from them are
# not merged but made again: the locale JSON from the merged .tsv catalogs, and a glyph atlas whenever its
# language's catalog now differs from both sides' (so neither side's atlas has every glyph).
#
# Needs Python 3 with Pillow to re-bake an atlas; Chinese downloads its font, Korean needs Noto Sans CJK
# (Debian/Ubuntu: fonts-noto-cjk; else KOREAN_FONT=<path to NotoSansCJK-Regular.ttc>).
set -euo pipefail
BRANCH=upstream-kit
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
git diff --quiet && git diff --cached --quiet || { echo "commit or stash your changes first" >&2; exit 1; }

head=$(git rev-parse HEAD)
up=$(git rev-parse "$BRANCH")
sha=$(git show "$up:kit/UPSTREAM" | sed -n 's/^commit: //p' | cut -c1-7)
if git merge-base --is-ancestor "$up" HEAD; then echo "already merged: upstream $sha"; exit 0; fi

git merge --no-commit --no-ff "$BRANCH" >/dev/null 2>&1 || true

# made from the catalogs: take upstream's, then make them again below
for f in $(git diff --name-only --diff-filter=U); do
    case "$f" in
        kit/runtime/locales/*.json|kit/runtime/fonts/cjk.json|kit/localization/fonts/cjk-zh-TW.json|kit/localization/fonts/korean.json)
            git checkout --theirs -- "$f"; git add -- "$f" ;;
    esac
done
left=$(git diff --name-only --diff-filter=U)
if [ -n "$left" ]; then
    echo "Upstream $sha: these conflict and need you. Resolve them, git add them, run" >&2
    echo "python3 kit/tools/sync_locales.py (and a bake_*.py for a language whose texts both sides changed), commit:" >&2
    echo "$left" | sed 's/^/  /' >&2
    exit 1
fi

python3 kit/tools/sync_locales.py >/dev/null

same() { git diff --quiet "$1" -- "$2"; }   # the working file equals the file at commit $1
for lang in zh-CN zh-TW ko; do
    tsv=kit/runtime/locales/$lang.tsv
    if same "$head" "$tsv" || same "$up" "$tsv"; then continue; fi
    echo "$lang: both sides changed its texts, re-baking its glyphs"
    case $lang in
        zh-CN) python3 kit/tools/bake_cjk.py ;;
        zh-TW) python3 kit/tools/bake_cjk.py --language zh-TW ;;
        ko) python3 kit/tools/bake_korean.py ${KOREAN_FONT:+"$KOREAN_FONT"} ;;
    esac
done

git add -A kit
git commit --quiet --no-edit -m "Merge upstream kit $sha"
echo "merged upstream kit $sha"
