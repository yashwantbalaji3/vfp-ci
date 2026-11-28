#!/usr/bin/env bash
# Decide whether a push to main may skip the full CI run (owner approval 19 Nov 2026 04:56 UTC, Option A; docs/60).
#
# The full run is skipped ONLY when every condition below is proven from GitHub's own records. Anything else,
# including any error, an API failure or a missing record, means "run the full checks" (fail closed).
#   1. The pushed commit is a merge commit of exactly two parents: the previous main and a PR head.
#   2. GitHub lists exactly one merged pull request into main for this commit, whose head is that second parent
#      and whose merge commit is this commit.
#   3. The previous main is an ancestor of the PR head, so the head already contained everything on main and the
#      merge added nothing: the tree CI tested on the PR is the tree now on main.
#   4. The PR changes nothing under .github/ or scripts/ci/ (a change to CI itself always gets the full run), and
#      it changes fewer than 100 files (so the list of changed files is complete).
#   5. The merged tree is byte-identical (same git tree id) to the PR head's tree. A git tree id covers every file:
#      source, dependencies and lockfile, workflows, migrations, configuration, tests and docs.
#   6. The latest CI run on that exact head commit was a pull_request run of this same workflow file, completed,
#      concluded "success", and its "checks" job itself concluded "success" (not skipped). No CI run on that head
#      is still running or failed after it.
# Usage: main-skip-gate.sh <repo owner/name> <pushed sha>. Prints the evidence and, last, skip=true|false.
# Needs: gh (authenticated by GH_TOKEN), jq. Read-only: it changes nothing on GitHub.
set -uo pipefail
REPO="$1"; SHA="$2"; WORKFLOW_PATH=".github/workflows/ci.yml"
say() { echo "$*"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY"; return 0; }
run_all() { say "Decision: run the full checks. Reason: $1"; echo "skip=false"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "skip=false" >> "$GITHUB_OUTPUT"; exit 0; }
api() { gh api -H "Accept: application/vnd.github+json" "$@"; }

say "### Main CI skip check for ${SHA}"
commit=$(api "repos/$REPO/commits/$SHA") || run_all "could not read the pushed commit"
tree=$(jq -r '.commit.tree.sha' <<<"$commit")
nparents=$(jq '.parents | length' <<<"$commit")
[ "$nparents" = "2" ] || run_all "not a two-parent merge commit (parents: $nparents)"
base=$(jq -r '.parents[0].sha' <<<"$commit"); head=$(jq -r '.parents[1].sha' <<<"$commit")
say "- Merged tree: \`$tree\`; previous main: \`$base\`; PR head: \`$head\`"

prs=$(api "repos/$REPO/commits/$SHA/pulls") || run_all "could not read the pull requests for this commit"
pr=$(jq -c --arg sha "$SHA" --arg head "$head" '[.[] | select(.merged_at != null and .base.ref == "main" and .head.sha == $head and .merge_commit_sha == $sha)]' <<<"$prs")
[ "$(jq length <<<"$pr")" = "1" ] || run_all "no single merged pull request into main with this head and merge commit"
say "- Pull request: #$(jq -r '.[0].number' <<<"$pr")"

htree=$(api "repos/$REPO/commits/$head" --jq '.commit.tree.sha') || run_all "could not read the PR head commit"
say "- PR head tree: \`$htree\`"
[ -n "$htree" ] && [ "$htree" = "$tree" ] || run_all "the merged tree differs from the tested PR head tree"

cmp=$(api "repos/$REPO/compare/$base...$head?per_page=100") || run_all "could not compare previous main with the PR head"
status=$(jq -r '.status' <<<"$cmp")
# A PR that changes CI itself (the workflows or this gate) always gets the full run on main as well.
nfiles=$(jq '.files | length' <<<"$cmp"); [ "$nfiles" -lt 100 ] || run_all "the PR changes 100 or more files, too many to list fully"
ci_files=$(jq -r '[.files[].filename | select(startswith(".github/") or startswith("scripts/ci/"))] | join(", ")' <<<"$cmp")
[ -z "$ci_files" ] || run_all "the PR changes CI itself ($ci_files)"
say "- Previous main → PR head: $status"
[ "$status" = "ahead" ] || [ "$status" = "identical" ] || run_all "the PR head did not contain the previous main ($status)"

runs=$(api "repos/$REPO/actions/runs?head_sha=$head&per_page=100") || run_all "could not read the CI runs for the PR head"
ci=$(jq -c --arg p "$WORKFLOW_PATH" '[.workflow_runs[] | select(.path == $p)] | sort_by(.run_started_at) | reverse' <<<"$runs")
[ "$(jq length <<<"$ci")" -ge 1 ] || run_all "no CI run on the PR head"
latest=$(jq -c '.[0]' <<<"$ci")
say "- Latest CI run on the PR head: $(jq -r '"\(.id) event=\(.event) status=\(.status) conclusion=\(.conclusion)"' <<<"$latest")"
[ "$(jq -r '.event' <<<"$latest")" = "pull_request" ] || run_all "the latest CI run on the head was not a pull_request run"
[ "$(jq -r '.status' <<<"$latest")" = "completed" ] && [ "$(jq -r '.conclusion' <<<"$latest")" = "success" ] || run_all "the latest CI run on the head did not succeed"
[ "$(jq '[.[] | select(.status != "completed")] | length' <<<"$ci")" = "0" ] || run_all "a CI run on the head is still in progress"
jobs=$(api "repos/$REPO/actions/runs/$(jq -r '.id' <<<"$latest")/jobs") || run_all "could not read the jobs of that run"
checks=$(jq -r '[.jobs[] | select(.name == "checks")] | if length == 1 then .[0].conclusion else "missing" end' <<<"$jobs")
say "- Its full \"checks\" job: $checks"
[ "$checks" = "success" ] || run_all "the full checks job on the PR head did not succeed"

say "Decision: skip the repeat full run. The tree on main is identical to the PR head that passed every check; a smoke check still runs."
echo "skip=true"; [ -n "${GITHUB_OUTPUT:-}" ] && echo "skip=true" >> "$GITHUB_OUTPUT"
exit 0
