/**
 * Where the agent fence keeps the copies it binds over files inside: pi's
 * own folder in the runtime folder, which is memory, the person's alone,
 * and emptied inside the fence, so no fenced command reads a copy but
 * through the file it stands in for.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi's folder in the runtime folder, for the fence's copies. */
const FOLDER = "pi-fence";

/**
 * The path of the copy named `name`, holding `text`, written only when
 * what is there differs (`current` reads it); or nothing when there is
 * no runtime folder or the copy can't be written.
 */
export function fenceCopy(
	runtimeDir: string | undefined,
	name: string,
	text: string,
	current: (path: string) => string | undefined,
): string | undefined {
	if (!runtimeDir) return undefined;
	const path = join(runtimeDir, FOLDER, name);
	if (current(path) === text) return path;
	try {
		// Only pi's own folder is made, never the runtime folder: node's
		// recursive mkdir spins for good where a parent exists but refuses
		// a child with ENOENT, as /proc does, which hung every wrap.
		if (!existsSync(dirname(path))) mkdirSync(dirname(path), { mode: 0o700 });
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	} catch {
		// No copy to bind: the caller binds nothing, and says what that leaves.
		return undefined;
	}
}
