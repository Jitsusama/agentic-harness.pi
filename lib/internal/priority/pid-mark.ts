/**
 * A file named for this process's pid that the machine reads as a mark
 * on the whole process, kept by every follower in it.
 *
 * The traffic shaper and the jobs-sorter read `typed/<pid>` and
 * `background/<pid>` by whether the file is there, and parse its name as
 * a pid, so a process has one file whoever in it follows a session. On
 * plain pi that is one follower. A host runs several conversations in one
 * process, each with its own follower, and then the file stands for all
 * of them: `any` keeps it while any follower holds it (a typed turn in
 * any conversation sends the process's requests ahead), and `every` only
 * while all do (the process yields the CPU only when no conversation
 * needs it).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { processGlobal } from "../process-global.ts";

/** Whose hold keeps the file: any follower's, or every follower's. */
export type Quorum = "any" | "every";

/** One follower's part in a pid's mark. */
export interface PidMark {
	/** Whether this follower holds the mark now. */
	hold(on: boolean): void;
	/** This follower is gone; the file follows those left. */
	leave(): void;
}

interface Shared {
	readonly holds: Map<object, boolean>;
	written: boolean;
}

function marks(): Map<string, Shared> {
	return processGlobal("agentic-harness.priority.pid-marks", () => new Map());
}

/**
 * A follower of the mark `file` in `dir`, held by `quorum`. Errors
 * writing are dropped: the reader then sees no mark, which is how it was
 * before, and a later hold tries again. An `any` follower holding anew
 * renews the file; an `every` one writes it once, so it says since when
 * the whole process may yield. One that left joins again when it next
 * holds it, as a session that ends and starts anew in the same runtime
 * does; letting go after leaving changes nothing, so a follower that
 * stopped never holds an `every` mark back.
 */
export function followPidMark(
	dir: string,
	file: string,
	quorum: Quorum,
): PidMark {
	const all = marks();
	const me = {};
	const join = (): Shared => {
		const shared = all.get(file) ?? { holds: new Map(), written: false };
		all.set(file, shared);
		if (!shared.holds.has(me)) shared.holds.set(me, false);
		return shared;
	};
	const settle = (shared: Shared, renew: boolean) => {
		const holds = [...shared.holds.values()];
		const marked =
			quorum === "any"
				? holds.some(Boolean)
				: holds.length > 0 && holds.every(Boolean);
		if (marked && (renew || !shared.written)) {
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, `${new Date().toISOString()}\n`);
				shared.written = true;
			} catch {
				// A reader that can't see the file treats the pid as unmarked.
			}
		} else if (!marked && shared.written) {
			shared.written = false;
			try {
				rmSync(file, { force: true });
			} catch {
				// One left behind is the reader's to ignore once its pid goes.
			}
		}
	};
	// A follower joins unheld, which takes an `every` mark away at once.
	settle(join(), false);
	return {
		hold(on) {
			if (!on && !all.get(file)?.holds.has(me)) return;
			const shared = join();
			shared.holds.set(me, on);
			settle(shared, on && quorum === "any");
		},
		leave() {
			const shared = all.get(file);
			if (!shared?.holds.delete(me)) return;
			if (shared.holds.size === 0) all.delete(file);
			settle(shared, false);
		},
	};
}
