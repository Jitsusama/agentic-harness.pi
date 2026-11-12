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
 */

import { open } from "node:fs/promises";

/** Enough for a process's name or a cgroup's number, and below Node's pool size. */
const FIRST_BYTES = 256;

/**
 * A kernel file's text, read into a buffer that starts at `size` bytes
 * and doubles while the file fills it. Rejects as `open` does when the
 * file can't be read.
 */
export async function kernelText(
	path: string,
	size: number = FIRST_BYTES,
): Promise<string> {
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
