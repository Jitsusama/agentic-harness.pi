/**
 * Building the engine, once per session.
 *
 * The library takes an exec and a store as dependencies, which
 * is what keeps it testable; this is where pi's own exec and
 * this package's state directory get supplied. The engine is
 * cached because a session asks it for many things, and rebuilt
 * only when the configuration it was built from changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stateDir } from "../../lib/internal/paths.js";
import {
	createDraftStore,
	createGitHubProvider,
	createGitProvider,
	createReviewEngine,
	type Exec,
	type ReviewEngine,
	registerReviewProvider,
} from "../../lib/review/index.js";
import { loadReviewConfig } from "./config.js";

/** Where drafts live. */
export function draftDir(): string {
	return join(stateDir("review"), "drafts");
}

/** Where the changes a session is attached to live. */
export function attachmentDir(): string {
	return join(stateDir("review"), "attached");
}

/** Where findings raised against a change live. */
export function findingDir(): string {
	return join(stateDir("review"), "findings");
}

/** Where the rounds asked about a change live. */
export function runDir(): string {
	return join(stateDir("review"), "runs");
}

/** Where findings queued to fix rather than say live. */
export function fixDir(): string {
	return join(stateDir("review"), "fixes");
}

/**
 * Where persona charters are read from.
 *
 * Beside the config a person edits rather than under the state
 * directory, because a persona is something somebody writes and argues
 * with, not something the tool accumulates. `REVIEW_PERSONAS_DIR`
 * wins, then `$XDG_CONFIG_HOME/pi/personas`, then
 * `~/.config/pi/personas`.
 */
export function personaDir(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const explicit = env.REVIEW_PERSONAS_DIR;
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg !== undefined && xdg.trim() !== "") {
		return join(xdg, "pi", "personas");
	}
	return join(home, ".config", "pi", "personas");
}

/** Adapt pi's exec to the library's seam. */
function execFor(pi: ExtensionAPI): Exec {
	return async (command, args) => {
		const result = await pi.exec(command, args);
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	};
}

/** What the session holds. */
interface Session {
	engine: ReviewEngine;
	problems: string[];
}

let session: Session | undefined;

/**
 * Register the providers this package ships. Idempotent, since
 * the registry survives module reimport but not a reload.
 */
export function registerBuiltinReviewProviders(pi: ExtensionAPI): void {
	const exec = execFor(pi);
	registerReviewProvider(createGitHubProvider({ exec }));
	registerReviewProvider(createGitProvider({ exec }));
}

/** The session's engine, built on first use. */
export async function reviewEngine(pi: ExtensionAPI): Promise<Session> {
	if (session) return session;
	const { config, problems } = await loadReviewConfig();
	session = {
		engine: createReviewEngine({
			exec: execFor(pi),
			store: createDraftStore(draftDir()),
			...(Object.keys(config).length > 0 ? { config } : {}),
		}),
		problems,
	};
	return session;
}

/** Drop the cached engine, so the next call rereads config. */
export function forgetReviewEngine(): void {
	session = undefined;
}
