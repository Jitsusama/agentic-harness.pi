/**
 * Shell Habit Interceptor Extension
 *
 * Three habits the standing rules forbid and the prompt did not stop,
 * caught as the command runs (lib/internal/shell-habits.ts says how
 * often each was seen).
 *
 * A trailing `| tail -N` or `| head -N` on a build or a test run is
 * dropped without a word: pi keeps the end of what a command prints and
 * saves the rest, so the pipe only held the output back, and the
 * command's own exit status is what comes back instead of tail's.
 *
 * `stash` refuses git stash saving work, `sleep` a sleep of ten
 * seconds or more, and `shell-edit` a redirect, `tee`, `sed -i` or
 * `perl -i` onto a file git tracks, each naming what to do instead. All
 * three redirect, so a repeat of the same command goes ahead.
 */

import { homedir } from "node:os";

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import {
	shellEditRefusal,
	sleepRefusal,
	stashRefusal,
	trackedShellEdits,
	withoutOutputCut,
} from "../../lib/internal/shell-habits.ts";
import { stripHeredocBodies, stripShellData } from "../../lib/shell/index.ts";

export default function shellHabitInterceptor(pi: ExtensionAPI) {
	declareGuards(GUARDS.stash, GUARDS.sleep, GUARDS.shellEdit);
	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command;
			const stripped = stripShellData(stripHeredocBodies(command));

			const stash = stashRefusal(stripped);
			if (stash) {
				return refusalUnder(
					GUARDS.stash.name,
					{ block: true, reason: stash },
					"git stash",
					command,
				);
			}
			const sleep = sleepRefusal(stripped);
			if (sleep) {
				const refused = refusalUnder(
					GUARDS.sleep.name,
					{ block: true, reason: sleep },
					"A long sleep",
					command,
				);
				if (refused) return refused;
			}
			const edited = trackedShellEdits(command, {
				cwd: ctx.cwd,
				home: homedir(),
			});
			if (edited.length > 0) {
				const refused = refusalUnder(
					GUARDS.shellEdit.name,
					{ block: true, reason: shellEditRefusal(edited) },
					"A shell rewrite of a tracked file",
					command,
				);
				if (refused) return refused;
			}

			const uncut = withoutOutputCut(command, stripped);
			if (uncut !== undefined) {
				(event.input as { command: string }).command = uncut;
			}
			return undefined;
		},
	);
}
