/**
 * Where a carry is staged before the handover sees it, and how what is
 * staged is placed there.
 *
 * Each carry stages in its own folder beside the quest scratches, where
 * the share never reads, and each file is placed whole: by rename, or,
 * where the quest's scratch is a btrfs subvolume of its own, which a
 * rename can't cross, by a copy renamed in beside it (`moveFile`). What
 * a placed file replaces waits in the folder's `.before` until the carry
 * stands, and goes back where it fails.
 *
 * A carry killed between placing its files and writing its done file
 * can't put anything back itself: the handover would keep its new files
 * and no done file, its earlier carry stranded in `.before`. So each
 * folder keeps a record of whose carry it is, which process runs it and
 * what it placed, and the next carry beside it finishes the job for any
 * whose process is gone, or, in this process, whose carry has returned:
 * where the owner's done file stands, the carry
 * did too, and its folder goes; where none does, what it placed comes
 * out and what it replaced goes back.
 *
 * The quest's own scratch is bound writable in the fence, so a record
 * there would be only a claim, and a folder there could be swapped for
 * a link between a check and a rename. Staging lies outside it instead,
 * under the scratches' own folder, which the fence binds read-only, so
 * nothing a fenced command plants is read. The handover itself it can
 * write, so a carry refuses one that is a link or lies under one, before
 * sweeping and again before placing.
 */

import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { moveFile } from "../files/move-file.ts";
import { processGlobal } from "../process/process-global.ts";
import { CARRY_STAGING } from "../sandbox/quest-folders.ts";
import { doneFileOf } from "./handover.ts";
import { messageOf } from "./message.ts";

/** The folder beside the quest scratches that carries stage in. */
const STAGING_ROOT = CARRY_STAGING;
/** What a staging folder's name starts with. */
const STAGING = "carrying-";
/** Where a staging folder keeps what placed files replaced. */
const BEFORE = ".before";
/** A staging folder's record of whose carry it is. */
const RECORD = ".carry.json";

/**
 * The staging folders whose carry this process runs now. One of its own
 * not among them was kept by a carry that failed and has returned, so
 * the next carry sweeps it before placing anything: left until this
 * process ended, it would put back what came before a later carry's
 * files, over them.
 *
 * It is the process's, not this module's: pi's loader gives each
 * extension its own copy of this file, and a reload another, and a copy
 * with a set of its own would take another's running carry as returned
 * and undo it.
 */
const live = processGlobal("pi.carry.staging.live", () => new Set<string>());

/** A carry's staging folder, and how what is staged there is placed. */
export interface Stage {
	readonly folder: string;
	/**
	 * Moves `names` from the folder into the handover, moving `gone`
	 * and any file of those names already there aside first, kept until
	 * the carry stands. A folder at any of `names` fails it before
	 * anything moves, rather than deleting what it holds; a folder at one
	 * of `gone` is left where it is.
	 */
	place(names: readonly string[], gone?: readonly string[]): void;
	/**
	 * Has `write` write one file in the staging folder it is given and
	 * answer its path, then places that file as `place` places it,
	 * answering its path in the handover; throws, placing nothing, where
	 * the path answered isn't directly in the staging folder. Nothing
	 * here makes it the last file placed: a carry asks it last, for its
	 * done file, which is so written in the staging folder, never in the
	 * handover itself, which a fenced command may have swapped.
	 */
	placeLast(write: (folder: string) => string): string;
}

/** A staging folder's record. */
interface StageRecord {
	/** The handover the carry places into. */
	readonly into: string;
	/** The session or quest whose done file the carry writes. */
	readonly owner: string;
	readonly machine: string;
	readonly pid: number;
	/** What it placed in the handover, each named before it lands. */
	readonly placed: readonly string[];
	/**
	 * Whether it failed and put back only part of its carry: what it
	 * replaced goes back whatever done file stands, since one put back
	 * is the earlier carry's.
	 */
	readonly failed?: boolean;
}

/**
 * Where carries into the handover `into` stage: a folder for its quest
 * beside the quest scratches, outside the one the fence lets it write.
 */
export function stagingOf(into: string): string {
	const scratch = dirname(dirname(into));
	return join(dirname(scratch), STAGING_ROOT, basename(scratch));
}

/**
 * What `work` answers, given a staging folder beside the handover
 * `into` for `owner`'s carry. Where `work` throws, the files it placed
 * are taken out of `into` and what they replaced put back; either way
 * the staging folder goes, unless something couldn't go back, which
 * waits there for the next carry beside it once this process is gone.
 */
export async function staged<T>(
	into: string,
	owner: string,
	work: (stage: Stage) => Promise<T>,
): Promise<T> {
	const tmp = stagingMade(into);
	unlinked(into);
	sweep(tmp, into);
	const folder = mkdtempSync(join(tmp, STAGING));
	const aside = join(folder, BEFORE);
	const placed: string[] = [];
	const moved: string[] = [];
	const record = (failed = false): void =>
		writeRecord(folder, {
			into,
			owner,
			machine: hostname(),
			pid: process.pid,
			placed,
			...(failed ? { failed } : {}),
		});
	live.add(folder);
	try {
		mkdirSync(aside);
		record();
	} catch (error) {
		// Nothing is placed yet, so the folder holds nothing to keep.
		live.delete(folder);
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
	let keep = false;
	const stage: Stage = {
		folder,
		placeLast(write) {
			// Last only as the carry asks it last; placed as any other.
			const file = write(folder);
			if (dirname(file) !== folder) {
				throw new Error(`${file} isn't in the staging folder ${folder}.`);
			}
			stage.place([basename(file)]);
			return join(into, basename(file));
		},
		place(names, gone = []) {
			unlinked(into);
			const held = names.find((name) => isFolder(join(into, name)));
			if (held !== undefined) {
				throw new Error(
					`A folder stands at ${join(into, held)}, so the carry isn't placed over it.`,
				);
			}
			for (const name of [...gone, ...names]) {
				if (moved.includes(name) || !besideFolder(join(into, name))) continue;
				movedThrough(into, join(into, name), join(aside, name));
				moved.push(name);
			}
			// Named only once nothing of its name is left in the handover, so
			// taking it out after a crash takes only what this carry placed.
			placed.push(...names);
			record();
			for (const name of names) {
				movedThrough(into, join(folder, name), join(into, name));
			}
		},
	};
	try {
		return await work(stage);
	} catch (error) {
		const back = putBack(into, aside, placed);
		if (back.stuck.length === 0 && back.left.length === 0) throw error;
		keep = true;
		// Only what is still in the handover is this carry's to take out.
		placed.splice(0, placed.length, ...back.stuck);
		undo(() => record(true));
		throw new Error(
			`${messageOf(error)}; ${[
				back.stuck.length === 0
					? ""
					: `${back.stuck.join(", ")} couldn't be taken out of ${into}`,
				back.left.length === 0
					? ""
					: `${back.left.join(", ")} couldn't be put back, and wait in ${aside}`,
			]
				.filter((said) => said !== "")
				.join("; ")}`,
			{ cause: error },
		);
	} finally {
		live.delete(folder);
		if (!keep) rmSync(folder, { recursive: true, force: true });
	}
}

/**
 * Takes each of `placed` out of `into` and puts back each file waiting
 * in `aside`, answering the names that couldn't come out (`stuck`) and
 * those that couldn't go back (`left`). A handover swapped for a link
 * since it was placed into takes nothing out and has nothing put back,
 * so both wait for a later carry.
 */
function putBack(
	into: string,
	aside: string,
	placed: readonly string[],
): { stuck: string[]; left: string[] } {
	if (!undo(() => unlinked(into))) {
		return { stuck: [...placed], left: readdirSync(aside) };
	}
	const stuck = placed.filter(
		(name) => !undo(() => rmSync(join(into, name), { force: true })),
	);
	const left = readdirSync(aside).filter((name) =>
		// A copy cut off on its way aside is no earlier file, so it goes.
		name.startsWith(".")
			? !undo(() => rmSync(join(aside, name), { force: true }))
			: !undo(() => movedThrough(into, join(aside, name), join(into, name))),
	);
	return { stuck, left };
}

/**
 * Moves `from` to `to`, one of them in the handover `into`, once `into`
 * is still no link: asked before each move, not once for all, since a
 * move across volumes copies for as long as its file is long, and a
 * fenced command may swap the handover meanwhile, which would have the
 * next move read or write through it.
 */
function movedThrough(into: string, from: string, to: string): void {
	unlinked(into);
	moveFile(from, to);
}

/**
 * Makes the staging folder for carries into `into`, and the folder of
 * staging folders above it, one at a time, answering its path; throws
 * where either is a link. Where the scratches' folder was made only
 * now, a fenced command could have made the folder of staging folders
 * first, as a link to one it may write.
 */
function stagingMade(into: string): string {
	const tmp = stagingOf(into);
	const root = dirname(tmp);
	mkdirSync(dirname(root), { recursive: true });
	for (const path of [root, tmp]) {
		if (!exists(path)) mkdirSync(path);
		if (!isFolder(path)) {
			throw new Error(
				`${path} is a link or no folder, so no carry is staged through it.`,
			);
		}
	}
	return tmp;
}

/** Writes `record` whole, so a kill mid-write leaves the one before. */
function writeRecord(folder: string, record: StageRecord): void {
	const writing = join(folder, `${RECORD}.writing`);
	writeFileSync(writing, JSON.stringify(record));
	renameSync(writing, join(folder, RECORD));
}

/**
 * Makes the handover `into`, and each folder between it and its quest's
 * scratch, one at a time, refusing any that is a link before it makes
 * anything below it, so no folder is made wherever a link leads.
 */
export function handoverMade(into: string): void {
	const scratch = dirname(dirname(into));
	mkdirSync(scratch, { recursive: true });
	unlinked(into);
	const steps = relative(scratch, into).split(sep);
	for (let at = 1; at <= steps.length; at++) {
		const path = join(scratch, ...steps.slice(0, at));
		// One made as a link since the check fails here, as it exists.
		if (!exists(path)) mkdirSync(path);
	}
	unlinked(into);
}

/**
 * Throws unless the handover `into`, and each folder between it and its
 * quest's scratch, is a folder rather than a link: a fenced command can
 * swap one for a link, through which a carry would place, take out and
 * put back files wherever it led. Where one isn't there yet, nothing
 * below it is either.
 */
function unlinked(into: string): void {
	const scratch = dirname(dirname(into));
	const steps = relative(scratch, into).split(sep);
	for (let at = 0; at <= steps.length; at++) {
		const path = join(scratch, ...steps.slice(0, at));
		if (!exists(path)) return;
		if (isFolder(path)) continue;
		throw new Error(
			`${path} is a link or no folder, so the carry isn't placed through it.`,
		);
	}
}

/**
 * Finishes each carry staged in `tmp` for the handover `into` whose
 * process is gone from this machine. One whose record can't be read, or
 * names another handover or a name that isn't plain, is left, since
 * nothing says where its files go; so is anything that fails, for a
 * later carry.
 */
function sweep(tmp: string, into: string): void {
	for (const name of readdirSync(tmp)) {
		if (!name.startsWith(STAGING)) continue;
		try {
			const found = join(tmp, name);
			if (!isFolder(found) || !isFolder(join(found, BEFORE))) continue;
			const record = readRecord(found);
			if (record?.into !== into || running(record, found)) continue;
			// Claimed by a rename, which only one carry wins, then marked as
			// this process's, so no other sweeps it while this one does.
			const folder = join(tmp, `${STAGING}swept-${randomUUID()}`);
			renameSync(found, folder);
			writeRecord(folder, {
				...record,
				machine: hostname(),
				pid: process.pid,
			});
			// Its done file standing means it stood, unless it failed and put
			// that back itself: what waits aside is old.
			if (record.failed || !isFile(doneFileOf(into, record.owner))) {
				const back = putBack(into, join(folder, BEFORE), record.placed);
				if (back.stuck.length > 0 || back.left.length > 0) {
					writeRecord(folder, {
						...record,
						machine: hostname(),
						pid: process.pid,
						placed: back.stuck,
						failed: true,
					});
					continue;
				}
			}
			rmSync(folder, { recursive: true, force: true });
		} catch {
			// What fails here waits for the next carry; this one goes on.
		}
	}
}

/** A staging folder's record, if it holds one in shape. */
function readRecord(folder: string): StageRecord | undefined {
	try {
		const read: unknown = JSON.parse(
			readFileSync(join(folder, RECORD), "utf8"),
		);
		if (typeof read !== "object" || read === null) return undefined;
		const { into, owner, machine, pid, placed, failed } =
			read as Partial<StageRecord>;
		if (
			(failed !== undefined && typeof failed !== "boolean") ||
			typeof into !== "string" ||
			!plain(owner) ||
			typeof machine !== "string" ||
			typeof pid !== "number" ||
			!Array.isArray(placed) ||
			!placed.every(plain)
		) {
			return undefined;
		}
		return { into, owner, machine, pid, placed, failed };
	} catch {
		return undefined;
	}
}

/**
 * Whether the carry `record` in `folder` names may still be running: its
 * process is alive, or it ran on another machine, where this one can't
 * tell. One of this process's own runs only while its carry does.
 */
function running(record: StageRecord, folder: string): boolean {
	if (record.machine !== hostname()) return true;
	if (record.pid === process.pid) return live.has(folder);
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (error) {
		// EPERM is a live process another user owns.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Whether `name` names one entry of the folder it is joined to. */
function plain(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name !== "" &&
		name !== "." &&
		name !== ".." &&
		!name.includes("/") &&
		!name.includes("\0")
	);
}

/** Whether a folder, not a link to one, is at `path`. */
function isFolder(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Whether something other than a folder is at `path`, not following a link. */
function besideFolder(path: string): boolean {
	try {
		return !lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Whether anything, a link included, is at `path`. */
function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Whether `path` is a file, not following a link. */
function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** Whether `step` ran without throwing. */
function undo(step: () => void): boolean {
	try {
		step();
		return true;
	} catch {
		// The caller names what didn't go back.
		return false;
	}
}
