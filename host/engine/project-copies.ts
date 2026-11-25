/**
 * The copies of a folder's .pi the host loads in its place: the exact
 * bytes the host checked against its pins, written into the host's agent
 * folder, which no fenced command can write. pi reads a project's
 * settings, extensions, packages, system prompt and MCP servers from
 * the copy, so code a session writes into the tree's .pi after the
 * check never loads unchecked.
 *
 * A copy is named by the digest of all it holds and written whole before
 * it is renamed into place, so a reader never meets half of one, and the
 * same bytes reuse the copy already there, unless its settings no longer
 * read as copied: pi writes a project's settings where it reads them.
 * Each use marks the copy. A folder keeps its newest few copies, each
 * for a week after its last use, never the one just used; every folder's
 * copies are looked over now and then, so a tree never opened again
 * leaves none behind. A copy is moved aside before it is removed, so a
 * load meeting it finds it whole or not at all.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CopiedFile } from "./project-code.ts";

/** The folder under the agent folder that holds every copy. */
export const COPIES_FOLDER = "project-copies";

/** How long a copy may go unused before it is removed. */
export const UNUSED_FOR = 7 * 24 * 60 * 60 * 1000;

/** How many copies one folder keeps, newest first, so reloads that change its words can't fill the disk. */
export const MOST_COPIES = 8;

/** How long a half-written or half-removed copy may lie before it counts as left by a load that stopped. */
const LEFT_FOR = 60 * 60 * 1000;

/** How often the host looks over every folder's copies, not only the one loading. */
const LOOK_OVER_EVERY = 60 * 60 * 1000;

/** How much of a digest names a folder or a copy: enough that two never meet. */
const NAME_LENGTH = 32;

/** The mode a copy's folders get, so only the host's user can change them. */
const FOLDER_MODE = 0o700;

/** The bits a copied file keeps: its owner may always read and write it, as the host must. */
const OWNER_READS_AND_WRITES = 0o600;

/** The settings file within a copy, which pi may write. */
const SETTINGS = "settings.json";

/** What a name ends in while it is being written or removed. */
const PASSING = /\.(staged|removing)$/;

/** When each agent folder's copies were last looked over by this process. */
const lookedOver = new Map<string, number>();

/**
 * The copy of `files`, as read from `cwd`'s .pi, under `agentDir`: its
 * path, or why it couldn't be written.
 */
export function copyProject(
	agentDir: string,
	cwd: string,
	files: readonly CopiedFile[],
	now: () => number = Date.now,
): { readonly dir: string } | { readonly failed: string } {
	const copies = join(agentDir, COPIES_FOLDER);
	const folder = join(copies, digestOf(cwd));
	const dir = join(folder, contentsDigest(files));
	try {
		const wrote = ensure(dir, files, now);
		if (wrote) prune(folder, dir, now);
		if (now() - (lookedOver.get(copies) ?? 0) >= LOOK_OVER_EVERY) {
			lookedOver.set(copies, now());
			lookOver(copies, dir, now);
		}
		return { dir };
	} catch (error) {
		// A full disk or an agent folder the host can't write.
		return { failed: `the host couldn't write its copy (${codeOf(error)})` };
	}
}

/**
 * Make `dir` hold `files` and mark it used: whether it had to be
 * written. One whose settings pi changed is written again, and one
 * another host removed as this one marked it is written again too.
 */
function ensure(
	dir: string,
	files: readonly CopiedFile[],
	now: () => number,
): boolean {
	let wrote = false;
	if (exists(dir) && !settingsAsCopied(dir, files)) remove(dir);
	if (!exists(dir)) {
		write(dir, files);
		wrote = true;
	}
	const time = now() / 1000;
	try {
		utimesSync(dir, time, time);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
		write(dir, files);
		utimesSync(dir, time, time);
		wrote = true;
	}
	return wrote;
}

/** Whether the settings in `dir` are still those `files` hold, or both have none. */
function settingsAsCopied(dir: string, files: readonly CopiedFile[]): boolean {
	const copied = files.find((file) => file.place === SETTINGS)?.text;
	let now: Buffer | undefined;
	try {
		now = readFileSync(join(dir, SETTINGS));
	} catch {
		// None there: as copied only when none was copied.
		now = undefined;
	}
	return copied === undefined
		? now === undefined
		: now?.equals(copied) === true;
}

/** Write `files` beside `dir` and rename them into place, keeping a copy someone else wrote first. */
function write(dir: string, files: readonly CopiedFile[]): void {
	const staged = `${dir}.${process.pid}.${randomBytes(4).toString("hex")}.staged`;
	try {
		mkdirSync(staged, { recursive: true, mode: FOLDER_MODE });
		for (const file of files) {
			const path = join(staged, file.place);
			mkdirSync(dirname(path), { recursive: true, mode: FOLDER_MODE });
			writeFileSync(path, file.text);
			chmodSync(path, file.mode | OWNER_READS_AND_WRITES);
		}
		renameSync(staged, dir);
	} catch (error) {
		rmSync(staged, { recursive: true, force: true });
		// Another load wrote the same bytes first: its copy is as good.
		if (!exists(dir)) throw error;
	}
}

/**
 * Remove from `folder` what a copy no longer needs, but for `keep`:
 * copies past the newest few or unused for a week, and what a load that
 * stopped left half written or half removed.
 */
function prune(folder: string, keep: string, now: () => number): void {
	const found: { path: string; used: number }[] = [];
	let places = MOST_COPIES;
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		const used = usedAt(path);
		if (used === undefined) continue;
		if (path === keep) {
			places -= 1;
			continue;
		}
		if (PASSING.test(name)) {
			if (now() - used > LEFT_FOR)
				rmSync(path, { recursive: true, force: true });
		} else found.push({ path, used });
	}
	found.sort((a, b) => b.used - a.used);
	found.forEach(({ path, used }, rank) => {
		if (rank >= places || now() - used > UNUSED_FOR) remove(path);
	});
}

/** Prune every folder's copies under `copies`, removing a folder left with none. */
function lookOver(copies: string, keep: string, now: () => number): void {
	for (const name of readdirSync(copies)) {
		const folder = join(copies, name);
		try {
			prune(folder, keep, now);
			rmdirSync(folder);
		} catch {
			// A folder still holding copies, or one another load is using: left as it is.
		}
	}
}

/** Move `path` aside, then remove it, so nobody meets it half removed. */
function remove(path: string): void {
	const aside = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.removing`;
	try {
		renameSync(path, aside);
	} catch {
		// Moved or removed by another load as this one looked: nothing left to do.
		return;
	}
	rmSync(aside, { recursive: true, force: true });
}

/** When `path` was last marked used, or undefined once it is gone. */
function usedAt(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// Removed by another load as this one looked.
		return undefined;
	}
}

/** The digest of every file a copy holds: its place, its mode and its bytes. */
function contentsDigest(files: readonly CopiedFile[]): string {
	const lines = [...files]
		.sort((a, b) => (a.place < b.place ? -1 : a.place > b.place ? 1 : 0))
		.map((file) =>
			JSON.stringify([file.place, file.mode, digestOf(file.text, 64)]),
		);
	return digestOf(lines.join("\n"));
}

function digestOf(text: string | Buffer, length = NAME_LENGTH): string {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function exists(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

function codeOf(error: unknown): string {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: "error";
}
