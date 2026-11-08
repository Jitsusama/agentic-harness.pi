# Sandbox File Interceptor

Holds pi's own file tools to the strict sandbox's fence, in a session
that sets `PI_SANDBOX=strict`. A call reaching past it is refused, with
the reason.

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
- **Writing** reaches only the working folder and the sandbox's own
  cache and temporary folder.
- **Every link** in the path is followed, a dangling one too, so a link
  a command made inside the work leads nowhere the command couldn't go.
  Each spelling pi tries for a missing file is checked as well.
- **A working folder the sandbox won't fence** (the home folder, or one
  holding its repository's git folder) runs no file tool, as it runs no
  command.

A session with no sandbox is let through untouched, and a `PI_SANDBOX`
naming no sandbox refuses every file tool, as it refuses every command.

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
