# ssh guard

The programs behind the ssh guard
([`lib/internal/shell/ssh-guard.ts`](../../lib/internal/shell/ssh-guard.ts)).
While the package config's `ssh-guard` section says `"refuse": true`, an
agent's command finds `bin/` first on its `PATH`, so its ssh, scp, sftp
and rsync go through `guard.bash`. That refuses any of them reaching one
of the person's own machines, the ones named in `PI_SSH_GUARD_MACHINES`,
and names `mycelium run --need machine=<name> -- <command>` instead,
which runs the command inside the fence the node lays there. Every other
call runs the real program, found on `PATH` after `bin/`, as given.

- `bin/`: one stand-in for each program, which runs `guard.bash` with
  its own folder and name.
- `guard.bash`: the check, written for bash 3.2 too, as a Mac's
  `/bin/bash` is.

To turn it on, add this to `~/.config/pi/agentic-harness.pi/config.json`;
every session reads it within a minute, and removing it turns it off
again the same way:

```json
{ "sections": { "ssh-guard": { "refuse": true } } }
```
