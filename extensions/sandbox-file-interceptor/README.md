# Sandbox File Interceptor

Holds pi's own file tools to the sandbox a session's commands run in,
`PI_SANDBOX=strict` or `PI_SANDBOX=fence`. A call reaching past it is
refused, with the reason.

## What It Does

The strict sandbox (see the shell workflow's [A Strict Sandbox][1])
fences each command an agent runs. pi's own read, grep, find, ls, edit
and write run in pi's process, where Landlock never reaches. So a
session reading what a stranger wrote could still be told to read a
token file with them and quote it back, or to write code where the
person's shell would run it. A council's reviewers run no commands at
all, and these tools are all they have.

Each call to one of them is checked before it runs:

- **Reading** reaches only what a fenced command may read: the work,
  its repository when it is a worktree, the store and the profiles, the
  system's settings, and git's and Nix's settings in the home folder.
  `/proc` is left out, since pi's own process holds every token the
  sandbox keeps from commands.
- **The session's skills** may be read too, never written. pi names
  each skill's file and leaves the model to read it, so refusing them
  would leave a reviewer without the contract its answer follows.
- **Writing** reaches only the working folder and the sandbox's own
  cache and temporary folder.
- **Every link** in the path is followed, a dangling one too, so a link
  a command made inside the work leads nowhere the command couldn't go.
  Each spelling pi tries for a missing file is checked as well.
- **A working folder the sandbox won't fence** runs no command. In the
  home folder it runs no file tool either. One holding its repository's
  git folder, a plain clone, may be read but never written, since only
  writing reaches the hooks git runs outside; a review that falls back
  to the session's own checkout still reads it.

A session with no sandbox is let through untouched, and a `PI_SANDBOX`
naming no sandbox refuses every file tool, as it refuses every command.

## Under the Agent Fence

The agent fence (see the shell workflow's [The Agent Fence][2]) keeps
the work open and the desktop closed, and pi's file tools follow it:

- **Writing** is refused where a fenced command can't write: the
  settings and startup files it binds read-only, a new file or a link
  in the home folder itself, a visible folder there but the one the
  session works in, and the runtime folder. The path as named
  counts as well as where it leads, since writing a link may replace
  it.
- **Reading** is refused for any process's files in `/proc`, pi's own
  through `/proc/self` included, and for the runtime folder, which
  holds the clipboard's pictures and the desktop's sockets.
- **Every link** is followed as above, so a link made in the work
  leads nowhere the fence refuses.

Everything else, the home folder's hidden entries and the work, reads
and writes as it did.

It blocks rather than asks, and through no guard policy: a fence a
policy could soften is one an injected instruction could talk its way
past.

## What It Doesn't Do

A check comes before the tool runs, so a command running at the same
moment could swap a checked file for a link between the two. A session
that runs commands beside its file tools is fenced against what it is
told to read, not against a command racing them; a council's reviewers
run no commands. Other extensions' tools aren't checked, so a session
reading strangers' text keeps to a small set of tools, as a council
does.

[1]: ../shell-workflow/README.md#a-strict-sandbox
[2]: ../shell-workflow/README.md#the-agent-fence
