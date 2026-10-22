# Away Workflow

Keeps a run working while you are away, without anything waiting on
you and without anything going out that you did not approve.

## Going Away

Tell the agent, the way you would tell a person: "I'm going to bed,
keep working through the subquests", "I'll be out this afternoon,
finish the plan". The agent calls the `away` tool with your goal in
your words. The footer then shows a quiet moon, `☾`, which turns the
warning colour with a count beside it, `☾ 3`, once something is
waiting for you.

The harness never switches away mode on from a phrase alone, because
pasted logs and quotes are full of them. When a message you typed
reads like a departure, it adds a one-line hint to the turn, and the
agent decides in context. `/away` exists as a fallback.

You are away from the machine, not from one window, so saying it
once is enough: every interactive pi session on the machine goes
away with the same goal, including ones started while you are gone.
Each keeps its own held calls and decisions, since only that session
can make them again.

## While You Are Away

- **Approvals that block are held.** A Slack message, an email, or
  any approval you switched to block with `/guards` is not sent and
  opens no panel. The agent is told it is held as `#N`, to carry on
  with other work, and not to look for a way round the gate.
  Approvals that redirect (commits, PRs, the review tools by
  default) go ahead as they always do.
- **Sign-ins are held too.** If Slack or Google needs signing in,
  no sign-in panel or browser opens; the call fails, saying so,
  and the sign-in is listed for you.
- **Questions take the agent's recommendation.** `ask` opens no
  dialog; a question with a recommended option takes it, and one
  without is handed back for the agent to decide from the evidence.
  Every answer is kept for you.
- **The run keeps going until it is finished.** A run may end only
  with a last line starting `Done:` (the goal is met) or `Blocked:`
  (everything left needs you). Any other ending, whether a summary,
  a question or an error, is sent back with your goal, the focused
  plan's progress and what is held. A `Done:` with plan items still
  open is sent back once.

Two bounds keep this from spending all night on nothing: three runs
in a row with no tool calls stop the nudging, and so do fifty nudges
in one absence. Either stop is said in the transcript.

## Coming Back

Type anything. Your message goes through at once, since it might be
"stop", and a note goes to the agent with it listing what was held
and what was decided for you. Nothing held is approved by coming
back: the agent deals with what you said, then makes again any held
call still wanted, and you are asked in its own panel. Stopping a run
with Escape also ends away mode.

Coming back in any window brings every session back. One you did not
type in is told you are back only when something waited there, and
is not told to deal with what you said, since you said nothing to it.

A "keep going" message not yet sent when you come back is withdrawn,
so the agent is never told you are away after you returned.

## Limits

- Sessions nobody sits at, such as subagents and print-mode runs,
  neither follow the machine's absence nor start one.
- A panel left open with nobody answering is not yet taken as a sign
  you have gone; say you are leaving.
- A restart while away comes back away, with what was held, and the
  first thing you type shows you what waited.

## Where It Lives

The state is in `lib/internal/away/`, shared through `globalThis`, so
the Slack, Google and review gates, the commit, PR and issue
guardians, `ask` and quest-workflow read it without importing this
extension. Quest-workflow registers the focused plan's progress with
it. Whether you are away is shared between sessions through one file,
`~/.local/state/pi/agentic-harness.pi/away-workflow/machine.json`,
which each session watches and follows. The "keep going" message is a job, said through job-workflow.
