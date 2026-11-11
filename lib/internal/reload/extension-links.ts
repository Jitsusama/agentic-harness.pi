/**
 * Which of pi's extension links moved after this process started.
 *
 * Node's module resolver remembers the real path of every link it has
 * resolved, for the life of the process, and pi hands its loader an
 * extension's link rather than its real path. So once a link in
 * `~/.pi/agent/extensions` moves, a reload reads the new entry file but
 * resolves its imports against the first target. On 11 November the
 * Shopify proxy's link moved at 13:17 and its first target was then
 * collected: a reload failed with "Cannot find module
 * './optimize-images.js'", and a session whose first target survived
 * reloaded onto the new entry and the old helpers mixed (6YZSML
 * [fbc059d2]). Only a new process reads the link afresh.
 *
 * A link's own modified time says when it was made, which is when it
 * last pointed somewhere new, and a launcher that finds it already right
 * leaves it alone, so one made after the process started is one its
 * resolver may hold stale. Its change time won't do: anything that
 * touches the link's owner or mode moves that too.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The names of the links in `folder` made after `startedAt` (epoch ms).
 * A folder that can't be read has none, since nothing in it was loaded.
 */
export function linksMovedSince(folder: string, startedAt: number): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No extensions folder: pi loaded nothing from one.
		return [];
	}
	return names
		.filter((name) => {
			try {
				const stat = lstatSync(join(folder, name));
				return stat.isSymbolicLink() && stat.mtimeMs > startedAt;
			} catch {
				// Gone between the listing and the look: nothing to load stale.
				return false;
			}
		})
		.sort();
}
