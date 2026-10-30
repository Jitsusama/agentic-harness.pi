/**
 * Sessions another machine carried home before it went away, taken up
 * here so Restore can offer them.
 *
 * A machine about to leave (a sandbox at its expiry) copies each
 * session's file into its quest's scratch folder, under
 * `handover/<its hostname>/sessions/`, beside a note `<id>.json`
 * (`work`'s carry, lib/core/work/carry.ts), and mycelium's share
 * brings that folder to the other machines. This end reads those notes,
 * trusting none of them, since they come from another machine: the
 * note must name a safe id and a file beside it, and that file's own
 * header must name the same id, or the session isn't offered.
 *
 * pi finds `pi --session <id>` only in the session folder its cwd names,
 * and opens it in the folder the file's header names, asking for another
 * when that's missing, as the leaving machine's always is here. So a
 * carried session is placed as a copy under a home folder's session
 * folder with only its header's cwd rewritten, and never over a session
 * this machine already has.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CarriedSession } from "../../core/work/carry.ts";
import type { QuestTree } from "../../quest/types.ts";
import { atomicWriteFile } from "./io.ts";
import { parseQuestDoc } from "./quest-doc.ts";
import { resolveSpawnCwd } from "./reopen.ts";
import { carriedEntry, type RestoreEntry } from "./restore-file.ts";

/** A session another machine carried here, found in a handover folder. */
export interface CarriedHome {
	readonly id: string;
	readonly quest?: string;
	readonly title?: string;
	/** The machine it left, by the handover folder's name. */
	readonly from: string;
	/** When it was carried: its note's last change, as an ISO time. */
	readonly at: string;
	/** The carried copy of its file, in the handover folder. */
	readonly file: string;
}

/** What placing a carried session did. */
export type Placing =
	| { readonly kind: "placed"; readonly path: string }
	| { readonly kind: "already"; readonly path: string };

/** An id pi's command line and the launcher both take as it stands. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Enough of a session file to hold its header, which is a few hundred bytes. */
const HEADER_BYTES = 64 * 1024;

/**
 * Every session carried into any quest's handover folder under
 * `workspaces` by a machine other than `here`, each checked against its
 * file. One that fails a check is left out rather than offered.
 */
export function carriedSessions(
	workspaces: string,
	here: string,
): CarriedHome[] {
	const found: CarriedHome[] = [];
	for (const quest of folders(workspaces)) {
		const handover = join(workspaces, quest, "handover");
		for (const machine of folders(handover)) {
			if (machine === here) continue;
			const sessions = join(handover, machine, "sessions");
			for (const name of files(sessions, ".json")) {
				const carried = carriedFrom(join(sessions, name), machine);
				if (carried !== undefined) found.push(carried);
			}
		}
	}
	return found;
}

/** The session folder pi keeps for `cwd`, under the store `sessions`. */
export function sessionFolderOf(sessions: string, cwd: string): string {
	return join(
		sessions,
		`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
	);
}

/**
 * Places `carried` for `homeCwd` in the store `sessions`: a copy of its
 * file whose header names `homeCwd`, under that folder's session folder.
 * `known` is where the store already has each session; one already
 * there is left as it is.
 */
export function placeCarried(
	carried: CarriedHome,
	homeCwd: string,
	sessions: string,
	known: ReadonlyMap<string, string>,
): Placing {
	const had = known.get(carried.id);
	if (had !== undefined) return { kind: "already", path: had };
	const path = join(sessionFolderOf(sessions, homeCwd), basename(carried.file));
	if (existsSync(path)) return { kind: "already", path };
	const text = readFileSync(carried.file, "utf8");
	const end = text.indexOf("\n");
	const header = JSON.parse(end < 0 ? text : text.slice(0, end));
	const rest = end < 0 ? "\n" : text.slice(end);
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFile(
		path,
		`${JSON.stringify({ ...header, cwd: homeCwd })}${rest}`,
	);
	return { kind: "placed", path };
}

/** Where taking carried sessions up looks, and puts them. */
export interface TakingUp {
	/** Where quests' scratch folders are (questWorkspacesRoot). */
	readonly workspaces: string;
	/** This machine's hostname, whose own handover folder is skipped. */
	readonly here: string;
	/** pi's session store. */
	readonly sessions: string;
	/** Where each session in the store is now, by id. */
	readonly known: ReadonlyMap<string, string>;
	/** The quest store, whose READMEs name each quest's trees. */
	readonly quests: string;
	/** The last resort for a home folder; the user's home unless a test names one. */
	readonly home?: string;
	readonly titleOf?: (questId: string) => string | undefined;
}

/**
 * Takes up every session carried here and says what Restore offers for
 * them. Each is placed for the folder spawn would open its quest in (its
 * newest tree here, else a tree's repo, else home), and one that can't be
 * placed is left out, so it is tried again next time.
 */
export function takeUpCarried(where: TakingUp): RestoreEntry[] {
	const entries: RestoreEntry[] = [];
	for (const carried of carriedSessions(where.workspaces, where.here)) {
		const cwd = homeFolder(where, carried.quest);
		try {
			placeCarried(carried, cwd, where.sessions, where.known);
		} catch {
			// Not placed (a store that can't be written): offering it would
			// open a session pi can't find, so it waits for the next try.
			continue;
		}
		entries.push(carriedEntry(carried, cwd, where.titleOf));
	}
	return entries;
}

/** The folder a quest's session opens in here, as spawn would choose it. */
function homeFolder(where: TakingUp, quest: string | undefined): string {
	const questDir = quest === undefined ? undefined : join(where.quests, quest);
	let trees: QuestTree[] = [];
	if (questDir !== undefined) {
		try {
			trees =
				parseQuestDoc(readFileSync(join(questDir, "README.md"), "utf8"))
					?.frontMatter.trees ?? [];
		} catch {
			// No such quest here: it opens at home.
		}
	}
	return resolveSpawnCwd({
		questDir: questDir ?? where.quests,
		store: where.quests,
		...(where.home !== undefined ? { home: where.home } : {}),
		trees,
		sessions: [],
	}).cwd;
}

/** A note and its file, when both hold up. */
function carriedFrom(note: string, from: string): CarriedHome | undefined {
	const said = readJson(note);
	if (!isCarriedSession(said)) return undefined;
	const file = join(note, "..", said.file);
	if (headerId(file) !== said.id) return undefined;
	return {
		id: said.id,
		...(said.quest !== undefined ? { quest: said.quest } : {}),
		...(said.title !== undefined ? { title: said.title } : {}),
		from,
		at: statSync(note).mtime.toISOString(),
		file,
	};
}

/** Whether a note is a carried session this end can take up. */
function isCarriedSession(value: unknown): value is CarriedSession {
	if (typeof value !== "object" || value === null) return false;
	const note = value as Record<string, unknown>;
	return (
		typeof note.id === "string" &&
		SAFE_ID.test(note.id) &&
		typeof note.file === "string" &&
		note.file === basename(note.file) &&
		note.file.endsWith(".jsonl") &&
		(note.quest === undefined || typeof note.quest === "string") &&
		(note.title === undefined || typeof note.title === "string")
	);
}

/**
 * The id a session file's header names, or undefined when it names none.
 * Only its start is read: this runs every minute, and a file can be large.
 */
function headerId(file: string): string | undefined {
	let start: string;
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(HEADER_BYTES);
			start = buffer.toString(
				"utf8",
				0,
				readSync(fd, buffer, 0, HEADER_BYTES, 0),
			);
		} finally {
			closeSync(fd);
		}
	} catch {
		// No file beside the note: the session can't be taken up.
		return undefined;
	}
	const header = parsed(start.split("\n", 1)[0] ?? "");
	if (typeof header !== "object" || header === null) return undefined;
	const { type, id } = header as Record<string, unknown>;
	return type === "session" && typeof id === "string" ? id : undefined;
}

function readJson(path: string): unknown {
	try {
		return parsed(readFileSync(path, "utf8"));
	} catch {
		// A note that can't be read is a note not offered.
		return undefined;
	}
}

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Half a file, as a share mid-copy leaves: read again next time.
		return undefined;
	}
}

function folders(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// No such folder: nothing was carried there.
		return [];
	}
}

function files(path: string, ending: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(ending))
			.map((entry) => entry.name);
	} catch {
		// No such folder: nothing was carried there.
		return [];
	}
}
