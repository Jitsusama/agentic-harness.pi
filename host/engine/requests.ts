/**
 * What an open or adopt names, read as pi would read it: the folder, the
 * file to adopt, the model, the first words and what a conversation's
 * extensions are told at its start. It changes when what a request may
 * say changes, not when how the engine builds a conversation does.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LaunchHints } from "../../lib/core/session/index.ts";
import type { AdoptRequest, OpenRequest } from "../service/backend.ts";
import type { AgentSession, SessionServices } from "./pi-session.ts";
import type { Model } from "./pi-types.ts";

/** Whether the words open with a command an extension registered, named as pi's prompt parses it. */
export function namesCommand(session: AgentSession, words: string): boolean {
	if (!words.startsWith("/")) return false;
	const space = words.indexOf(" ");
	const name = space === -1 ? words.slice(1) : words.slice(1, space);
	return session.extensionRunner.getCommand(name) !== undefined;
}

/** The model an open names, refused when no provider of the conversation's has it. */
export function requireModel(
	services: SessionServices,
	wanted: { readonly provider: string; readonly id: string },
): Model {
	const model = services.modelRuntime.getModel(wanted.provider, wanted.id);
	if (!model)
		throw new Error(
			`No model ${wanted.provider}/${wanted.id} for this conversation`,
		);
	return model;
}

/** The folder an open names, as pi started there would know it, refused unless it is there. */
export function folder(cwd: string): string {
	if (!isAbsolute(cwd))
		throw new Error(`A conversation's folder must be absolute: ${cwd}`);
	if (!existsSync(cwd)) throw new Error(`No such folder: ${cwd}`);
	// pi started there would work in the folder its process.cwd() names, which is the folder's own path, past any symlink.
	return realpathSync(cwd);
}

/** The session file an adopt names, refused unless it is there. */
export function adoptable(sessionFile: string): string {
	if (!isAbsolute(sessionFile))
		throw new Error(`A session file to adopt must be absolute: ${sessionFile}`);
	if (!existsSync(sessionFile))
		throw new Error(`No session file to adopt: ${sessionFile}`);
	return resolve(sessionFile);
}

/** What a conversation's extensions are told once, at its start. */
export function hintsFor(
	request: OpenRequest | AdoptRequest | undefined,
): LaunchHints {
	if (!request) return {};
	return {
		...(request.quest ? { questId: request.quest } : {}),
		...(request.op === "open" && request.first !== undefined
			? { firstWords: request.first }
			: {}),
		...(request.op === "open" && request.orchestrate === true
			? { orchestrate: true }
			: {}),
	};
}
