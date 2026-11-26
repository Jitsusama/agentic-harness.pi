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
# with no change refused. Here main's copy of each rule judges the tree
# the merge would make, and each of its lists may only shrink against
# main's, so a head can't loosen a rule or raise its own list to pass, and
# a line main took off since the branch was cut stays off. Then it hands
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

# Main is fetched to its remote branch by name, since the checkout's own
# refspec might leave origin/main where it was.
git fetch -q origin +refs/heads/main:refs/remotes/origin/main
if ! git cat-file -e "$sha^{commit}" 2> /dev/null; then git fetch -q origin "$sha"; fi

# GIT_ATTR_SOURCE, which keeps the tree's attributes out of what's judged
# below, came in git 2.42, and an older git would ignore it unsaid.
version=$(git --version)
if [[ ! $version =~ ^git\ version\ ([0-9]+)\.([0-9]+) ]]; then
  echo "merge-gate: can't read which git this is from \"$version\"." >&2
  exit 1
fi
if ((10#${BASH_REMATCH[1]} < 2 || (10#${BASH_REMATCH[1]} == 2 && 10#${BASH_REMATCH[2]} < 42))); then
  echo "merge-gate: $version can't keep attributes out of what it judges, which needs git 2.42." >&2
  echo "Merge from a machine with a newer git." >&2
  exit 1
fi
# What's judged is read and merged in a repository of the gate's own, made
# from no template and borrowing this checkout's objects, so nothing the
# checkout or the person set can shape it. A merge driver, even one named
# for git's own text merge, replaces the built-in merge wherever it's set,
# and no setting turns the checkout's info/attributes off, so pinning each
# setting would always leave one more. Here no config but the new
# repository's is read, the global and system files shut out, and every
# GIT_ variable the gate was given (a config, a graft file, a replace base,
# a folder) unset rather than a named few, since each could reach it. Only
# commits are named, by their ids, and the checkout's refs, replacements
# among them, aren't there, so every commit's contents are read here. The
# rules run under the same, so none of their own git reaches the checkout.
judging="$scratch/judging"
inherited=()
# Bash's own list of the names, since compgen is missing from a bash built
# without completion, and the sweep would then shut out nothing.
for name in "${!GIT_@}"; do inherited+=(-u "$name"); done
# Git with none of that, and only the variables given before the command.
clean() {
  env ${inherited[@]+"${inherited[@]}"} GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 "$@"
}
clean git init -q --template= "$judging"
objects=$(git rev-parse --path-format=absolute --git-common-dir)/objects
echo "$objects" > "$judging/.git/objects/info/alternates"
# Named past any replacement, which could make either another commit, and
# main by its full name, which no tag or branch of the checkout's outranks.
head_id=$(git --no-replace-objects rev-parse --verify "$sha^{commit}")
main_id=$(git --no-replace-objects rev-parse --verify "refs/remotes/origin/main^{commit}")

# The files judged come from an index of the gate's own, not git archive,
# which leaves out whatever .gitattributes marks export-ignore and so would
# hide those files from every check here. It holds the head's files for
# Biome, then the merge's for the counts. No attributes are read, the tree's
# or the person's, so none (an encoding, a filter) changes a file from the
# blob code-health reads, and a link is written as a file holding its
# target, so none reaches outside the copy.
empty_tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904
unattributed() {
  clean GIT_ATTR_SOURCE=$empty_tree GIT_ATTR_NOSYSTEM=1 \
    GIT_INDEX_FILE="${index:-$judging/.git/index}" \
    git -C "$judging" -c core.attributesFile=/dev/null "$@"
}
gate_index() {
  index="$scratch/index" unattributed -c core.symlinks=false "$@"
}
gate_index read-tree "$head_id"
base=$(unattributed merge-base "$main_id" "$head_id")

# The Biome this checkout installed must be the one the head pins, or it
# could pass what the pinned one faults.
pinned=$(unattributed cat-file blob "$head_id:package.json" |
  jq -r '.devDependencies["@biomejs/biome"] // empty')
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
changed=$(unattributed diff --name-only --diff-filter=d "$base" "$head_id" -- \
  '*.ts' '*.mts' '*.cts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.jsx' \
  '*.json' '*.jsonc' '*.css')
if [[ -n $changed ]]; then
  mapfile -t files <<< "$changed"
  tree="$scratch/changed"
  mkdir "$tree"
  # The config goes out once: named again as a changed file, checkout-index
  # would find the copy it just wrote and refuse the whole checkout.
  others=()
  for file in "${files[@]}"; do
    [[ $file == biome.jsonc ]] || others+=("$file")
  done
  gate_index checkout-index --prefix="$tree/" -- biome.jsonc "${others[@]}"
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

  # A head judges itself by its own config, as pnpm lint at the head would,
  # so a change that loosens a rule passes its own check. It may mean to,
  # so it isn't refused, but the files the base's config would fault are
  # named, for whoever merges to see what the change lets through.
  if [[ ${#others[@]} -gt 0 && ${#others[@]} -lt ${#files[@]} ]] &&
    unattributed cat-file -e "$base:biome.jsonc" 2>/dev/null; then
    before="$scratch/before"
    mkdir "$before"
    gate_index checkout-index --prefix="$before/" -- "${others[@]}"
    unattributed cat-file blob "$base:biome.jsonc" > "$before/biome.jsonc"
    if ! (cd "$before" && "$biome" check --vcs-enabled=false --no-errors-on-unmatched \
      --colors=off "${others[@]}" > "$scratch/before.said" 2>&1); then
      echo "merge-gate: $sha changes biome.jsonc, and main's config faults what it lets through:" >&2
      cat "$scratch/before.said" >&2
      echo "merge-gate: so the change loosens a rule for these files; that passes, said here." >&2
    fi
  fi
fi

if [[ ! -x $vitest ]]; then
  echo "merge-gate: $PWD has no vitest installed, so $sha's counts can't be judged." >&2
  echo "Run pnpm install --frozen-lockfile in that checkout, then merge again." >&2
  exit 1
fi

# A head's own packages would stand before the checkout's, and the rules
# would import its vitest rather than the one installed. A Mac's disk
# takes Node_Modules for node_modules, so any case is refused.
tracked=$(unattributed ls-tree -r --name-only "$head_id")
if grep -qiE '(^|/)node_modules(/|$)' <<< "$tracked"; then
  echo "merge-gate: $sha tracks files under a node_modules folder, which would stand before the installed packages." >&2
  echo "Remove them from the branch, push, and merge the new head." >&2
  exit 1
fi

# The counts judge what lands, the merge of main and the head, rather than
# the head as it was cut. On 24 November #2114 took a line off the long
# list, and every head cut before it still listed that line, so the gate
# refused four with nothing of their own raised. The merge drops the line
# main took off, and it keeps whatever main fixed since, so a head can't
# bring back a count main lowered. Attributes or a driver would shape the
# merge (a list merged as a union keeps a line main took off), so none is
# read, as for the index.
set +e
merged=$(unattributed merge-tree --write-tree --name-only --no-messages "$main_id" "$head_id" \
  2> "$scratch/merging")
merging=$?
set -e
if [[ $merging == 1 ]]; then
  # Past the tree's id, each file that conflicts, quoted as git quotes it.
  if [[ $merged == *$'\n'* ]]; then echo "${merged#*$'\n'}" >&2; fi
  echo "merge-gate: $sha doesn't merge cleanly with main, so what it would land can't be judged." >&2
  echo "Rebase the branch on origin/main, push, and merge the new head." >&2
  exit 1
elif [[ $merging != 0 ]]; then
  cat "$scratch/merging" >&2
  echo "merge-gate: git can't write the tree $sha's merge with main would make; above says why." >&2
  exit 1
fi
gate_index read-tree "${merged%%$'\n'*}"

# That tree whole, its rules swapped for main's, so nothing of the head's
# decides how it's judged. Only a rule main doesn't have yet, as when it
# first comes in, is the head's own; one neither has refuses.
whole="$scratch/whole"
gate_index checkout-index -a --prefix="$whole/"
for rule in "${counts[@]}" "${helpers[@]}"; do
  if unattributed cat-file -e "$main_id:$rule" 2> /dev/null; then
    rm -rf "${whole:?}/$rule"
    # A link the head put where one of the rule's folders was is a file
    # here, which gives way to the folder.
    at=$(dirname "$rule")
    while [[ $at != . ]]; do
      if [[ -e $whole/$at && ! -d $whole/$at ]]; then rm -f "${whole:?}/$at"; fi
      at=$(dirname "$at")
    done
    mkdir -p "$(dirname "$whole/$rule")"
    unattributed cat-file blob "$main_id:$rule" > "$whole/$rule"
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
  if unattributed cat-file -e "$main_id:$list" 2> /dev/null; then
    main_list=$(unattributed cat-file blob "$main_id:$list")
  elif ! unattributed cat-file -e "$main_id:$rule" 2> /dev/null; then
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
  echo "Fix the code the line names rather than listing it, push, and merge the new head." >&2
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
said=$(clean "$vitest" run --config "$config" --root "$whole" --color=false 2>&1)
counted=$?
set -e
if [[ $counted != 0 ]]; then
  echo "$said" >&2
  echo "merge-gate: main's count rules refuse $sha merged with main, or couldn't run on it; above says which." >&2
  echo "Do what it says in a checkout of the branch rebased on origin/main, run pnpm exec vitest run ${counts[*]}, push, and merge the new head." >&2
  echo "Where main alone fails them, main is fixed first." >&2
  exit 1
fi
echo "merge-gate: no count that only falls has risen at $sha"

# exec replaces this shell, so its EXIT trap would never run: the head's
# copy goes first.
rm -rf "$scratch"
trap - EXIT
exec bash "$here/host-gate.sh" "$sha"
