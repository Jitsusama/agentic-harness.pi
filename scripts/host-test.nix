# `pnpm test:host` on a pi-host runtime as a derivation, so a lent builder
# runs it rather than the machine its author works on. scripts/host-test-there.sh
# instantiates it and sends it; written first by 5KBYD7 for the pi bump
# (remote-prove/test-host.nix) and kept here so the merge gate has it.
#
# It always writes $out: the log, the exit status, the harness commit and
# the runtime, and vitest's JSON report, which host-prove judges with
# `--report`. Given files, it runs only those, the same way, with no case
# allowed to skip; that answers for a branch's own tests but proves nothing
# for a merge or a bump.
#
# The commit's files and node_modules go up as two store paths: the files
# are small and change with every commit; node_modules is large, so `deps`
# names a path an earlier run already sent, reused while its pnpm-lock.yaml
# is the commit's. Status 2 says the two lockfiles differ.
{
  # The runtime's store path, the folder its pi-monorepo is under.
  runtime,
  # A folder holding exactly the commit's files, as `git archive` writes them.
  source,
  # The commit those files are.
  rev,
  # The store paths the run needs on its PATH, bash first.
  tools,
  # A store path of node_modules beside its pnpm-lock.yaml, or null to take
  # them from `modules`, a checkout that has them installed.
  deps ? null,
  modules ? null,
  # Test files to run in place of the whole of test:host.
  files ? [ ],
}:
let
  store = builtins.storePath;
  under = top: path: builtins.substring 0 (builtins.stringLength top) path == top;
  bash = store (builtins.head tools);
  tree = builtins.path {
    path = /. + source;
    name = "agentic-harness-${builtins.substring 0 12 rev}";
  };
  # The same name and the same files as 5KBYD7's, so either sends the same path.
  sent =
    if deps != null then
      store deps
    else
      builtins.path {
        path = /. + modules;
        name = "agentic-harness-deps";
        filter =
          path: _type:
          path == "${modules}/pnpm-lock.yaml"
          || path == "${modules}/node_modules"
          || under "${modules}/node_modules/" path;
      };
  scoped = builtins.concatStringsSep " " (map (file: "'${file}'") files);
in
derivation {
  name = "pi-host-test-${builtins.substring 11 8 runtime}";
  system = "x86_64-linux";
  builder = "${bash}/bin/bash";
  runtime = store runtime;
  deps = sent;
  source = tree;
  inherit rev scoped;
  # The build user's own shell is /noshell, which script(1) would start, so
  # every case that drives a terminal through it failed on a lender
  # (5KBYD7, 10 November).
  SHELL = "${bash}/bin/bash";
  PATH = builtins.concatStringsSep ":" (map (tool: "${store tool}/bin") tools);
  args = [
    "-c"
    ''
      set -u
      export HOME=$TMPDIR/home XDG_STATE_HOME=$TMPDIR/state XDG_DATA_HOME=$TMPDIR/data
      export XDG_CONFIG_HOME=$TMPDIR/config XDG_CACHE_HOME=$TMPDIR/cache XDG_RUNTIME_DIR=$TMPDIR/run
      mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$out"
      mkdir -m 700 "$XDG_RUNTIME_DIR"
      echo "$rev" > "$out/harness"
      echo "$runtime" > "$out/runtime"
      if ! cmp -s "$deps/pnpm-lock.yaml" "$source/pnpm-lock.yaml"; then
        echo "deps was installed from another pnpm-lock.yaml than the commit's" | tee "$out/log"
        echo 2 > "$out/status"
        exit 0
      fi
      cp -a "$source" "$TMPDIR/harness" && chmod -R u+w "$TMPDIR/harness"
      cp -a "$deps/node_modules" "$TMPDIR/harness/node_modules" && chmod -R u+w "$TMPDIR/harness/node_modules"
      cd "$TMPDIR/harness"
      export PI_HOST_RUNTIME=$runtime PATH=$PWD/node_modules/.bin:$PATH
      unset PI_HOST_PACKAGE_DIR
      if [ -z "$scoped" ]; then
        script=$(node -p 'require("./package.json").scripts["test:host"]')
      else
        script="PI_HOST_REQUIRED=1 vitest run --project process --reporter=default --reporter=./tests/host/end-to-end/support/every-case-ran.mts $scoped"
      fi
      sh -c "$script \"\$@\"" test:host --reporter=json --outputFile.json="$out/report.json" 2>&1 | tee "$out/log"
      echo "''${PIPESTATUS[0]}" > "$out/status"
    ''
  ];
}
