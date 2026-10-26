/**
 * Running the resolved check command and shaping its output for an
 * agent to read: strip terminal control sequences, cap a runaway
 * tail, and report pass/fail. This is the "on request" layer only
 * (a `verify` tool a skill or CLI subcommand exposes) — the fast,
 * turn-boundary auto-verify layer pi also has depends on a resident
 * LSP backend pi keeps running, which has no equivalent here, so
 * it stays pi-only rather than being approximated badly.
 */

import { spawn } from "node:child_process";
import { findProject } from "./project.ts";
import { resolveCheckCommand } from "./resolve.ts";

/** How long a check command may run. */
const CHECK_TIMEOUT_MS = 300_000;
/** Cap on captured check output held in memory (a rolling tail). */
const MAX_CAPTURE_BYTES = 512 * 1024;

/**
 * Strip ANSI escape sequences (colour and cursor control) from
 * captured output. A test runner emits these even into a pipe, and
 * left in returned text they smear a plain-text reader.
 */
// ESC[ control sequences (colour, cursor) with the full 0x30-0x3F
// parameter class so `:<=>?` are covered, and ESC] OSC sequences
// terminated by either BEL or ST (ESC backslash). Built from a
// string so the source carries no literal control bytes.
// biome-ignore lint/complexity/useRegexLiterals: a literal would embed control bytes the linter rejects.
const ANSI_PATTERN = new RegExp(
	"\\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)",
	"g",
);

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** Cap the captured output so a noisy suite does not flood the reply. */
export function truncate(output: string, maxLines = 200): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) return output.trim();
	return [
		`... (${lines.length - maxLines} earlier lines omitted)`,
		...lines.slice(lines.length - maxLines),
	]
		.join("\n")
		.trim();
}

interface CommandResult {
	readonly code: number;
	readonly output: string;
}

function runCommand(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		// The child runs in its own session (detached) with no stdin
		// and piped output. Detaching removes the controlling terminal,
		// so a test-runner descendant cannot write progress straight to
		// the caller's screen. The environment forces plain,
		// non-interactive output so nothing tries cursor control in the
		// first place.
		const child = spawn(command, {
			cwd,
			shell: true,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CI: "true",
				NO_COLOR: "1",
				FORCE_COLOR: "0",
				TERM: "dumb",
			},
		});

		// Kill the whole process group, not just the shell, so detached
		// test workers do not outlive an abort or a timeout.
		const killGroup = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone, or never grouped; nothing to reap.
			}
		};
		const timer = setTimeout(killGroup, CHECK_TIMEOUT_MS);
		const onAbort = () => killGroup();
		// addEventListener does not fire for a signal that is already
		// aborted, so kill up front in that case; otherwise the
		// detached suite would run to the timeout after an abort.
		if (signal?.aborted) killGroup();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		// Keep a rolling tail rather than the whole stream, so a
		// runaway command cannot grow the buffer without bound for the
		// whole timeout window; the tail is what the summary keeps.
		let output = "";
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > MAX_CAPTURE_BYTES) {
				output = output.slice(output.length - MAX_CAPTURE_BYTES);
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (err) => {
			cleanup();
			resolvePromise({
				code: 1,
				output: stripAnsi(`${output}\n${err.message}`).trim(),
			});
		});
		child.on("close", (code) => {
			cleanup();
			resolvePromise({ code: code ?? 1, output: truncate(stripAnsi(output)) });
		});
	});
}

export interface RunVerifyOptions {
	/** Where to look for the nearest package.json and run the command. */
	readonly cwd: string;
	/** A verify command from the caller's own project convention, if any. */
	readonly questVerify?: string;
	readonly signal?: AbortSignal;
}

export interface VerifyOutcome {
	readonly ok: boolean;
	readonly command?: string;
	/** Human-readable summary: what ran, and its tail (pass) or full output (fail). */
	readonly output: string;
}

/**
 * Resolve and run the project's check command, and shape the
 * result for an agent to read directly. The one entry point an
 * adapter needs.
 */
export async function runVerify(
	options: RunVerifyOptions,
): Promise<VerifyOutcome> {
	const project = findProject(options.cwd);
	const resolved = resolveCheckCommand({
		...(options.questVerify ? { questVerify: options.questVerify } : {}),
		packageScripts: project?.scripts ?? {},
		packageManager: project?.packageManager ?? "pnpm",
	});
	if (!resolved) {
		return {
			ok: false,
			output:
				"No verification command found (no lint, typecheck, test or verify script).",
		};
	}

	const run = await runCommand(
		resolved.command,
		project?.dir ?? options.cwd,
		options.signal,
	);
	if (run.code === 0) {
		const tail = run.output.split("\n").slice(-12).join("\n").trim();
		return {
			ok: true,
			command: resolved.command,
			output: `Passed: ${resolved.command}\n\n${tail}`.trim(),
		};
	}
	return {
		ok: false,
		command: resolved.command,
		output:
			`Failed (exit ${run.code}): ${resolved.command}\n\n${run.output}`.trim(),
	};
}
