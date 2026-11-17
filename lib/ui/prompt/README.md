# Prompt

The interactive prompts a panel holds, one file each: a single
decision (`prompt-single.ts`), a batch of them in tabs
(`prompt-tabbed.ts`), a list of toggles (`prompt-toggle-list.ts`),
and a stateful workspace acted in many times
(`prompt-workspace.ts`).

They lay out through `../panel/` and mount through the gate queue
in `../gate/`; callers reach them through `../panel.ts` and the
library's index.
