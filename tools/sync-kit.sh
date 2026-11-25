#!/usr/bin/env bash
# tools/sync-kit.sh [ref] - bring the upstream idrive7-apps kit up to <ref> (default: main).
#
# The kit (tools/kit-paths.txt) is a copy of cauliflowermossgrape/idrive7-apps. Its pristine copy lives on the
# upstream-kit branch, one commit per sync; main merges that branch, so the kit edits made here (an app's
# translations, its glyphs in the font atlases) carry over like any other merge.
#
#   tools/sync-kit.sh            # upstream main
#   tools/sync-kit.sh 1a2b3c4    # a commit, tag or branch of upstream
#
# Then, on a branch off main:   tools/merge-kit.sh
# and push that branch and upstream-kit. Environment: UPSTREAM_REPO (default the GitHub repository) may be a local clone.
set -euo pipefail

REPO=${UPSTREAM_REPO:-https://github.com/cauliflowermossgrape/idrive7-apps}
REF=${1:-main}
BRANCH=upstream-kit

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
LIST="$ROOT/tools/kit-paths.txt"
[ -f "$LIST" ] || { echo "no $LIST" >&2; exit 1; }

work=$(mktemp -d)
tree="$work/tree"
cleanup() { git worktree remove --force "$tree" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

# the list: "src", "src -> dst" or "!dst"
srcs=() dsts=() drops=()
while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$line" ] && continue
    case "$line" in
        '!'*) drops+=("${line#!}") ;;
        *' -> '*) srcs+=("${line%% -> *}"); dsts+=("${line##* -> }") ;;
        *) srcs+=("$line"); dsts+=("$line") ;;
    esac
done < "$LIST"

echo "upstream: $REPO at $REF"
git clone --quiet --filter=blob:none --no-checkout "$REPO" "$work/up"
git -C "$work/up" sparse-checkout set --no-cone "${srcs[@]/#//}" >/dev/null
git -C "$work/up" checkout --quiet "$REF" 2>/dev/null || git -C "$work/up" checkout --quiet "origin/$REF"
sha=$(git -C "$work/up" rev-parse HEAD)

# the pristine branch: local, else origin's, else a new one with no history
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add --quiet "$tree" "$BRANCH"
elif git fetch --quiet origin "$BRANCH" 2>/dev/null; then
    git worktree add --quiet -b "$BRANCH" "$tree" FETCH_HEAD
else
    git worktree add --quiet --orphan -b "$BRANCH" "$tree"
fi

# the branch holds nothing but the kit: start empty, copy every listed path
git -C "$tree" rm -r --quiet --ignore-unmatch . >/dev/null
for i in "${!srcs[@]}"; do
    src="$work/up/${srcs[$i]}" dst="$tree/${dsts[$i]}"
    [ -e "$src" ] || { echo "upstream has no ${srcs[$i]} at $sha" >&2; exit 1; }
    if [ -d "$src" ]; then mkdir -p "$dst" && cp -R "$src/." "$dst/"
    else mkdir -p "$(dirname "$dst")" && cp "$src" "$dst"; fi
done
for d in "${drops[@]+"${drops[@]}"}"; do rm -rf "${tree:?}/$d"; done
printf 'repo: %s\ncommit: %s\n' "$REPO" "$sha" > "$tree/kit/UPSTREAM"

git -C "$tree" add -A
if git -C "$tree" diff --cached --quiet; then
    echo "$BRANCH is already upstream ${sha:0:7}"
    exit 0
fi
git -C "$tree" commit --quiet -m "Kit: upstream idrive7-apps ${sha:0:7}" -m "$REPO/commit/$sha"
echo "$BRANCH: kit at upstream ${sha:0:7}"
echo
echo "Next, on a branch off main:  tools/merge-kit.sh   (then push it and $BRANCH)"
