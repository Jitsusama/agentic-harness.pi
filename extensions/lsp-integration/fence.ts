/**
 * The fence a conversation's language servers run in.
 *
 * A language server reads and runs the project's own code (a
 * TypeScript plugin, a build script it evaluates), so in a fenced
 * session it runs where that session's commands run: inside the same
 * sandbox, drawn around the session's own folder, from the environment
 * its commands start from, the ssh guard's stand-ins and its session's
 * id included. Where the session runs its commands as they are, so do
 * its servers.
 *
 * It is given none of what a command is given to act as the person: a
 * command gets GitHub's and the cloud's tokens, the GitHub door,
 * nix-offload's way out, the SSH agent's proxy, the clipboard, the
 * sandboxed display and the jobs broker because the agent chose to run
 * it, and a server runs code the project picked because a call asked
 * for a hover. Of the runtime folder it reaches only Nix's door for
 * sandboxes, which takes its caller as untrusted. It starts from none
 * of the conversation's variables a strict command never keeps (a
 * token, a key, a socket), whichever fence it runs in, and under the
 * strict fence it reaches none of gcloud's settings, which the
 * session's next command with the cloud's grant would read.
 *
 * Its fence is drawn once, as it starts, from the session's trees and
 * quest then, and lasts while calls keep it busy, at most the pool's
 * idle time past the last; pi's own reads and writes for it are judged
 * fresh each time.
 *
 * pi reads the files a call names and writes the ones a rename's edit
 * names in its own process, which no sandbox reaches, so those are
 * held to the check pi's own file tools are held to there.
 *
 * The server's shell runs fence-child's watcher, so a pi that dies
 * however it dies takes its servers with it, and catches the telling
 * that ends the server, so the fence's check after its command still
 * runs once the server has gone.
 */

import { homedir } from "node:os";
import type { FencedLaunch, LspFence } from "../../lib/core/lsp/index.ts";
import { WATCHER } from "../../lib/internal/fence/fence-child.ts";
import {
	neverKept,
	SANDBOX_VARIABLE,
	type Sandbox,
	wrapFor,
} from "../../lib/internal/sandbox/sandbox.ts";
import { fileToolRefusal } from "../../lib/internal/sandbox/sandbox-files.ts";
import { quoted } from "../../lib/internal/sandbox/sandbox-shell.ts";
import {
	guardedEnvironment,
	type SshGuard,
} from "../../lib/internal/shell/ssh-guard.ts";

/** The session a fence is drawn for. */
export interface FencedSession {
	readonly session: string;
	/** The session's own folder, which its commands' fence is drawn around. */
	readonly cwd: string;
	/**
	 * The environment its commands start from: the conversation's own,
	 * with what is offered to its commands and its session's id.
	 */
	readonly env: NodeJS.ProcessEnv;
	/** The ssh guard as it stands, read as a server starts. */
	readonly guard: () => Promise<SshGuard>;
}

/**
 * Caught rather than ignored, so the bash running the fence's text
 * outlives the telling that ends its server and runs what the fence
 * runs after its command, while the server, whose start resets a
 * caught signal, still ends by it.
 */
const OUTLIVES_TELLING = "trap : TERM HUP INT\n";

/** `sandbox` as a server runs in it: with nothing that acts as the person. */
export function forServers(sandbox: Sandbox): Sandbox {
	if (sandbox.kind === "strict") {
		const { github: _github, gcloud: _gcloud, ...served } = sandbox;
		return { ...served, served: true };
	}
	if (sandbox.kind === "fence") {
		const { githubDoor: _door, offload: _offload, ...served } = sandbox;
		return { ...served, served: true };
	}
	return sandbox;
}

/**
 * `env` less every variable a strict command never keeps, in either
 * case, since npm and others read lower-case names too, but for the
 * session's id, which names whose server it is.
 */
function forServer(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([name]) => name === "PI_SESSION_ID" || !neverKept(name.toUpperCase()),
		),
	);
}

/** Which fence a sandbox draws for a session, as the pool keys its servers. */
export function fenceKey(sandbox: Sandbox, session: string): string {
	return `${sandbox.kind}|${session}`;
}

/**
 * The fence for a session's servers, by the sandbox its shell runs in;
 * none when it has none, and then the session is never asked for. A
 * server is started fresh for each session, since what a fence lets
 * through depends on the session it was drawn for.
 */
export function lspFence(
	sandbox: Sandbox,
	fencing: () => FencedSession,
	home: string = homedir(),
): LspFence | undefined {
	if (sandbox.kind === "none") return undefined;
	const { session, cwd, env, guard } = fencing();
	const key = fenceKey(sandbox, session);
	if (sandbox.kind === "refused") {
		const refused = { refused: sandbox.reason };
		return {
			key,
			launch: async () => refused,
			refuses: () => sandbox.reason,
		};
	}
	return {
		key,
		async launch(words): Promise<FencedLaunch | { refused: string }> {
			const guarded = guardedEnvironment(
				forServer(env),
				await guard(),
				sandbox.kind,
			);
			const wrap = wrapFor(forServers(sandbox), { cwd, env: guarded }, home);
			if (!wrap) return { refused: "the sandbox gave no way to wrap it" };
			return {
				text: WATCHER + OUTLIVES_TELLING + wrap(words.map(quoted).join(" ")),
				env: guarded,
			};
		},
		// Judged as the sandbox the server runs in, whatever the
		// conversation's own variable reads, and as served, so the two
		// can't disagree.
		refuses: (use, path) =>
			fileToolRefusal(
				{ toolName: use, input: { path } },
				{
					cwd,
					env: { ...env, [SANDBOX_VARIABLE]: sandbox.kind },
					home,
					served: true,
				},
			),
	};
}
