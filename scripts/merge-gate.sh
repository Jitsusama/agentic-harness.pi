#!/usr/bin/env bash
# The harness's merge gate. review_offer merge runs it with the head's full
# commit, from a checkout of the harness with its dependencies installed,
# as the `review.merge.gates` entry for github:Jitsusama/agentic-harness.pi:
#
#   bash ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/current/scripts/merge-gate.sh
#
# First it runs Biome's check (what `pnpm lint` runs) over every file the
# head changes, read from that very commit, so formatting and lint are
# judged here at merge whatever machine the change was written on. On
# 15 November #1620 came from the work Mac, whose security software stops
# Biome while its wrapper exits 0, so its lint passed without running and
# main failed `pnpm lint` for every branch cut from it. Only the change's
# own files count, so a fault already on main refuses nothing new. Then it
# hands the commit to host-gate.sh beside it, which asks for a whole
# test:host run of anything pi hosts run. A refusal says what clears it.
set -euo pipefail

sha=${1:?Name the commit to merge: merge-gate.sh SHA}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
biome="$PWD/node_modules/.bin/biome"

git fetch -q origin main
if ! git cat-file -e "$sha^{commit}" 2> /dev/null; then git fetch -q origin "$sha"; fi
base=$(git merge-base origin/main "$sha")

# The Biome this checkout installed must be the one the head pins, or it
# could pass what the pinned one faults.
pinned=$(git show "$sha:package.json" | jq -r '.devDependencies["@biomejs/biome"] // empty')
if [[ ! -x $biome ]]; then
  echo "merge-gate: $PWD has no Biome installed, so $sha's formatting and lint can't be judged." >&2
  echo "Run pnpm install --frozen-lockfile in that checkout, then merge again." >&2
  exit 1
fi
installed=$("$biome" --version | awk '{print $NF}')
if [[ $installed != "$pinned" ]]; then
  echo "merge-gate: $PWD has Biome $installed installed, but $sha pins ${pinned:-none}." >&2
  echo "Check out $sha there and run pnpm install --frozen-lockfile, then merge again." >&2
  exit 1
fi

# What Biome reads, of what the change adds or modifies. The diff is its
# own step, so a diff that fails stops the gate rather than passing as a
# change that touches nothing.
changed=$(git diff --name-only --diff-filter=d "$base" "$sha" -- \
  '*.ts' '*.mts' '*.cts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.jsx' \
  '*.json' '*.jsonc' '*.css')
if [[ -n $changed ]]; then
  mapfile -t files <<< "$changed"
  tree=$(mktemp -d)
  trap 'rm -rf "$tree"' EXIT
  git archive "$sha" -- biome.jsonc "${files[@]}" | tar -x -C "$tree"
  set +e
  said=$(cd "$tree" && "$biome" check --vcs-enabled=false --no-errors-on-unmatched --colors=off "${files[@]}" 2>&1)
  checked=$?
  set -e
  if [[ $checked != 0 ]]; then
    echo "$said" >&2
    echo "merge-gate: Biome faults ${#files[@]} changed file(s) at $sha, as pnpm lint would." >&2
    echo "Run pnpm lint:fix in a checkout of the branch, commit what it changes, push, and merge the new head." >&2
    exit 1
  fi
  echo "merge-gate: Biome passes the ${#files[@]} file(s) $sha changes"
fi

exec bash "$here/host-gate.sh" "$sha"
