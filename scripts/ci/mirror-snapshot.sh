#!/usr/bin/env bash
# Clean public CI copy (owner decision 21 Nov 2026 00:37 UTC; docs/65).
#
# Builds ONE history-free commit from a private commit: the same files, minus the private records listed in
# EXCLUDE, plus a short README that says what the copy is. Everything is derived only from the private commit, so
# the snapshot's tree and commit ids are reproducible: anyone with the private repository can rebuild them and
# check that the public CI run tested exactly that code.
#
#   scripts/ci/mirror-snapshot.sh build  <private-commit>            prints "<snapshot-commit> <snapshot-tree>"
#   scripts/ci/mirror-snapshot.sh push   <private-commit> <remote>   builds, then force-pushes it to <remote> main
#   scripts/ci/mirror-snapshot.sh verify <private-commit> <public-commit>
#                                                                     exits 0 only if the public commit is the rebuild
#   scripts/ci/mirror-snapshot.sh manifest <private-commit>          prints the validation record (JSON): source and
#                                                                     snapshot ids, what was left out and why, counts
#
# Nothing here reads or writes the working tree, the index or any branch of the private repository.
set -euo pipefail

# Private records that never go into the public copy. None is read by the build, the app or the CI checks; the two
# tests that check the research registry skip only when it is absent (tests/unit/source-access.test.ts,
# tests/unit/menu-export.test.ts) and run in every local regression.
EXCLUDE=(
  AGENTS.md
  CLAUDE.md
  FIRST_SESSION_PROMPT.md
  OWNER_BRIEF.md
  SHA256SUMS.txt
  design
  docs
  naming
  plans
  progress
  scripts/menu-access-registry.json
)

README='# CI copy

This repository holds only a history-free snapshot of a private project so that its automated checks can run.
It is not a release and has no licence: all rights are reserved. Issues and pull requests are not accepted.
'

build() {
  local src
  src=$(git rev-parse --verify "$1^{commit}")
  local idx
  idx=$(mktemp)
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$src"
  GIT_INDEX_FILE="$idx" git rm -r --cached -f -q --ignore-unmatch -- "${EXCLUDE[@]}" >/dev/null
  local blob
  blob=$(printf '%s' "$README" | git hash-object -w --stdin)
  GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$blob,README.md"
  local tree
  tree=$(GIT_INDEX_FILE="$idx" git write-tree)
  rm -f "$idx"
  # Fixed identity, and the private commit's own date, so the same input always gives the same commit id.
  local when
  when=$(git show -s --format=%cI "$src")
  local commit
  commit=$(GIT_AUTHOR_NAME="CI snapshot" GIT_AUTHOR_EMAIL="ci-snapshot@users.noreply.github.com" GIT_AUTHOR_DATE="$when" \
    GIT_COMMITTER_NAME="CI snapshot" GIT_COMMITTER_EMAIL="ci-snapshot@users.noreply.github.com" GIT_COMMITTER_DATE="$when" \
    git commit-tree "$tree" -m "CI snapshot of $src")
  echo "$commit $tree"
}

case "${1:-}" in
  build) build "$2" ;;
  push)
    read -r commit tree < <(build "$2")
    git push --force "$3" "$commit:refs/heads/main"
    echo "$commit $tree"
    ;;
  verify)
    read -r commit tree < <(build "$2")
    pub=$(git rev-parse --verify "$3^{commit}")
    if [ "$pub" = "$commit" ]; then echo "match: $pub is the snapshot of $2 (tree $tree)"; else echo "MISMATCH: expected $commit, got $pub" >&2; exit 1; fi
    ;;
  manifest)
    src=$(git rev-parse --verify "$2^{commit}")
    read -r commit tree < <(build "$src")
    excluded=$(for p in "${EXCLUDE[@]}"; do n=$(git ls-tree -r --name-only "$src" -- "$p" | wc -l); [ "$n" -gt 0 ] && printf '{"path":"%s","files":%s},' "$p" "$n"; done)
    printf '{"sourceCommit":"%s","sourceTree":"%s","snapshotCommit":"%s","snapshotTree":"%s","sourceFiles":%s,"snapshotFiles":%s,"excluded":[%s],"excludedWhy":"private records not read by the build, the app or CI (docs/65)","added":["README.md (replaces the private README)"],"skippedPublicly":["tests/unit/source-access.test.ts: the registry file","tests/unit/menu-export.test.ts: the source-access registry file"],"workflow":".github/workflows/ci.yml (same file)"}\n' \
      "$src" "$(git rev-parse "$src^{tree}")" "$commit" "$tree" "$(git ls-tree -r --name-only "$src" | wc -l)" "$(git ls-tree -r --name-only "$commit" | wc -l)" "${excluded%,}"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
