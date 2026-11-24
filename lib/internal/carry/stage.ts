/**
 * Where a carry is staged before the handover sees it, and how what is
 * staged is placed there.
 *
 * Each carry stages in its own folder beside the quest scratches, where
 * the share never reads, on the handover's volume, so a rename places a
 * file whole. What a placed file replaces waits in the folder's
 * `.before` until the carry stands, and goes back where it fails.
 *
 * A carry killed between placing its files and writing its done file
 * can't put anything back itself: the handover would keep its new files
 * and no done file, its earlier carry stranded in `.before`. So each
 * folder keeps a record of whose carry it is, which process runs it and
 * what it placed, and the next carry beside it finishes the job for any
 * whose process is gone: where the owner's done file stands, the carry
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
import { doneFileOf } from "./handover.ts";

/** The folder beside the quest scratches that carries stage in. */
const STAGING_ROOT = ".carrying";
/** What a staging folder's name starts with. */
const STAGING = "carrying-";
/** Where a staging folder keeps what placed files replaced. */
const BEFORE = ".before";
/** A staging folder's record of whose carry it is. */
const RECORD = ".carry.json";

/** A carry's staging folder, and how what is staged there is placed. */
export interface Stage {
	readonly folder: string;
	/**
	 * Renames `names` from the folder into the handover, moving `gone`
	 * and any file of those names already there aside first, kept until
	 * the carry stands. A folder at any of `names` fails it before
	 * anything moves, rather than deleting what it holds; a folder at one
	 * of `gone` is left where it is.
	 */
	place(names: readonly string[], gone?: readonly string[]): void;
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
	const tmp = stagingOf(into);
	mkdirSync(tmp, { recursive: true });
	unlinked(into);
	sweep(tmp, into);
	const folder = mkdtempSync(join(tmp, STAGING));
	const aside = join(folder, BEFORE);
	mkdirSync(aside);
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
	record();
	let keep = false;
	const stage: Stage = {
		folder,
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
				renameSync(join(into, name), join(aside, name));
				moved.push(name);
			}
			// Named only once nothing of its name is left in the handover, so
			// taking it out after a crash takes only what this carry placed.
			placed.push(...names);
			record();
			for (const name of names) {
				renameSync(join(folder, name), join(into, name));
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
			`${error instanceof Error ? error.message : String(error)}; ${[
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
		if (!keep) rmSync(folder, { recursive: true, force: true });
	}
}

/**
 * Takes each of `placed` out of `into` and puts back each file waiting
 * in `aside`, answering the names that couldn't come out (`stuck`) and
 * those that couldn't go back (`left`).
 */
function putBack(
	into: string,
	aside: string,
	placed: readonly string[],
): { stuck: string[]; left: string[] } {
	const stuck = placed.filter(
		(name) => !undo(() => rmSync(join(into, name), { force: true })),
	);
	const left = readdirSync(aside).filter(
		(name) => !undo(() => renameSync(join(aside, name), join(into, name))),
	);
	return { stuck, left };
}

/** Writes `record` whole, so a kill mid-write leaves the one before. */
function writeRecord(folder: string, record: StageRecord): void {
	const writing = join(folder, `${RECORD}.writing`);
	writeFileSync(writing, JSON.stringify(record));
	renameSync(writing, join(folder, RECORD));
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
			if (record?.into !== into || running(record)) continue;
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
 * Whether the carry `record` names may still be running: its process is
 * alive, or it ran on another machine, where this one can't tell.
 */
function running(record: StageRecord): boolean {
	if (record.machine !== hostname()) return true;
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
