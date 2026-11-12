/**
 * Keep pi-tui's log of full redraws, so `scripts/redraw-tally.ts` can
 * say which kind comes most before the dock is changed to stop the ask
 * dialogs losing their text while a reply streams in (Joel, 11
 * November).
 *
 * pi-tui writes a line to `pi-tui-debug.log` in pi's agent folder at
 * each full redraw while `PI_TUI_DEBUG_REDRAW` is `1`, and reads the
 * setting at every render, so turning it on as a session starts counts
 * from then. A full redraw is rare beside a frame, and its line is a
 * hundred bytes, so the log is cheap; it is set aside once past
 * MOST_LOG_BYTES, keeping one older copy, so it never grows without end.
 * A setting the person gave stands, `0` included.
 */

import { renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnvironment } from "../../lib/core/session/host.ts";

/** The setting pi-tui reads at each render. */
export const REDRAW_SETTING = "PI_TUI_DEBUG_REDRAW";

/** The log pi-tui writes in pi's agent folder. */
export const REDRAW_LOG = "pi-tui-debug.log";

/** How large the log grows before it is set aside for a fresh one. */
export const MOST_LOG_BYTES = 8 * 1024 * 1024;

/** Turn pi-tui's redraw log on, unless the person set it, and keep it short. */
export function countRedraws(env: SessionEnvironment, agentDir: string): void {
	if (env.get(REDRAW_SETTING) !== undefined) return;
	env.set(REDRAW_SETTING, "1");
	const log = join(agentDir, REDRAW_LOG);
	try {
		if (statSync(log).size > MOST_LOG_BYTES) renameSync(log, `${log}.1`);
	} catch {
		// No log yet is nothing to set aside, and one another pi set aside
		// a moment ago is already short.
	}
}
