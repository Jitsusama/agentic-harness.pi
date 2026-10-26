/**
 * Writing a path the way a person would say it.
 *
 * Absolute paths under a home directory carry a prefix that is the same on every
 * line and tells the reader nothing. A tree listing is the worst case: two lines
 * where the interesting halves are a key and a provider, and the widest thing on
 * screen is a directory nobody has to type.
 */

import { homedir } from "node:os";
import { sep } from "node:path";

/**
 * A path with the home directory written as `~`.
 *
 * **For display only.** The result is not a path any tool can open: `~` is a
 * shell courtesy, not a filesystem entry, and expanding it is the shell's job.
 * So this belongs in the text a person reads and never in the `details` of a
 * tool answer, where a caller may reasonably feed a path straight back into
 * another call. When both are wanted, abbreviate the view and keep the absolute
 * path in the details.
 *
 * Rewrites a leading home prefix and nothing else. A relative path is returned
 * as it came, which is what makes this safe to apply to a list that mixes the
 * two: a repo-relative `lib/work/tree.ts` has no prefix to lose. A path that
 * merely mentions the home directory somewhere in the middle is also left alone,
 * since only the prefix is a home directory rather than a coincidence.
 */
export function displayPath(path: string, home = homedir()): string {
	// An empty home would turn every path into a tilde, which is the sort of
	// thing that happens on a machine with no HOME set rather than never.
	if (home.length === 0) return path;

	const bare = home.endsWith(sep) ? home.slice(0, -sep.length) : home;
	if (path === bare) return "~";

	// The separator is required, so a sibling directory whose name merely starts
	// with the home directory's name keeps its own name. Without it,
	// `/Users/joel.gerber.backup` reads as `~.backup`, which looks like a file
	// inside home and is a different place entirely.
	return path.startsWith(bare + sep) ? `~${path.slice(bare.length)}` : path;
}
