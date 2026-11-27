# Wiring

What the quest workflow registers with pi and the events it answers,
one file per reason to change. `../index.ts` builds the state and calls
each in turn, so it reads as the extension's table of contents.

- `parameters.ts`: the quest tool's arguments and what each means to
  each action.
- `tool.ts`: the quest tool as pi sees it: its guidelines, how a call
  runs and answers, and how its call and result are drawn.
- `commands.ts`: the `/quest` and `/quest-resume` slash commands.
- `calls.ts`: the guards each tool call is held to, and the quest
  records, pointers and desktop lists it leaves behind.
- `turns.ts`: what's kept current turn by turn: the plan's progress for
  away-workflow, the loaded quest's slice and the budget.
- `session.ts`: a session's life on its quest, from its start's
  loading, recording and hint to its shutdown's stamps and release.
- `scoreboard.ts`: the loaded quest's one line on screen.
- `on-top.ts`: what the person put on top, said to every session as a
  standing context.
- `answer-the-person.ts`: how a session answers its person, first and
  for the whole quest, said to every session as a standing context.
