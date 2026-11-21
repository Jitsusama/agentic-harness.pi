# Fence

The agent fence: what every fenced command may see and write, the
copies it binds over files inside, its doors to GitHub, the clipboard
and the builders, the routes a refused command is told, its profile on
a Mac, the census of who runs fenced, the pre-flight checks that prove
it still lets the work through, which pis it takes, the line each
refusal leaves in the system's log, and its one exemption.

Many entries because each is one piece of the fence that every other
reads against: split into folders, a path's way from hidden to let
through to read-only would cross folders, and a reviewer reading one
would miss what another binds over it.

## Files

- **`fence.ts`**: the agent fence, as bubblewrap's and landrun's
  arguments: each command's own processes and devices, no desktop,
  and the settings, startup files and git's code read-only; what it
  never lets through, the one SSH agent it lets in (core's proxy),
  the private keys it empties, and where it keeps pi's own file tools
  from.
- **`fence-command.ts`**: the shell text that runs a command in the
  fence, with every variable exported but those naming the desktop,
  its doors to Nix, SSH's agent and GitHub, and the fence's own
  `wl-copy` and `wl-paste` ahead on the path.
- **`fence-args-file.ts`**: bubblewrap's arguments in a file it
  reads through `--args`, and the git folders the after-check guards
  in another, among the fence's copies in the runtime folder, so a
  command's text stays under the 128 KiB Linux takes in one string
  however many trees its session holds; each named by what it holds,
  renewed each use, and removed after a day unused.
- **`fence-github.ts`**: the GitHub door (core's
  `modules/pi/github-door`) as the fence uses it: the session's own
  folder bound in read-only, gh and git sent through the door's relay
  with a placeholder token and the session's trust bundle, and the
  door's control socket kept out.
- **`compile-cache-place.ts`**: where every pi process keeps node's
  compile cache and the host's, a private folder of the login's
  runtime folder that the fence's root empties, or else a folder of
  pi's state the fence holds read-only, so no fenced command can plant
  code that node runs outside the fence.
- **`fence-dev.ts`**: the session's own writable copies of dev's
  settings and git's global settings, one set for each pi process,
  made outside and bound over the person's, so a fenced `dev up` can
  write them and the person's stay read-only.
- **`fence-disk.ts`**: the disk as the fence reads it, what a path
  is and what a folder holds, which a test hands in a disk of its own
  for.
- **`fence-docker.ts`**: whether Docker's settings hold a login
  or name the keychain's helper, and are then emptied inside.
- **`fence-hidden.ts`**: what the fence keeps from every command,
  read from `data/fence-hidden.json`, which core's secret asks read
  too.
- **`fence-gpu.ts`**: the GPU's render nodes, bound into every
  fence's /dev, and never a card node.
- **`fence-git-root.ts`**: a worktree's shared git folder, read-only
  inside, and watched from pi's process as a second guard that removes
  any name planted that sends git outside elsewhere, and stops the
  session that could have planted it.
- **`fence-git-route.ts`**: the route a fenced git command is told
  when the read-only shared git folder fails it (a branch or tag
  delete, `git pack-refs`, pruning a packed ref), a tree it doesn't
  hold, signing or World's Delta credential, each one counted.
- **`fence-route.ts`**: the route a fenced command is told when the
  fence refused it something not git's: a pass kept, or a write
  outside what the session holds, each one counted.
- **`fence-direnv.ts`**: direnv inside the fence, which trusts the
  work trees and quests' scratch folders through settings of its own,
  never the person's allow list, and the route a refused `.envrc`
  is told.
- **`fence-broker-trees.ts`**: the work tool's trees read-only
  inside but the session's own, their `.git` files aside, since git
  outside runs in every one.
- **`fence-worktrees.ts`**: which worktrees a fenced session writes,
  the one it stands in and each other it holds, so git and pi's file
  tools work in a held tree from a command started elsewhere.
- **`fence-clipboard.ts`**: the fence's own `wl-copy` and
  `wl-paste`, first on a fenced command's path, which ask core's
  clipboard door outside rather than a display.
- **`fence-lifted.ts`**: the fence lifted from every session but a
  fleet's subagents until it relands, since the default from 13
  November stayed in each running pi's own environment.
- **`fence-run.ts`**: one command in the fence for a caller outside
  pi, such as the mycelium node's `runs` prefix: the agent fence, or
  the strict profile inside the fence's bubblewrap root, refusing a
  folder whose writes would reach what runs outside
  (`scripts/pi-fence.ts`). On a Mac it runs the command under
  sandbox-exec instead.
- **`fence-child.ts`**: pi-fence's run of that command, in a group
  of its own that ends with pi-fence however pi-fence ends, a caller's
  signal or a kill outright, since a Mac's sandbox doesn't die with
  its parent as bubblewrap does. It contains accidents, not a hostile
  command, which can leave its group.
- **`fence-seatbelt.ts`**: the fence on a Mac: the same mounts as
  a sandbox-exec profile, rule for rule, mach services allowed only
  by name, its own processes, the sockets and ports it is given, and
  the Mac's own secrets hidden.
- **`fence-builders.ts`**: the builders' runtime folders inside the
  fence, read-only and without the cloud token nix-offload's lenders
  hold, since Nix finds its builders elsewhere and `nix-offload there`
  runs outside.
- **`fence-census.ts`**: every live session on the machine, judged
  by what its commands' processes show rather than what its presence
  claims: proven fenced (NoNewPrivs, mounts of its own, and nothing
  the fence hides in sight), claimed by its environment while it runs
  nothing and seen fenced in the last day, or unfenced
  (`pi-fence census`).
- **`fence-census-here.ts`**: the census run on this machine, over
  every realm's presences and what earlier censuses saw, loaded by
  `pi-fence` only when the census is asked for, so its run path needs
  no package.
- **`fence-preflight.ts`**: how the fence's pre-flight runs a check,
  fenced as a session's command or outside, and turns verdicts into a
  report and an exit status (`scripts/fence-preflight.ts`).
- **`fence-preflight-checks.ts`**: the checks themselves: what the
  person and agents must still be able to do with the fence on, and
  what must stay refused.
- **`fence-preflight-desktop.ts`**: the checks of the person's
  desktop: a fenced copy and paste with his selection kept, and a
  fenced window opening behind, each leaving his focus where it was.
- **`fence-preflight-git.ts`**: the checks of git in a fenced
  worktree: its everyday work still goes, and git outside never sees a
  name planted in the shared git folder.
- **`fence-home.ts`**: what in the home folder runs code as the
  person later, which the fence keeps read-only: settings, startup
  files and programs' entries whose settings name a command, with
  the caches within them bound back and the programs given a home of
  their own in the sandbox's cache.
- **`fence-seed.ts`**: those own homes seeded from what the person's
  programs already downloaded (cargo's crates, index and git clones),
  copied one way by reflink, again at most every ten minutes.
- **`fence-copy.ts`**: where the fence keeps the copies it binds over
  files inside, pi's folder in the runtime folder, written when they
  change.
- **`fence-npmrc.ts`**: the copy of `~/.npmrc` the fence binds over it,
  every line but its registry tokens'.
- **`fence-quest-locks.ts`**: the quest lock folder bound back writable
  into the emptied runtime folder, only where it is a folder of the
  person's alone, so a fenced writer and one outside take one lock; an
  empty file in its place otherwise, so a fenced writer writes no quest.
- **`fence-ssh.ts`**: the copy of the system's SSH settings the fence
  binds over them, each included file written in, since ssh inside
  refuses root's files as nobody's.
- **`fence-stage.ts`**: which pis the fence takes by default in its
  first stage (subagents, fresh `quest spawn` sessions and those listed
  by hand, under pi's state, `scripts/fence-stage.ts`), and how
  `PI_SANDBOX` reads: `off` runs a session as it is, and an empty or
  unknown value reads as the fence, saying so once.
- **`fence-declaration.ts`**: the fence a spawned session tells
  mycelium's node it runs in: the spawn's own word, `fence` or
  `strict`, then its quest's, with a word that names neither refused
  rather than read as a fence. The two tests a fence passes are said
  word for word. One nobody declared tells the node, from `default`,
  what it truly runs: strict under a strict parent, which its child
  keeps, the fence where the first stage takes it, and none otherwise.
  A fresh session starts with `PI_SANDBOX` set to a declared fence,
  or to strict under a strict parent; any other sets none, so the
  stage decides as before.
- **`fence-log.ts`**: the line each sandbox refusal in pi's own
  process leaves in the system's log under `pi-fence`, naming the
  tool, sandbox and session but never what was asked for.
- **`offload-exemption.ts`**: the fence's one exemption, a
  `nix-offload there` call let out to run as the person: what may go
  out, and the environment and git it is given there, through
  `nix-offload outside` where it has one.
