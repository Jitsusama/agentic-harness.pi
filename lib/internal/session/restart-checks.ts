/**
 * Why a session couldn't start again into itself from its log: asked by
 * a park before it parks, and by a pi that quit unasked before it names
 * its restart, so both refuse the same cases.
 */

import { existsSync } from "node:fs";
import { flagsLost, opensOnlyItself } from "./park.ts";

/**
 * Why its holder couldn't wake this session into itself, whatever its
 * log: fixed by how it was started, so a check reads it mid-run, and
 * writing nothing, so its holder is told nothing.
 */
export function restartRefused(
	again: string,
	args: readonly string[],
	session: string,
	sessionFile: string,
): string | undefined {
	if (again === "") {
		return opensOnlyItself(args, session, sessionFile)
			? undefined
			: "its holder would start it as a new session";
	}
	const lost = flagsLost(args);
	return lost.length > 0
		? `starting again would drop ${lost.join(", ")}`
		: undefined;
}

/**
 * Why a session can't start again from its log, if it can't: pi writes a
 * log at its first answer, so one never asked anything would wake as a
 * new session, under another address.
 */
export function logWritten(sessionFile: string): string | undefined {
	if (sessionFile === "") return "it has no log to start again from";
	if (!existsSync(sessionFile)) return "its log isn't written yet";
	return undefined;
}
