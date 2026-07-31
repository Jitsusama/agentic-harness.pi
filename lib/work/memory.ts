/**
 * Remembering the trees a session cut, so the next session can find them.
 *
 * The broker held its trees in an array, which is correct for exactly as long as
 * the process lives. A worktree outlives the process by design, so the next
 * session opened with the trees still on disk, git still tracking them, and
 * every verb answering "no held tree": not merely a listing that forgot, but
 * commits stranded in a directory the tool could no longer reach, releasable
 * only through the `git worktree` call the guide tells you never to make.
 *
 * No test could see it. A test builds a broker and uses it, which is one
 * process; the fault needs two.
 *
 * The directory stays the source of truth for whether a tree exists, and this
 * only supplies the identity a directory name cannot faithfully carry. When the
 * two disagree the directory wins, because somebody who deletes a tree by hand
 * has said something and a stale record has not.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HeldTree } from "./broker.js";

/** Somewhere to write down what was cut. */
export interface TreeMemory {
	/** Write a tree down, so a later session can find it. */
	remember(held: HeldTree): void;
	/** Forget one, once it has genuinely gone. */
	forget(path: string): void;
	/** Every tree written down that is still on disk. */
	recall(): readonly HeldTree[];
}

/** A record as it sits on disk. */
interface Written {
	identity?: HeldTree["identity"];
	path?: string;
	providerId?: string;
}

/** Whether a record read back off disk says enough to be useful. */
function usable(written: Written): written is Required<Written> {
	return (
		typeof written.path === "string" &&
		typeof written.providerId === "string" &&
		typeof written.identity?.key === "string"
	);
}

/**
 * Remember trees in a directory of small files, one per tree.
 *
 * A file per tree rather than one index, for the same reason the attachment
 * store is shaped this way: two sessions cutting trees at once both write, and
 * the loser of a read-modify-write race on a single index is a tree nobody can
 * find. Separate files cannot collide, since the name is the tree's own key.
 */
export function createTreeMemory(dir: string): TreeMemory {
	const fileFor = (key: string): string =>
		join(dir, `${key.replaceAll("/", "-")}.json`);

	function all(): readonly { at: string; held: HeldTree }[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.flatMap((name) => {
				const at = join(dir, name);
				try {
					const written: Written = JSON.parse(readFileSync(at, "utf8"));
					// A record we cannot read is worse than no record, because it
					// would mean a tree reported with a broken identity. Skip it
					// and leave it alone: deleting somebody's file to tidy a
					// listing is not this function's decision.
					return usable(written)
						? [{ at, held: written as unknown as HeldTree }]
						: [];
				} catch {
					// Unreadable or half-written, which a concurrent write can
					// produce. The tree is still on disk and still reachable by
					// path; only its identity is lost, and next cut rewrites it.
					return [];
				}
			});
	}

	return {
		remember(held) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				fileFor(held.identity.key),
				JSON.stringify(held, null, 2),
				"utf8",
			);
		},

		forget(path) {
			for (const { at, held } of all()) {
				if (held.path === path) rmSync(at, { force: true });
			}
		},

		recall() {
			const found: HeldTree[] = [];
			for (const { at, held } of all()) {
				// The directory is the truth. A record whose tree has been
				// removed by hand is dropped and its record with it, which is
				// how somebody who cleaned up by hand stops being nagged about
				// it forever.
				if (existsSync(held.path)) {
					found.push(held);
					continue;
				}
				rmSync(at, { force: true });
			}
			return found;
		},
	};
}
