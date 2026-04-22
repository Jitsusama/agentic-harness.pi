# Git Bypass Workflow

Registers a `/git-intercept` command that toggles git command
interception on and off within a session.

The git-cli-interceptor, commit-guardian and history-guardian
extensions enforce formatting rules and review gates on git
commands. That's the right default, but it gets in the way
when profiling git or doing other investigative work.

## Usage

Type `/git-intercept` to disable interception. Type it again
to re-enable. A persistent `⚠ Git Bypass` status indicator
appears in the footer when interception is off.

## How It Works

The bypass state lives on `globalThis` via `Symbol.for` so
it's shared across independently-loaded extensions. Each git
extension checks `isGitBypassed()` from
`lib/internal/git/bypass.ts`. If this workflow extension
isn't loaded, the state defaults to `false` and everything
behaves normally.
