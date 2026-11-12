/**
 * Which loaded tools a session has left alone since its last compaction,
 * so the loadout can put them down at the next.
 *
 * Once loaded, a tool stayed declared for the rest of the session: on
 * 10 November the browser's four tools, about 29,000 characters, were
 * read on every turn in 17 of 72 sessions long after the work that
 * loaded them (QCXZEB). One compaction's span with no call is the sign
 * the work has moved on; loading it again is one `tool_search` away.
 *
 * A tool loaded again after it was put down is kept for the rest of the
 * session: it has shown it comes back. On 12 November 216 of 560 tools
 * put down in a day were loaded again in the same session (`jobs` 105
 * times), and each coming and going made pi re-send the whole rules and
 * tools sections, which every later turn then carried.
 */

import type { LoadableTool } from "./loadable.ts";

/** What the loadout tells the tracker, and asks of it at a compaction. */
export interface IdleTools {
	/** A tool was called. */
	used(name: string): void;
	/**
	 * The tools declared now; any not declared at the look before was just
	 * loaded. The first look is where the session began, so it loads
	 * nothing.
	 */
	saw(active: readonly string[]): void;
	/**
	 * The deferred tools among `deferred` declared and neither called nor
	 * loaded since the last time this was asked, which starts a new span.
	 * A tool that came back after an earlier answer named it is never
	 * named again.
	 */
	since(deferred: readonly LoadableTool[]): string[];
}

/** A tracker of what was called and loaded, span by span. */
export function idleTools(): IdleTools {
	const declared = new Set<string>();
	let touched = new Set<string>();
	const putDown = new Set<string>();
	const kept = new Set<string>();
	let looked = false;
	return {
		used(name) {
			touched.add(name);
		},
		saw(active) {
			if (looked) {
				for (const name of active) {
					if (declared.has(name)) continue;
					touched.add(name);
					if (putDown.has(name)) kept.add(name);
				}
			}
			looked = true;
			declared.clear();
			for (const name of active) declared.add(name);
		},
		since(deferred) {
			const idle = deferred
				.map((tool) => tool.name)
				.filter(
					(name) => declared.has(name) && !touched.has(name) && !kept.has(name),
				);
			for (const name of idle) {
				declared.delete(name);
				putDown.add(name);
			}
			touched = new Set();
			return idle;
		},
	};
}
