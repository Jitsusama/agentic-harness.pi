# Sandbox

Which sandbox a session asked for, and what both sandboxes build on:
the shell text, the tree a fenced command stands in and where pi may
run git outside it, the programs that run outside it, the check pi's
own file tools are held to, and the brokers that hand the strict
sandbox its hour-long tokens.

## Files

- **`sandbox.ts`**: which sandbox a session asked for and the shell
  text that runs each command in it, under the strict profile's rules
  or the agent fence from `fence/fence.ts`.
- **`mac-sandbox.ts`**: whether pi already runs inside a sandbox on
  a Mac, which decides whether a fenced session's commands run there
  as they are or with the fence laid around each.
- **`fence-told.ts`**: what a hosted session's tools tell its host of
  the fence they hold it to, so the host's record says what really
  runs under it.
- **`strict-rules.ts`**: what the strict profile lets a command reach,
  as landrun's rules, and how far pi's own file tools reach under it.
- **`gcloud-broker.ts`**: the hour-long cloud tokens the machine's
  gcloud-broker mints for its agents' account, asked for in the
  background every few minutes for the strict sandbox.
- **`github-broker.ts`**: the hour-long GitHub tokens the machine's
  github-broker gives the strict sandbox, asked for every few minutes.
- **`delta-token.ts`**: Delta's token for the agent fence, asked of
  mint outside it once a quarter hour, for `dt` and `devx ci`.
- **`sandbox-shell.ts`**: the shell text both sandboxes build on: a
  word quoted for the shell, and the variable a command travels in.
- **`sandbox-trees.ts`**: which tree a fenced command stands in, and
  the git folder a call outside the fence is held to there.
- **`quest-folders.ts`**: the folders a session's quest keeps on this
  machine, as the sandbox binds them: its scratch, its shared folder,
  and those a fenced command's direnv trusts an `.envrc` in.
- **`sandbox-files.ts`**: the check `sandbox-file-interceptor` holds
  pi's own file tools to, under either sandbox.
- **`leads-to.ts`**: where a path leads past its links, made yet or
  not, as a write to it would land; the one walk `sandbox-files.ts`,
  `tree-git.ts` and `unfenced-folder.ts` judge paths by.
- **`unfenced-folder.ts`**: the folders a sandbox won't let a command
  take as its own to write, since what's written there is read later
  outside every sandbox; the fence's own list, which strict and pi's
  file tools ask first.
- **`tree-git.ts`**: where pi may run git outside the sandbox, and
  with which git folder: a tree only as its own files agree, and in a
  sandboxed session only in repositories the fence guards.
- **`system-program.ts`**: finding a program that runs outside the
  sandbox (bwrap, landrun, nix-offload, env, pi-spawner) only in the
  system's own profile, through steps root alone can change.
- **`unattended-exec.ts`**: running git and gh with nobody at the
  keyboard.
