/**
 * Whether pi already runs inside a sandbox on a Mac, which decides
 * whether a fenced session's commands may run there as they are.
 *
 * macOS lays no second profile inside a sandboxed process, so a trial
 * profile that sandbox-exec runs but can't apply says pi is fenced.
 * Which sandbox that is pi can't tell, though not `pi-fence`'s, whose
 * Mac profile hides pi's own state, so pi can't run in it. Anything else counts as no sandbox, so
 * a fenced command is refused rather than run where nothing may fence
 * it: sandbox-exec missing, or refused before it runs, since a tool that
 * vets programs refuses one with the same error a sandbox would. A trial
 * that couldn't tell for a reason that passes (a timeout, a kill, or a
 * busy machine's spawn error) is "unknown" rather than "outside", so
 * nothing acts on it for good: a declared fence is kept, and its
 * commands are refused until a later trial tells, which a lone pi,
 * drawing its shell's sandbox once at load, runs only on a reload.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SANDBOX_EXEC } from "../fence/fence-seatbelt.ts";

/** How a trial's run turned out, as `spawnSync` reports it. */
export interface Trial {
	readonly status: number | null;
	readonly stderr: string;
	readonly failed: boolean;
	/**
	 * It couldn't tell for a reason that passes, as a busy machine may
	 * cause (a timeout, a kill, a spawn error other than a lasting one),
	 * so it is tried again.
	 */
	readonly passing?: boolean;
}

/** How long the trial may take before it counts as unknown. */
const TRIAL_MS = 5000;

/**
 * How long a trial that couldn't tell is kept before the next is run,
 * so a busy Mac runs one blocking trial in that time, not one for every
 * sandbox drawn.
 */
export const RETRY_MS = 30_000;

/** Whether pi runs inside a sandbox, or a trial couldn't tell. */
export type MacSandbox = "inside" | "outside" | "unknown";

/**
 * The spawn errors that last: sandbox-exec missing, or refused before it
 * runs, by a sandbox or by a tool that vets programs.
 */
const LASTING = new Set(["ENOENT", "EACCES", "EPERM"]);

/** What macOS says when a sandboxed process asks for another profile. */
const NESTED = /sandbox_apply: Operation not permitted/;

/** Runs sandbox-exec with a profile that allows everything. */
function trial(): Trial {
	const run = spawnSync(
		SANDBOX_EXEC,
		["-p", "(version 1)(allow default)", "/usr/bin/true"],
		{
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
			timeout: TRIAL_MS,
		},
	);
	return trialOf(run);
}

/** A trial's answer from what `spawnSync` reported of its run. */
export function trialOf(run: {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr?: string | null;
	readonly error?: Error;
}): Trial {
	const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
	return {
		status: run.status,
		stderr: run.stderr ?? "",
		failed: run.error !== undefined,
		// Timed out (ETIMEDOUT), out of processes, memory or files (EAGAIN,
		// ENOMEM, EMFILE), or killed: none says whether pi is fenced.
		passing:
			run.error !== undefined
				? !LASTING.has(code ?? "")
				: run.status === null && run.signal !== null,
	};
}

/**
 * `run`'s answer, kept for the process once it finishes in time: a
 * process can't leave the sandbox it runs in, nor enter one, so the
 * answer holds for its whole life, and each sandbox drawn after reads it
 * rather than waiting on sandbox-exec again. A trial that couldn't tell
 * is kept only `RETRY_MS`, then tried again at the next sandbox
 * drawn. Where sandboxes are drawn afresh, as pi-host does for each
 * conversation, one slow moment doesn't refuse the host's fenced
 * sessions until it restarts; a lone pi draws its shell's once, at load.
 */
export function keeping(
	run: () => Trial,
	now: () => number = Date.now,
): () => Trial {
	let kept: Trial | undefined;
	let retry = 0;
	return () => {
		if (kept && (!kept.passing || now() < retry)) return kept;
		kept = run();
		if (kept.passing) retry = now() + RETRY_MS;
		return kept;
	};
}

const keptTrial = keeping(trial);

/** Whether this process runs inside a sandbox: sandbox-exec ran and couldn't apply its trial profile. */
export function macSandbox(run: () => Trial = keptTrial): MacSandbox {
	const { status, stderr, failed, passing } = run();
	if (passing) return "unknown";
	return !failed && status !== 0 && NESTED.test(stderr) ? "inside" : "outside";
}

/** Whether this process is known to run inside a sandbox (`macSandbox`). */
export function insideMacSandbox(run: () => Trial = keptTrial): boolean {
	return macSandbox(run) === "inside";
}

/**
 * sandbox-exec, where this Mac has it, to lay the fence's own profile
 * around each command of a pi no sandbox holds; nothing where it isn't.
 */
export function macSandboxExec(): string | undefined {
	return existsSync(SANDBOX_EXEC) ? SANDBOX_EXEC : undefined;
}
