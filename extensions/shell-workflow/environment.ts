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
 * release half-rolled. The editor and pager are set for the child alone,
 * so pi's own editor and the person's shell are left as they were, and a
 * variable the command sets itself still wins. The askpass program is
 * dropped from pi's own process too, since pi starts git and ssh of its
 * own, outside any shell.
 */

import { delimiter } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import {
	hosted,
	type SessionRef,
	sessionEnv,
} from "../../lib/core/session/index.ts";
import { offeredShellEnvironment } from "../../lib/internal/shell/environment.ts";

/**
 * A spawn hook that starts the command from its conversation's own
 * environment on a host, where pi starts it from the host process's.
 *
 * pi copies `process.env`, puts its bin folder at the front of `PATH`,
 * and sets `PI_SESSION_ID` and its kin from the conversation calling.
 * On a host, the process's environment is nobody's, so what pi changed
 * of it is laid over the conversation's instead, read when the command
 * spawns, after every `tool_call` hook: a variable pi dropped stays
 * dropped, the conversation's `PATH` keeps pi's folder in front, and
 * the `PI_SESSION_*` it sets come from the calling conversation. On
 * plain pi the process's environment is the conversation's, so the
 * context is left as pi made it.
 */
export function fromConversation(
	context: BashSpawnContext,
	session?: SessionRef,
	processEnv: NodeJS.ProcessEnv = process.env,
): BashSpawnContext {
	if (!hosted()) return context;
	const env: NodeJS.ProcessEnv = sessionEnv(session).snapshot();
	const keys = new Set([
		...Object.keys(processEnv),
		...Object.keys(context.env),
	]);
	for (const key of keys) {
		const was = processEnv[key];
		const made = context.env[key];
		if (made === was) continue;
		if (made === undefined) delete env[key];
		else if (key.toLowerCase() === "path")
			env[key] = ledBy(made, was, env[key]);
		else env[key] = made;
	}
	return { ...context, env };
}

/**
 * The conversation's `PATH` with what pi put in front of the process's
 * `was` to make `made`. A conversation with none takes pi's; one pi
 * changed some other way keeps its own, since the host's is nobody's.
 */
function ledBy(
	made: string,
	was: string | undefined,
	own: string | undefined,
): string {
	if (!own) return made;
	const front = !was
		? made
		: made.endsWith(`${delimiter}${was}`)
			? made.slice(0, made.length - was.length - delimiter.length)
			: undefined;
	if (front === undefined) return own;
	const ownParts = own.split(delimiter);
	const missing = front
		.split(delimiter)
		.filter((part) => part && !ownParts.includes(part));
	return [...missing, own].filter(Boolean).join(delimiter);
}

/**
 * The variables through which git and ssh hand a question to an askpass
 * program, set so that neither does.
 */
const NO_ASKPASS: Readonly<Record<string, string>> = {
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	SSH_ASKPASS_REQUIRE: "never",
};

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
	...NO_ASKPASS,
};

/**
 * Keep pi's own process from asking on the person's screen, and so
 * everything it starts outside the agent's shell: the work tool's git
 * and a council's checkout.
 *
 * A host runs as a user service, so it inherits the user manager's
 * `SSH_ASKPASS` and `DISPLAY`, and an ssh it starts with no terminal
 * opens a window on the person's screen for a host key or passphrase.
 * About 22 such windows reached the person on 21 November in six
 * minutes. Nobody answers an askpass window but the person, and no
 * agent's work is worth that, so the process drops the program for good
 * as it loads. In a host, `process.env` is the loading conversation's
 * view (`host/engine/process-env.ts`), so this blanks that
 * conversation's environment, which its tools and commands start from,
 * and leaves the host's own to the host.
 * What pi starts for the person inherits it too: a `!` command or a
 * terminal pi opens asks on its own terminal where it has one, and
 * fails where it has none, rather than opening a window. Terminals the person opens
 * take theirs from the compositor's session, which this leaves alone.
 */
export function askNothingOnScreen(): void {
	Object.assign(process.env, NO_ASKPASS);
}

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
