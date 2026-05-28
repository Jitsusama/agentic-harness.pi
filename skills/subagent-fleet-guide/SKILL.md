---
name: subagent-fleet-guide
description: >
  How to drive the `subagent` tool: spawn N pi processes
  concurrently for persona sweeps (security/performance/
  readability of the same artifact), multi-angle
  investigation (data flow vs lifecycle vs config of the
  same bug), or fleet brainstorming (N answers from N
  models). Use when the user asks to "examine from
  various angles", "get multiple perspectives", "fan out
  across personas", "parallel investigation", "have N
  models try this", or any request that benefits from
  divergent independent passes. Pairs with prose-standard
  for written voice and any domain skills the personas
  should inherit.
---

# Subagent Fleet Guide

Drive the `subagent` tool. The user wants several
independent passes over the same problem; the tool gives
each its own pi process, context window, model and tool
palette, then returns each subagent's final text for you
to synthesise.

This skill covers: when to fan out, how to shape personas
through system prompts, how to keep cost and cancellation
sane, and two worked examples that show the pattern
end-to-end.

## When to fan out

Three patterns earn the cost of N subprocesses:

- **Persona sweep** — same artifact, several roles. A
  security reviewer, a performance reviewer and a
  readability reviewer looking at the same module surface
  different concerns; the synthesis is richer than any
  single role would produce.
- **Multi-angle investigation** — same problem, several
  framings. "Walk the data flow", "trace the lifecycle"
  and "audit the configuration" applied to the same bug
  yield independent evidence; convergence is signal.
- **Fleet brainstorming** — same prompt, several models.
  When you want divergence (naming candidates, design
  alternatives, edge case enumeration), N models with the
  same instruction beat one model asked N times because
  each model brings its own priors.

Anti-patterns — don't reach for the fleet when:

- The work is sequential. Subagent B needs subagent A's
  output. Run them one at a time.
- The prompt is vague. Five subagents staring at the same
  fuzzy ask produce five fuzzy answers. Sharpen the
  prompt first.
- The work is trivial. A 30-second question doesn't
  benefit from parallelism; the supervisor startup cost
  alone is more than the saving.
- You'd be paying for redundancy. Three personas asking
  "what does this function do" all read the same lines
  and tell you the same thing.

## Persona = system prompt

`systemPrompt` is how each subagent learns its role. A
strong persona has three pieces:

```
You are a {role}. Your job is to {one-sentence mission}.
{One paragraph of taste: what you flag, what you ignore,
how you express findings.}
Return {output shape: bullet list, markdown report,
JSON conforming to schema X, …}.
```

Common personas to keep on hand:

- **Security reviewer** — "Surface auth, authz, input
  handling, secrets and crypto issues. Cite file:line.
  Ignore style. Use Conventional Comments labels."
- **Performance reviewer** — "Look for hot-path
  allocations, N+1 calls, blocking I/O, sync code in async
  paths. Quantify when you can. Skip readability."
- **Readability reviewer** — "Read like a new
  contributor: naming, structure, where the surprises
  are. Don't critique correctness."
- **Contrarian** — "Assume every claim in the prompt is
  wrong until proven. Counter-arguments first, agreement
  last."
- **Specialist X** — domain-specific role (database
  expert, accessibility reviewer, …). Persona prose
  carries the domain priors.

Three rules for persona prose:

1. **Isolate the role.** Default `isolated: true` so the
   user's ambient AGENTS.md and personal skills don't
   leak in and water down the persona. Flip to `false`
   only when the persona explicitly wants the
   inheritance — see the safety note below before doing
   so.
2. **Shape the output.** Tell each persona how to format.
   If you're going to synthesise three reports, pick a
   shape (bullets, markdown headings, JSON) and demand it
   in every persona prompt. Inconsistent shapes make
   synthesis painful.
3. **Constrain the palette.** A security reviewer rarely
   needs `bash`; a readability reviewer rarely needs
   `grep`. A tighter `tools` array means a cheaper, more
   focused run.

## Isolation and safety

`isolated: true` (the tool's default) spawns each
subagent with `--no-skills --no-context-files
--no-extensions`. The flag is convenient for clean-slate
investigation, but it strips the user's installed pi
extensions — including guardians and interceptors that
gate commits, PRs and shell commands.

Decide on isolation by what tools the subagent can call:

- **Read-only palettes** (`read`, `grep`, `glob`, `ls`):
  `isolated: true` is safe. The subagent can't mutate
  anything, so missing guardians don't matter.
- **Write or shell palettes** (`bash`, `write`, `edit`):
  set `isolated: false` so the parent's guardians load.
  Otherwise the child can run `git commit`, `rm -rf` or
  push code without the review gates the parent session
  relies on. The persona prompt should still demand a
  specific scope of work so the broader palette doesn't
  invite drift.

When in doubt, flip to `isolated: false` and tighten the
tool palette instead. Inheritance plus a narrow palette
costs almost nothing compared to losing every guardian
for speed.

## Always-load defaults

Some extensions need to be present in *every* subagent
regardless of isolation — credentials helpers, telemetry
hooks, organization-wide setup. Threading these into each
job's `extraExtensions` array by hand defeats the point.
The engine keeps a process-global registry that any pi
extension can populate once at activation; every later
subagent run picks them up automatically.

Outside pi extensions register defaults through a
two-way handshake. Use both directions so timing of
extension activation never matters:

```ts
const EXT = "/abs/path/to/creds.ts";

// Covers "we activated AFTER subagent-workflow".
pi.events.emit(
  "subagent-workflow:register-default-extension:v1",
  EXT,
);

// Covers "we activated BEFORE subagent-workflow".
pi.events.on("subagent-workflow:ready:v1", (api) => {
  api.registerDefaultExtension(EXT);
});
```

The registry dedupes by path, so both paths firing the
same entry is safe. The skill equivalent is
`subagent-workflow:register-default-skill:v1` with a
`SKILL.md` path payload.

For package-internal callers, import the functions from
`agentic-harness.pi/subagent` directly.

Registered defaults survive `isolated: true`: pi honours
explicit `--extension` and `--skill` flags even after
`--no-extensions` / `--no-skills`. That's the whole
premise of the hook — a clean-slate subagent that still
has the bits it actually needs.

Symptom to recognise when the hook is missing: a fleet
that all-fails on the first run with no obvious reason.
From v2 onwards each failure surfaces a stderr tail in
the summary (`✗ {id}: pi exited with code 1: …`); if
you see a credentials or configuration error there,
registering the relevant extension as a default fixes it.

## Cost and cancellation etiquette

Fleet runs are expensive — N subprocesses, N context
windows, N model calls. Three habits keep this honest:

- **Estimate before dispatching 5+ jobs.** "Three
  personas on a 400-line file" is fine; "ten personas on
  the whole repo" wants a sanity check first. Eyeball
  the prompt size × N.
- **Mention `Esc` to bail.** When you tell the user the
  fleet is running, remind them they can press `Esc` in
  the focused panel to cancel the whole fleet (or `r` to
  cancel the selected subagent). Long-running runs feel
  trapped without that cue.
- **Read `totalUsage`.** After the fleet settles, surface
  the aggregate spend ("4,200 tokens, $0.012") so the
  user has a feedback loop on cost. The tool's text
  summary includes this when usage is present.

If a fleet would dispatch more than ~5 jobs, ask first.
"Want me to run security + performance + readability on
this module, or scope it down?" gives the user an exit.

## Long-running personas

The supervisor enforces two ceilings on every subagent
run: a 20-minute hard wall-clock cap (`timeoutMs`) and a
5-minute idle ceiling (`idleTimeoutMs`) between supervisor
progress events. The idle ceiling is the one that bites
first in practice. A subagent that issues a single
long-running bash command — a benchmark that paces work
internally, a `gcloud` deploy that ssh-then-scps in
silence, a `git push` against a large mirror — stays
invisible to the supervisor for the whole duration and
gets a SIGTERM at the 5-minute mark. The symptom looks
like `✗ {id}: pi exited with code 143` with a half-
finished workflow on disk.

Every job accepts optional per-call overrides:

- **`timeoutMs`** — hard wall-clock cap in milliseconds.
  Bump this when the work legitimately runs longer than
  20 minutes (soak tests, recovery journeys, deep
  multi-step deploys).
- **`idleTimeoutMs`** — gap between supervisor protocol
  events before the child is declared stuck, in
  milliseconds. Bump this when the subagent will sit on
  one bash command that produces no intermediate output.

Overrides are per-job. Short-lived siblings in the same
fleet keep the tight defaults, so a stuck reviewer in
that slot still fails fast.

Size the override against the longest single bash
command the persona will issue, then add headroom.
Rough guidance:

| Workload                                       | `idleTimeoutMs` | `timeoutMs` |
|------------------------------------------------|-----------------|-------------|
| Read-only investigation (default)              | unset           | unset       |
| Benchmark / deploy run with paced internal work | 15 min          | 45 min      |
| Soak or recovery journey, multi-iteration      | 30 min          | 90 min      |

If you can't predict the bash duration, ask the persona
to narrate progress (`echo` between steps, `tee` per-
iteration output) so the supervisor sees activity. The
idle clock resets on every supervisor event.

Example — a benchmark persona that paces 100 pushes over
several minutes:

```ts
subagent({
  jobs: [
    {
      id: "baseline-bench",
      cwd: "/tmp/run",
      systemPrompt: "You are a perf engineer establishing a baseline …",
      userPrompt: "Run gsperf against production, capture results.",
      tools: ["read", "write", "bash"],
      isolated: false,
      idleTimeoutMs: 15 * 60 * 1000,  // 15 min between supervisor events
      timeoutMs: 45 * 60 * 1000,       // 45 min wall-clock cap
    },
  ],
});
```

## Worked example 1 — three-persona project audit

User asks: "Take a look at `src/auth/` from a few
different angles."

```ts
subagent({
  jobs: [
    {
      id: "security",
      model: "anthropic/claude-haiku-4-7",
      thinkingLevel: "high",
      tools: ["read", "grep", "glob"],
      cwd: "/path/to/repo",
      systemPrompt:
        "You are a security reviewer. Audit src/auth/ for " +
        "auth, authz, input handling, secrets and crypto " +
        "issues. Cite file:line. Ignore style. Return a " +
        "markdown report with sections: Critical, Notable, " +
        "Nits.",
      userPrompt:
        "Audit src/auth/ for security issues. Use the report " +
        "shape in the system prompt.",
    },
    {
      id: "performance",
      model: "anthropic/claude-haiku-4-7",
      tools: ["read", "grep"],
      cwd: "/path/to/repo",
      systemPrompt:
        "You are a performance reviewer. Walk src/auth/ for " +
        "hot-path allocations, N+1 calls, blocking I/O. " +
        "Quantify when you can. Return the same markdown " +
        "shape as the security reviewer.",
      userPrompt:
        "Walk src/auth/ for performance issues. Use the " +
        "report shape in the system prompt.",
    },
    {
      id: "readability",
      model: "anthropic/claude-haiku-4-7",
      tools: ["read"],
      cwd: "/path/to/repo",
      systemPrompt:
        "You are a new contributor reading src/auth/ for the " +
        "first time. What's confusing? What's well-named? " +
        "Return the same markdown shape.",
      userPrompt:
        "Read src/auth/ as a new contributor. Use the report " +
        "shape in the system prompt.",
    },
  ],
});
```

After the fleet settles, synthesise: collect the
Critical bullets from each report, dedupe, surface the
shared concerns first, then per-persona signals. Hand
the user a synthesis paragraph plus the three full
reports.

## Worked example 2 — multi-angle bug investigation

User reports: "Sessions are randomly logging out users in
production. We don't see a pattern."

```ts
subagent({
  jobs: [
    {
      id: "data-flow",
      model: "anthropic/claude-haiku-4-7",
      thinkingLevel: "high",
      tools: ["read", "grep", "glob"],
      cwd: "/path/to/repo",
      isolated: true,
      systemPrompt:
        "You investigate bugs by tracing data flow. Pick " +
        "one user session and trace its lifecycle through " +
        "the auth code. Where can state be lost? Cite " +
        "file:line. Report findings as a numbered list.",
      userPrompt:
        "Trace a user session through src/auth/. Where can " +
        "we lose state mid-session?",
    },
    {
      id: "lifecycle",
      model: "anthropic/claude-haiku-4-7",
      thinkingLevel: "high",
      tools: ["read", "grep"],
      cwd: "/path/to/repo",
      isolated: true,
      systemPrompt:
        "You investigate bugs by mapping object " +
        "lifecycles. Find every place a session can be " +
        "constructed, mutated or destroyed. Report as a " +
        "numbered list.",
      userPrompt:
        "Map the session lifecycle in src/auth/. Where can " +
        "a session be destroyed unexpectedly?",
    },
    {
      id: "config",
      model: "anthropic/claude-haiku-4-7",
      tools: ["read", "grep", "glob"],
      cwd: "/path/to/repo",
      isolated: true,
      systemPrompt:
        "You investigate bugs by auditing configuration. " +
        "Find every env var, config flag and timeout that " +
        "affects session lifetime. Report as a numbered " +
        "list with default values.",
      userPrompt:
        "Audit configuration that affects session lifetime.",
    },
  ],
});
```

Note `isolated: true` on every job — the bug
investigation is sensitive to context priors. Ambient
AGENTS.md skills that mention session handling would bias
all three subagents toward the same hypothesis. Cleaner
priors give cleaner triangulation.

After the fleet settles, look for **convergence**: which
file:line citations appear in two or more reports?
Convergence is your strongest signal. Hand the user the
convergent findings plus the three full investigations.

## Quick reference

| When you want…                            | Reach for…                |
|-------------------------------------------|---------------------------|
| Several roles on the same artifact        | Persona sweep (this skill) |
| Several framings of the same problem      | Multi-angle (this skill)   |
| Multiple model takes on the same prompt   | Fleet brainstorm (this skill) |
| Sequential investigation                  | The agent's main loop      |
| Code review with structured findings      | `pr_workflow` tool         |
| One subagent with a tight contract        | `subagent` with a single job |
