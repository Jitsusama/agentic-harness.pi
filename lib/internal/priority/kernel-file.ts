/**
 * Reading the kernel's own files, /proc's and the cgroups', off pi's
 * main thread without the memory a whole-file read costs.
 *
 * Such a file says it is empty, so `readFile` reads it into a fresh
 * 64 KiB buffer however little it holds. The room reads every
 * process's name at once, nearly 2,000 of them, and that asked malloc
 * for about 120 MB on each keep; glibc's heap fragmented rather than
 * shrank, and on 11 November an idle pi with this package grew its
 * heap by 2.4 MB a minute while a bare one stayed flat. A buffer the
 * size of what such a file holds, grown only for one that fills it,
 * left the heap flat and the reading twice as fast.
 *
 * Reading them all at once still held the loop: every open and read
 * began, and later finished, in the same step, and a shared host's
 * other conversations waited 155 ms on one such step (OSPHT4, 14
 * November 2026). So only a few run at once, and the rest wait their
 * turn, which spreads the work over many short steps.
 */

import { open } from "node:fs/promises";

/** Enough for a process's name or a cgroup's number, and below Node's pool size. */
const FIRST_BYTES = 256;

/** How many kernel files are read at once, by every caller in the process. */
export const AT_ONCE = 16;

/**
 * The reads running and those waiting their turn, for the whole process:
 * the loop they would hold is the process's, whoever asked.
 */
const TURNS = { running: 0, waiting: [] as (() => void)[] };

/** Wait for a turn to read, then hold it. */
function turn(): Promise<void> {
	if (TURNS.running < AT_ONCE) {
		TURNS.running += 1;
		return Promise.resolve();
	}
	return new Promise((begin) => TURNS.waiting.push(begin));
}

/** Give a turn to the next waiting read, or give it up. */
function done(): void {
	const next = TURNS.waiting.shift();
	if (next) setImmediate(next);
	else TURNS.running -= 1;
}

/**
 * A kernel file's text, read into a buffer that starts at `size` bytes
 * and doubles while the file fills it. Rejects as `open` does when the
 * file can't be read.
 */
export async function kernelText(
	path: string,
	size: number = FIRST_BYTES,
): Promise<string> {
	await turn();
	try {
		return await textOf(path, size);
	} finally {
		done();
	}
}

/** What `kernelText` reads, once it has its turn. */
async function textOf(path: string, size: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		let buffer = Buffer.allocUnsafe(size);
		let filled = 0;
		for (;;) {
			if (filled === buffer.length) {
				const bigger = Buffer.allocUnsafe(buffer.length * 2);
				buffer.copy(bigger, 0, 0, filled);
				buffer = bigger;
			}
			const { bytesRead } = await handle.read(
				buffer,
				filled,
				buffer.length - filled,
				null,
			);
			if (bytesRead === 0) return buffer.toString("utf8", 0, filled);
			filled += bytesRead;
		}
	} finally {
		await handle.close();
	}
}
