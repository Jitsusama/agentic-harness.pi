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
# own files count, so a fault already on main refuses nothing new.
#
# Next it holds the counts that only fall: long files and crowded folders
# that don't say why, and linter suppressions. Their package rules ran
# only under a whole pnpm test, since nothing imports them, so by
# 23 November 35 long files and 5 crowded folders sat past an empty list
# with no change refused. Here main's copy of each rule judges the head's
# tree, and each of the head's lists may only shrink against main's, so a
# head can't loosen a rule or raise its own list to pass. Then it hands
# the commit to host-gate.sh beside it, which asks for a whole test:host
# run of anything pi hosts run. A refusal says what clears it.
set -euo pipefail

sha=${1:?Name the commit to merge: merge-gate.sh SHA}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
biome="$PWD/node_modules/.bin/biome"
vitest="$PWD/node_modules/.bin/vitest"
# The rules whose counts only fall, each with its shrink-only list and how
# the rule reads the list's lines: whole, a path each, or a path and its
# count.
code=tests/package/code
rules=(
  "$code/every-long-file-says-why.test.ts $code/long-files-waiting.txt whole"
  "$code/linters-stay-on.test.ts $code/suppressions-waiting.txt counted"
)
counts=()
for each in "${rules[@]}"; do
  read -r rule _ <<< "$each"
  counts+=("$rule")
done
# What the rules import of the package's own, judged as they are.
helpers=(tests/package/code/package-files.ts)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

git fetch -q origin main
if ! git cat-file -e "$sha^{commit}" 2> /dev/null; then git fetch -q origin "$sha"; fi
base=$(git merge-base origin/main "$sha")

# The head's files come from an index of the gate's own, not git archive,
# which leaves out whatever the head's .gitattributes marks export-ignore
# and so would hide those files from every check here. Its attributes are
# read from the empty tree, so none of the head's (an encoding, a filter)
# changes a file from the blob code-health reads, and a link is written as
# a file holding its target, so none reaches outside the copy.
empty_tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904
head_index() {
  GIT_INDEX_FILE="$scratch/index" GIT_ATTR_SOURCE=$empty_tree git -c core.symlinks=false "$@"
}
head_index read-tree "$sha"

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
  tree="$scratch/changed"
  mkdir "$tree"
  head_index checkout-index --prefix="$tree/" -- biome.jsonc "${files[@]}"
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

if [[ ! -x $vitest ]]; then
  echo "merge-gate: $PWD has no vitest installed, so $sha's counts can't be judged." >&2
  echo "Run pnpm install --frozen-lockfile in that checkout, then merge again." >&2
  exit 1
fi

# A head's own packages would stand before the checkout's, and the rules
# would import its vitest rather than the one installed. A Mac's disk
# takes Node_Modules for node_modules, so any case is refused.
tracked=$(git ls-tree -r --name-only "$sha")
if grep -qiE '(^|/)node_modules(/|$)' <<< "$tracked"; then
  echo "merge-gate: $sha tracks files under a node_modules folder, which would stand before the installed packages." >&2
  echo "Remove them from the branch, push, and merge the new head." >&2
  exit 1
fi

# The head's whole tree, its rules swapped for main's, so nothing of the
# head's decides how it's judged. Only a rule main doesn't have yet, as
# when it first comes in, is the head's own; one neither has refuses.
whole="$scratch/whole"
head_index checkout-index -a --prefix="$whole/"
for rule in "${counts[@]}" "${helpers[@]}"; do
  if git cat-file -e "origin/main:$rule" 2> /dev/null; then
    rm -rf "${whole:?}/$rule"
    # A link the head put where one of the rule's folders was is a file
    # here, which gives way to the folder.
    at=$(dirname "$rule")
    while [[ $at != . ]]; do
      if [[ -e $whole/$at && ! -d $whole/$at ]]; then rm -f "${whole:?}/$at"; fi
      at=$(dirname "$at")
    done
    mkdir -p "$(dirname "$whole/$rule")"
    git show "origin/main:$rule" > "$whole/$rule"
  elif [[ ! -f $whole/$rule ]]; then
    echo "merge-gate: neither main nor $sha has $rule, so the count it holds can't be judged." >&2
    echo "Rebase the branch on origin/main, push, and merge the new head." >&2
    exit 1
  fi
done

# Each list's lines against main's, read as its rule reads them, trimmed
# and past comments: a whole line as one path, or "path count". A line main
# lacks, or a count above main's, raises the list, and a counted line that
# isn't a path and a count above 0 is refused as it stands. A list whose
# rule main doesn't have yet, as when it first comes in, is the head's;
# once main has the rule, a list main lacks is an empty one.
raised=""
for each in "${rules[@]}"; do
  read -r rule list shape <<< "$each"
  main_list=""
  if git cat-file -e "origin/main:$list" 2> /dev/null; then
    main_list=$(git show "origin/main:$list")
  elif ! git cat-file -e "origin/main:$rule" 2> /dev/null; then
    continue
  fi
  head_list=""
  if [[ -f $whole/$list ]]; then head_list=$(< "$whole/$list"); fi
  raised+=$(awk -v list="$list" -v paths="$([[ $shape == whole ]] && echo 1 || echo 0)" '
    { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") }
    /^#/ || $0 == "" { next }
    paths { key = $0; n = 1 }
    !paths { key = $1; n = NF > 1 ? $2 : 1 }
    FNR == NR { main[key] = n; next }
    !paths && (NF != 2 || $2 !~ /^[1-9][0-9]*$/) {
      print list ": \"" $0 "\" is not a path and a count above 0"
      next
    }
    n + 0 > main[key] + 0 { print list ": " key " " n ", main has " main[key] + 0 }
  ' <(echo "$main_list") <(echo "$head_list"))$'\n'
done
raised=$(sed '/^$/d' <<< "$raised")
if [[ -n $raised ]]; then
  echo "$raised" >&2
  echo "merge-gate: $sha raises a list that only shrinks, above main's." >&2
  echo "If main's list fell since the branch was cut, rebase on origin/main; otherwise fix the code the line names rather than listing it. Then push, and merge the new head." >&2
  exit 1
fi

# The rules run under a config written here rather than the head's, with
# the checkout's packages, and import nothing but vitest and node's own.
# Each walks the whole tree, which takes past vitest's 5 seconds on a busy
# machine, so a test may take five minutes before it counts as failed.
ln -s "$PWD/node_modules" "$whole/node_modules"
config="$scratch/counts.config.mjs"
{
  echo "export default { cacheDir: '$scratch/cache', test: { include: ["
  printf "'%s'," "${counts[@]}"
  echo "], testTimeout: 300000 } };"
} > "$config"
set +e
said=$("$vitest" run --config "$config" --root "$whole" --color=false 2>&1)
counted=$?
set -e
if [[ $counted != 0 ]]; then
  echo "$said" >&2
  echo "merge-gate: main's count rules refuse $sha, or couldn't run on it; above says which." >&2
  echo "Do what it says in a checkout of the branch, run pnpm exec vitest run ${counts[*]}, push, and merge the new head." >&2
  exit 1
fi
echo "merge-gate: no count that only falls has risen at $sha"

# exec replaces this shell, so its EXIT trap would never run: the head's
# copy goes first.
rm -rf "$scratch"
trap - EXIT
exec bash "$here/host-gate.sh" "$sha"
