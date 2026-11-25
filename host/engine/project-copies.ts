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
 * same bytes reuse the copy already there. Each use marks the copy, and
 * one unused for a week is removed, never the one just used: a
 * conversation still running reads its extensions' own files from the
 * copy it loaded.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	renameSync,
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

/** How much of a digest names a folder or a copy: enough that two never meet. */
const NAME_LENGTH = 32;

/** The mode a copy's folders get, so only the host's user can change them. */
const FOLDER_MODE = 0o700;

/** The bits a copied file keeps: its owner may always read and write it, as the host must. */
const OWNER_READS_AND_WRITES = 0o600;

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
	const folder = join(agentDir, COPIES_FOLDER, digestOf(cwd));
	const dir = join(folder, contentsDigest(files));
	try {
		if (!exists(dir)) write(dir, files);
		const time = now() / 1000;
		utimesSync(dir, time, time);
		prune(folder, dir, now);
		return { dir };
	} catch (error) {
		// A full disk or an agent folder the host can't write.
		return { failed: `the host couldn't write its copy (${codeOf(error)})` };
	}
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
 * Remove what under `folder` went unused for a week, but for `keep`: a
 * copy, or one left half written by a load that stopped.
 */
function prune(folder: string, keep: string, now: () => number): void {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (path === keep) continue;
		try {
			if (now() - statSync(path).mtimeMs > UNUSED_FOR)
				rmSync(path, { recursive: true, force: true });
		} catch {
			// Removed by another load as this one looked: nothing left to do.
		}
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
