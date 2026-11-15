/**
 * Carrying a host's untrusted folder out to the plain pi that takes a
 * conversation up.
 *
 * A host with nobody there to ask leaves a folder no one trusted
 * untrusted (host/engine/project-trust.ts). Plain pi asks instead, and
 * a conversation released to it sat at "Trust project folder?" with
 * nothing written: 2FC18ED8 and QQ1UAK for 11 minutes after the 15
 * November drill, and 2FC18ED8 again when its parked hold woke. Every
 * plain pi that takes the session up asks: the launcher's reopen, a
 * wake, a viewer's carry-on.
 *
 * So a hosted conversation that leaves for plain pi untrusted leaves a
 * word here, one file a session, and a pi started on that session in
 * that folder answers pi's `project_trust` no for itself alone, as the
 * host did, saving nothing in pi's trust store: a "no" saved there would
 * untrust every later session in the folder too. Once a decision is
 * saved, as `/trust` saves one, the word gives way and is forgotten.
 */

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startedSession } from "../fence-stage.ts";
import { stateDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { writeWhole } from "../write-whole.ts";

/** What a pi answers for a folder's trust: no, or leave it to pi. */
export type CarriedAnswer = "no" | "undecided";

/** What deciding reads, so tests can say it. */
export interface CarriedTrustFacts {
	/** The command line the pi was started with. */
	readonly argv?: readonly string[];
	/** The closest decision pi's trust store saved, or null for none. */
	readonly saved: (cwd: string) => boolean | null;
	/** Where the words are kept. */
	readonly folder?: string;
}

/** Where the words are kept: the package's state, as the move notes. */
function carriedFolder(): string {
	return stateDir("carried-trust");
}

function wordFile(folder: string, session: string): string {
	const name = session.toLowerCase().replace(/[^a-z0-9-]/g, "_");
	return join(folder, `${name}.json`);
}

/** The folder a session's word names, if it left one. */
function untrustedFolder(folder: string, session: string): string | undefined {
	try {
		const value: unknown = JSON.parse(
			readFileSync(wordFile(folder, session), "utf8"),
		);
		return isRecord(value) && typeof value.cwd === "string"
			? value.cwd
			: undefined;
	} catch {
		// No word, or one half written: nothing carried.
		return undefined;
	}
}

/** Leave word that `session` left its host with `cwd` untrusted. */
export function leaveUntrusted(
	session: string,
	cwd: string,
	folder: string = carriedFolder(),
): void {
	writeWhole(
		wordFile(folder, session),
		`${JSON.stringify({ session, cwd: resolve(cwd) })}\n`,
	);
}

/** Forget any word `session` left, as when it leaves its host trusted. */
export function forgetUntrusted(
	session: string,
	folder: string = carriedFolder(),
): void {
	rmSync(wordFile(folder, session), { force: true });
}

/**
 * How a pi started in `cwd` answers its folder's trust: no when its
 * command line opens a session that left its host with this folder
 * untrusted and nothing has been decided since, and else undecided,
 * leaving it to pi and the other extensions. Only the command line
 * names the session, so a host, which serves many, answers undecided.
 */
export function carriedTrust(
	cwd: string,
	facts: CarriedTrustFacts,
): CarriedAnswer {
	const folder = facts.folder ?? carriedFolder();
	const session = startedSession({}, facts.argv ?? process.argv);
	if (session === undefined) return "undecided";
	if (untrustedFolder(folder, session) !== resolve(cwd)) return "undecided";
	if (facts.saved(cwd) !== null) {
		forgetUntrusted(session, folder);
		return "undecided";
	}
	return "no";
}
