/**
 * Whether the person has asked for quiet: the desktop's Do Not Disturb.
 *
 * The desktop keeps its quiet in a file, `<since> <until>` in
 * milliseconds since 1970, an until of 0 meaning until it's ended, and
 * empty or missing when there is none (core's `Quiet.qml` writes
 * `$XDG_RUNTIME_DIR/quiet`). A ring is held while it reads as quiet,
 * read again at each ring, so ending the quiet lets the next one sound.
 * On 12 November four dings sounded through a Do Not Disturb that had
 * been on since midnight.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Where `named` is: as given when absolute, otherwise under the runtime
 * folder, which Nix can't know when it writes the description. Nothing
 * when it's relative and there is no runtime folder to find it in.
 */
export function quietFile(
	named: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (isAbsolute(named)) return named;
	const runtime = env.XDG_RUNTIME_DIR;
	return runtime ? join(runtime, named) : undefined;
}

/**
 * Whether `file` says it's quiet at `now`: it reads `<since> <until>`,
 * with an until of 0 or later than now. A file that's missing, empty or
 * reads otherwise isn't quiet, as the desktop itself takes it.
 */
export function isQuiet(file: string, now: number = Date.now()): boolean {
	let text: string;
	try {
		text = readFileSync(file, "utf8").trim();
	} catch {
		// No file is the usual case: nobody has asked for quiet.
		return false;
	}
	const [since, until, ...rest] = text.split(/\s+/).map(Number);
	if (rest.length > 0 || !Number.isFinite(since) || until === undefined) {
		return false;
	}
	if (!Number.isFinite(until)) return false;
	return until === 0 || until > now;
}
