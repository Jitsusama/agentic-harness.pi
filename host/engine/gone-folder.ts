/**
 * Where a conversation opens when the folder its log names is gone, as a
 * tree released once its change merged is: the nearest folder above it
 * that still stands, or the home folder, rather than pi refusing the
 * whole conversation at its start (pi's MissingSessionCwdError).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SessionManager, SessionManagerStatics } from "./pi-session.ts";

/** The custom message that tells a conversation its folder moved. */
export const FOLDER_GONE_TYPE = "host-folder-gone";

/** A conversation's log, opened in a folder that stands. */
export interface StandingOpen {
	readonly manager: SessionManager;
	/** The folder its log names, gone when it opened; absent when it stands. */
	readonly left?: string;
}

/**
 * Open the log at `file` as pi does, and again in the folder that
 * stands nearest the one it names when that one is gone.
 */
export function openStanding(
	sessions: Pick<SessionManagerStatics, "open">,
	file: string,
	home: string = homedir(),
): StandingOpen {
	const manager = sessions.open(file);
	const left = manager.getCwd();
	if (!left || existsSync(left)) return { manager };
	const now = standingFolder(left, home);
	return { manager: sessions.open(file, undefined, now), left };
}

/**
 * The nearest folder above `gone` that still exists, or `home` when only
 * the root does: a conversation never opens at the root unasked.
 */
export function standingFolder(gone: string, home: string): string {
	for (let at = dirname(gone); at !== dirname(at); at = dirname(at))
		if (existsSync(at)) return at;
	return home;
}

/** What a conversation is told when it opens somewhere other than its log says. */
export function folderGoneLine(left: string, now: string): string {
	return `The folder this conversation was in, ${left}, is gone, so it opened in ${now} instead. Commands run there now, and a path under the old folder no longer exists.`;
}

/**
 * Whether the newest folder-gone message in `entries` already tells of
 * this same move, so a conversation reopened across restarts is told once.
 */
export function toldOfMove(
	entries: readonly object[],
	left: string,
	now: string,
): boolean {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (Reflect.get(entry ?? {}, "customType") !== FOLDER_GONE_TYPE) continue;
		const details: unknown = Reflect.get(entry ?? {}, "details");
		if (typeof details !== "object" || details === null) return false;
		return (
			Reflect.get(details, "left") === left &&
			Reflect.get(details, "now") === now
		);
	}
	return false;
}
