/**
 * The files a language server names, opened by pi and judged as the
 * files they are.
 *
 * pi reads and writes them in its own process, which no sandbox
 * reaches, while a fenced server runs on inside its fence, able to
 * write the folder it names them in. A check of a path judges what
 * the path named then, and the server can swap in a link to a file
 * its fence closes before pi opens it. So a file is opened first and
 * the file opened is judged, by the path the kernel gives its
 * descriptor, and pi reads and writes through that descriptor alone.
 *
 * Where the kernel gives no such path (a Mac has no `/proc`), a write
 * is refused, and a read is judged by the path's real target, held to
 * being the very file opened, its device and inode, after its check.
 *
 * Opened without waiting, so a pipe the server leaves where a file
 * was can't hold pi's thread, and only a plain file is read.
 *
 * Under a fence the path is also judged before it is opened, so pi
 * opens nothing the fence closes by name. A link the server swaps in
 * between can still lead the open elsewhere, a device included, and
 * then only the check after, by the descriptor, keeps what is read. A
 * file with a second name is never written, since the fence judged
 * only the name pi opened. None past `LARGEST` bytes is used, fenced
 * or not, since pi holds it whole: under a fence a file measured
 * larger is refused as it opens, and any file that runs past it as it
 * is read.
 */

import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
	writeSync,
} from "node:fs";
import type { LspFence } from "../types.ts";

/** What a fence says of a file pi would read or write for its server. */
export type Refuses = LspFence["refuses"];

/** Where this process's descriptors are named, on a kernel that names them. */
const DESCRIPTORS = "/proc/self/fd";

/** How the kernel marks a descriptor's file that was removed. */
const REMOVED = " (deleted)";

/**
 * The most bytes of one file pi reads or writes for a language server,
 * fenced or not: `textAt` reads every file by it.
 */
export const LARGEST = 32 * 1024 * 1024;

/**
 * A descriptor on `path`, opened to `use`, once `refuses` lets the file
 * it opened be used so; with no fence, opened as it is.
 */
export function openJudged(
	path: string,
	use: "read" | "write",
	refuses: Refuses | undefined,
	descriptors: string = DESCRIPTORS,
): number {
	if (refuses) {
		const before = beforeOpening(path, use, refuses);
		if (before) throw new Error(before);
	}
	const fd = openSync(
		path,
		(use === "write" ? constants.O_RDWR : constants.O_RDONLY) |
			constants.O_NONBLOCK |
			constants.O_NOCTTY,
	);
	try {
		const file = fstatSync(fd);
		if (!file.isFile()) throw new Error(`${path} isn't a file`);
		if (refuses) {
			const refused =
				held(file, path, use) ?? judged(fd, path, use, refuses, descriptors);
			if (refused) throw new Error(refused);
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** Why `path` may not be opened to `use` at all, as it names now. */
function beforeOpening(
	path: string,
	use: "read" | "write",
	refuses: Refuses,
): string | undefined {
	// The fence first, since even a stat reaches the mount a path names.
	return (
		refuses(use, path) ??
		(statSync(path).isFile() ? undefined : `${path} isn't a file`)
	);
}

/** Why the file opened at `path`, as `file` says it is, may not be used so. */
function held(
	file: { nlink: number; size: number },
	path: string,
	use: "read" | "write",
): string | undefined {
	if (file.size > LARGEST)
		return `${path} is larger than the ${LARGEST / 1024 / 1024} MiB pi reads or writes for a fenced server`;
	if (use === "write" && file.nlink > 1)
		return `${path} has another name, which the fence didn't judge, so pi writes it for no fenced server`;
	return undefined;
}

/** Why the file `fd` opened at `path` may not be used so, if it may not. */
function judged(
	fd: number,
	path: string,
	use: "read" | "write",
	refuses: Refuses,
	descriptors: string,
): string | undefined {
	if (existsSync(descriptors)) {
		const opened = readlinkSync(`${descriptors}/${fd}`);
		if (opened.endsWith(REMOVED)) return `${path} was removed as pi opened it`;
		return refuses(use, opened);
	}
	if (use === "write")
		return `pi can't tell here which file it opened at ${path}, so it writes none a fenced server names`;
	const real = realpathSync(path);
	const refused = refuses(use, real);
	if (refused) return refused;
	const opened = fstatSync(fd);
	const there = statSync(real);
	return opened.dev === there.dev && opened.ino === there.ino
		? undefined
		: `${path} changed as pi opened it`;
}

/**
 * The text of the file `fd` is open on, from its start, refused once
 * it runs past `LARGEST`: a fenced server can grow the file after pi
 * measured it, so what was measured bounds nothing read.
 */
export function textAt(fd: number): string {
	const chunks: Buffer[] = [];
	let at = 0;
	while (at <= LARGEST) {
		const chunk = Buffer.allocUnsafe(Math.min(CHUNK, LARGEST + 1 - at));
		const read = readSync(fd, chunk, 0, chunk.length, at);
		if (read === 0) return Buffer.concat(chunks, at).toString("utf8");
		chunks.push(chunk.subarray(0, read));
		at += read;
	}
	throw new Error(
		`the file runs past the ${LARGEST / 1024 / 1024} MiB pi reads or writes for a language server`,
	);
}

/** How much of a file `textAt` reads at a time. */
const CHUNK = 64 * 1024;

/** Lays `text` over the whole of the file `fd` is open on. */
export function rewriteAt(fd: number, text: string): void {
	const bytes = Buffer.from(text, "utf8");
	ftruncateSync(fd, 0);
	let at = 0;
	while (at < bytes.length)
		at += writeSync(fd, bytes, at, bytes.length - at, at);
}

/** `path`'s text, opened to read as `refuses` lets it. */
export function readJudged(path: string, refuses: Refuses | undefined): string {
	const fd = openJudged(path, "read", refuses);
	try {
		return textAt(fd);
	} finally {
		closeSync(fd);
	}
}
