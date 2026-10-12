/**
 * The agent's shell has nobody at the keyboard.
 *
 * pi already closes stdin and starts the shell without a terminal, so a
 * plain prompt fails rather than waits. An editor is different: git
 * launches one for a rebase todo or a commit message, and it sits there
 * until somebody aborts the command. A pager is the same in kind, though
 * it only starts when output is a terminal. These variables are set for
 * the child alone, so pi's own editor and the person's shell are left as
 * they were, and a variable the command sets itself still wins.
 */

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

/**
 * What the agent's commands run with.
 *
 * `true` as the editor keeps the message git already has (a merge, a
 * revert, `rebase --continue`) and fails fast where it has none, such as
 * a commit without `-m`. As the sequence editor it runs a rebase todo as
 * written, so `rebase -i --autosquash` works and a hand-edited todo has
 * to be passed in, which is the only way an agent could edit one anyway.
 */
export const WITHOUT_INTERACTION: Readonly<Record<string, string>> = {
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	EDITOR: "true",
	VISUAL: "true",
	PAGER: "cat",
	GIT_PAGER: "cat",
	GH_PAGER: "cat",
	MANPAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
};

/** A spawn hook that gives the child the environment above. */
export function withoutInteraction(
	context: BashSpawnContext,
): BashSpawnContext {
	return { ...context, env: { ...context.env, ...WITHOUT_INTERACTION } };
}
