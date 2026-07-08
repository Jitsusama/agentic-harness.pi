# Advisor Extension

A second model that watches the main agent at work and raises
evidence-backed findings: scope drift, an ungrounded claim, a
violated rule, a correctness risk. It is the enforcement half of
the governance loop that correction capture feeds.

## What It Does

After each substantive turn, the advisor reviews the new
transcript delta against the captured governance rules,
investigates suspicions with a read-only tool palette, and
delivers findings by severity:

- An aside is a quiet tail note.
- A concern or blocker interrupts through the steer channel, so
  it can stop a wrong direction rather than only annotate it.

Every finding is framed as advice to weigh, not a command to
obey, and carries the evidence that grounds it: a file and line,
the text it read, the rule it breaks.

## How It Works

The advisor runs on a cheap side model (GLM via the proxy) using
the shared investigation loop (`lib/completion`), which lets the
model call read-only tools (`read`, `grep`, `glob`) before it
answers. It keeps one long-lived context per session, so its
prefix caches turn to turn rather than re-paying a cold spawn
each turn.

It is bounded and quiet by design:

- **Off by default, opt-in** through the `PI_ADVISOR` environment
  variable. Without it, nothing is wired.
- **Substantive turns only.** A turn that only read or answered a
  question is skipped; a turn that edited, wrote, committed or
  acted is reviewed.
- **Back-off.** After one interrupt fires, later concerns soften
  to asides for a couple of turns, so it does not nag.
- **Self-healing cursor.** It resets its review cursor and cached
  context when the transcript is compacted or rewritten, so it
  never reviews stale context, and filters its own injected notes
  so it never recurses on itself.
- **Main agent only.** Subagents load an isolated config without
  it.

Each review's token use and cost are recorded to the
observability run table under the `advisor` kind, so its
per-session cost is visible alongside subagent and council runs.

## Category

Workflow: it orchestrates a session-wide review loop with its own
persistent state, model and delivery channels.
