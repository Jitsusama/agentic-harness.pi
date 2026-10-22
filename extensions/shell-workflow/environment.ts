/**
 * The agent's shell has nobody at the keyboard.
 *
 * pi already closes stdin and starts the shell without a terminal, so a
 * plain prompt fails rather than waits. An editor is different: git
 * launches one for a rebase todo or a commit message, and it sits there
 * until somebody aborts the command. A pager is the same in kind, though
 * it only starts when output is a terminal. A credential prompt is a
 * third: with no terminal, git and ssh hand it to an askpass program,
 * which opens a window on the person's screen and holds the command
 * until somebody answers. One sat for 46 minutes overnight, holding a
 * release half-rolled. These variables are set for the child alone, so
 * pi's own editor and the person's shell are left as they were, and a
 * variable the command sets itself still wins.
 */

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { offeredShellEnvironment } from "../../lib/internal/shell/environment.ts";

/**
 * What the agent's commands run with.
 *
 * `true` as the editor keeps the message git already has (a merge, a
 * revert, `rebase --continue`) and fails fast where it has none, such as
 * a commit without `-m`. As the sequence editor it runs a rebase todo as
 * written, so `rebase -i --autosquash` works and a hand-edited todo has
 * to be passed in, which is the only way an agent could edit one anyway.
 *
 * An empty `GIT_ASKPASS` ends git's search for a prompt program there,
 * before `core.askpass` and `SSH_ASKPASS`, and `GIT_TERMINAL_PROMPT`
 * stops the terminal prompt after it, so a missing credential fails at
 * once. Credential helpers run before either, so a signed-in host is
 * unaffected. `SSH_ASKPASS_REQUIRE=never` does the same for ssh's own
 * passphrase and host key questions. A signing agent that asks for a
 * PIN asks from its own process, which none of this reaches.
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
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	SSH_ASKPASS_REQUIRE: "never",
};

/**
 * A spawn hook that gives the child the environment above, after what
 * other extensions offer for it, such as the loaded quest's scratch.
 * Nothing offered can turn a prompt back on.
 */
export function withoutInteraction(
	context: BashSpawnContext,
): BashSpawnContext {
	return {
		...context,
		env: {
			...context.env,
			...offeredShellEnvironment(),
			...WITHOUT_INTERACTION,
		},
	};
}
