/**
 * A stopped command takes with it whatever left its shell's process
 * group.
 *
 * pi stops a command by killing its shell's process group. GNU
 * `timeout` puts itself in a group of its own unless told
 * `--foreground`, and so do `setsid` and some build clients. So a
 * stopped `timeout 7200 nix-store --realise …` lost only its shell:
 * `timeout` and the client under it were handed to init and ran on, a
 * VM test to its end, while the stop reported the group killed. X7FXPL
 * met this twice on 24 October, the second time twenty minutes on.
 *
 * Each command's environment carries a mark of its own, which every
 * process it starts inherits whatever group or session it moves to.
 * When the command is stopped or runs out of time, every process still
 * carrying the mark is killed as well (lib/internal/shell/reap.ts). A
 * command that ends by itself keeps what it left running, since a server
 * started with `&` is often the point of it. Linux only: elsewhere there
 * is no /proc to read, and a stop is pi's group kill, as it was.
 */

import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	CALL_VARIABLE,
	type ReapOptions,
	reap,
} from "../../lib/internal/shell/reap.ts";

/** Whether a failed run is pi's own time limit ending it. */
function timedOut(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("timeout:");
}

/** pi's operations, with each command reaped whole when it is stopped. */
export function reapsWhatItLeft(
	ops: BashOperations,
	options: ReapOptions = {},
): BashOperations {
	return {
		async exec(command, cwd, call) {
			const mark = randomUUID();
			const env = { ...(call.env ?? process.env), [CALL_VARIABLE]: mark };
			const { signal } = call;
			const stopped = () => reap(mark, options);
			signal?.addEventListener("abort", stopped, { once: true });
			try {
				return await ops.exec(command, cwd, { ...call, env });
			} catch (error) {
				// Again once the shell is gone, for whatever forked meanwhile.
				if (signal?.aborted || timedOut(error)) reap(mark, options);
				throw error;
			} finally {
				signal?.removeEventListener("abort", stopped);
			}
		},
	};
}
