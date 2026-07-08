# Correction Capture Extension

Turns the steering you do in a session into durable behavioural
rules, so a lesson taught once is standing guidance in every
session after.

## What It Does

Registers one tool, `capture_lesson`, that the agent invokes when
you ask it to remember a lesson or turn a correction into a rule.
There is no command; you drive it by talking.

- With no arguments, it reads the current session, distills the
  corrections into drafted behavioural rules using a cheap side
  model, and returns them without filing anything. You review the
  draft, refine it by talking, and only then file it.
- With `rules`, it files the approved rule texts into the
  governance store.
- With `list`, it returns the filed rules; with `remove` and a
  rule id, it deletes one.

## How It Works

The distillation runs through the shared side-completion helper
(`lib/completion`), which resolves a GLM-shaped model from the
registry and runs one completion off the agent's own loop. The
model is asked for a JSON array of short imperative rules; the
reply is parsed back into a clean list.

Filed rules live in a human-editable JSON file under the data
directory (`governance/rules.json`), so a bad rule is easy to fix
or delete by hand. The rules ride the prompt coordinator as a
resident block, so a lesson captured in one session is injected
into the system prompt of the next. They are also the watch-list
the advisor reviews turns against: capture files a rule, the
advisor enforces it.

## Category

Integration: it bridges the session to a side model to produce
durable rules, and shares the governance store with the advisor.
