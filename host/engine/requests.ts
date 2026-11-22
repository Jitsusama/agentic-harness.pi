/**
 * What an open or adopt names, read as pi would read it: the folder, the
 * file to adopt, the model, the first words and what a conversation's
 * extensions are told at its start, and the folder a conversation taken
 * up again works in. It changes when what a request may say changes,
 * not when how the engine builds a conversation does.
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LaunchHints } from "../../lib/core/session/index.ts";
import { isRecord } from "../../lib/internal/record.ts";
import type { AdoptRequest, OpenRequest } from "../service/backend.ts";
import type { AgentSession, SessionServices } from "./pi-session.ts";
import type { Model } from "./pi-types.ts";
import { printable } from "./project-code.ts";

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

/** Where a conversation taken up again works, and the folder it left. */
export interface StandingFolder {
	readonly cwd: string;
	/** Its own folder, gone, when it had to move. */
	readonly gone?: string;
}

/**
 * The folder a conversation resumed or adopted works in: its own while
 * that stands, else `moved`, an empty folder the host keeps for it,
 * made as it is needed. Never a folder above its own: that may hold
 * other trees or a checkout, which a strict sandbox would then let its
 * commands write, and project code nobody trusted for it. Only a folder
 * that is gone moves it; one that can't be read now, as a mount not yet
 * up, is refused rather than taken for gone.
 */
export function standingFolder(cwd: string, moved: string): StandingFolder {
	const own = resolve(cwd);
	if (isFolder(own)) return { cwd: realpathSync(own) };
	mkdirSync(moved, { recursive: true, mode: 0o700 });
	return { cwd: realpathSync(moved), gone: own };
}

/** The custom message a conversation whose folder went is told by. */
export const FOLDER_MOVED_TYPE = "host-folder-moved";

/** What a conversation whose folder went is told, in its own log. */
export function movedWords(gone: string, cwd: string): string {
	return `This conversation's folder, ${printable(gone)}, no longer exists, so it now works in ${printable(cwd)}, an empty folder the host keeps for it. Paths under the old folder won't be found.`;
}

/** Whether a log's entries already hold the words for this move. */
export function toldOf(
	entries: readonly unknown[],
	gone: string,
	cwd: string,
): boolean {
	return entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.type === "custom_message" &&
			entry.customType === FOLDER_MOVED_TYPE &&
			isRecord(entry.details) &&
			entry.details.gone === gone &&
			entry.details.cwd === cwd,
	);
}

/** Whether a folder stands at `path`, refusing what can't say. */
function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch (error) {
		if (
			isRecord(error) &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return false;
		const code = isRecord(error) ? String(error.code) : String(error);
		throw new Error(
			`This conversation's folder, ${printable(path)}, can't be read (${code}), so it isn't taken up`,
		);
	}
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
