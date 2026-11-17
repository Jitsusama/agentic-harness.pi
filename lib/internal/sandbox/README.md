# Sandbox

What both sandboxes build on, beside `sandbox.ts`, which picks the
sandbox a session asked for: the shell text, the tree a fenced command
stands in, the check pi's own file tools are held to, and the brokers
that hand the strict sandbox its hour-long tokens.

## Files

- **`gcloud-broker.ts`**: the hour-long cloud tokens the machine's
  gcloud-broker mints for its agents' account, asked for in the
  background every few minutes for the strict sandbox.
- **`github-broker.ts`**: the hour-long GitHub tokens the machine's
  github-broker gives the strict sandbox, asked for every few minutes.
- **`sandbox-shell.ts`**: the shell text both sandboxes build on: a
  word quoted for the shell, and the variable a command travels in.
- **`sandbox-trees.ts`**: which tree a fenced command stands in, and
  the git folder a call outside the fence is held to there.
- **`sandbox-files.ts`**: the check `sandbox-file-interceptor` holds
  pi's own file tools to, under either sandbox.
