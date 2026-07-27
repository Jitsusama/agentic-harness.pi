/**
 * Where anything too large to return goes.
 *
 * A response has a byte budget and an image has none, so
 * captures are written to a private per-session directory and
 * the answer carries the path. This lives beside the paging and
 * artifact rules rather than with the page reader, because
 * everything that outgrows a response needs it: screenshots,
 * traces, network archives, whole DOMs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where every session's bundle directory is rooted. */
export const BUNDLE_ROOT = path.join(os.tmpdir(), "pi-web");

/**
 * Where bundles used to be written, still swept so nothing is
 * orphaned.
 *
 * The directory was named after web_read because that was the only
 * thing writing to it. It now holds screenshots, HAR archives, DOM
 * captures and visual baselines from four browser tools, and a
 * person looking at their temp directory to find out what wrote
 * two hundred megabytes there was told the wrong answer.
 *
 * Two of them: the original was hard-coded under /tmp, and the
 * next version moved it under the real temp directory without
 * renaming it.
 */
export const LEGACY_BUNDLE_ROOTS: readonly string[] = [
	"/tmp/pi-web-read",
	path.join(os.tmpdir(), "pi-web-read"),
];

/** Bundle directories are private to the user who made them. */
export const DIR_MODE = 0o700;

/** Artifacts are readable only by their owner. */
export const FILE_MODE = 0o600;

/** Somewhere to put what a response cannot carry. */
export interface BundleSink {
	dir: string;
	/** Write a text artifact and return its path. */
	writeText(name: string, content: string): string;
	/** Write a binary artifact from base64 and return its path. */
	writeBinary(name: string, base64: string): string;
}

/** This process's private bundle directory. */
export function sessionDir(): string {
	return path.join(BUNDLE_ROOT, String(process.pid));
}

/** A filesystem sink that creates a private bundle dir. */
export function diskSink(root: string = sessionDir()): BundleSink {
	fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
	// The "r-" prefix keeps the temp dir inside root, where the
	// reaper looks, rather than creating a sibling of it.
	const dir = fs.mkdtempSync(path.join(root, "r-"));
	fs.chmodSync(dir, DIR_MODE);
	return {
		dir,
		writeText(name, content) {
			const filePath = path.join(dir, name);
			fs.writeFileSync(filePath, content, {
				encoding: "utf-8",
				mode: FILE_MODE,
			});
			return filePath;
		},
		writeBinary(name, base64) {
			const filePath = path.join(dir, name);
			fs.writeFileSync(filePath, Buffer.from(base64, "base64"), {
				mode: FILE_MODE,
			});
			return filePath;
		},
	};
}
