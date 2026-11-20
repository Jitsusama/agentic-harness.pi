/**
 * Where the agent fence keeps the copies it binds over files inside: pi's
 * own folder in the runtime folder, which is memory, the person's alone,
 * and emptied inside the fence, so no fenced command reads a copy but
 * through the file it stands in for.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** pi's folder in the runtime folder, for the fence's copies. */
const FOLDER = "pi-fence";

/** The permission bits of a file's mode. */
const FILE_MODE_BITS = 0o777;

/**
 * The path of the copy named `name`, holding `text`, written only when
 * what is there differs (`current` reads it), with `mode`; or nothing
 * when there is no runtime folder or the copy can't be written.
 */
export function fenceCopy(
	runtimeDir: string | undefined,
	name: string,
	text: string,
	current: (path: string) => string | undefined,
	mode = 0o600,
): string | undefined {
	if (!runtimeDir) return undefined;
	const path = join(runtimeDir, FOLDER, name);
	let staging: string | undefined;
	try {
		// Only pi's own folder is made, never the runtime folder: node's
		// recursive mkdir spins for good where a parent exists but refuses
		// a child with ENOENT, as /proc does, which hung every wrap.
		if (!existsSync(dirname(path))) mkdirSync(dirname(path), { mode: 0o700 });
		// A Mac's copies sit in a folder commands can write around: a link
		// where pi's folder should be is refused, and a link where the copy
		// should be is replaced, even when what it leads to already reads
		// right, by a copy written beside its place and renamed over it.
		if (!lstatSync(dirname(path)).isDirectory()) return undefined;
		const linked = existsSync(path) && lstatSync(path).isSymbolicLink();
		// One written with another mode, as a list kept from before its mode
		// was asked for, is written afresh, so it is read-only as a new one is.
		if (
			!linked &&
			current(path) === text &&
			(lstatSync(path).mode & FILE_MODE_BITS) === mode
		)
			return path;
		staging = `${path}.${randomUUID()}`;
		writeFileSync(staging, text, { mode, flag: "wx" });
		renameSync(staging, path);
		staging = undefined;
		return path;
	} catch {
		// No copy to bind: the caller binds nothing, and says what that leaves.
		return undefined;
	} finally {
		if (staging) rmSync(staging, { force: true });
	}
}
