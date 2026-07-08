/**
 * Verification Workflow extension.
 *
 * Closes the trust gap after an edit without stalling an
 * autonomous run. Two cadences:
 *
 *   Fast layer, at the turn boundary. When the agent is about
 *   to yield, it asks the resident LSP backend for diagnostics
 *   on the files touched this run. New error-severity problems
 *   are enqueued as a follow-up so the agent continues and
 *   self-corrects before handing the turn to the user. It
 *   defers entirely while a TDD loop is active, and caps its
 *   fix requests so it never thrashes.
 *
 *   Medium layer, on request. The no-command verify tool runs
 *   the project's resolved check command when the user asks
 *   whether the code still builds or passes.
 *
 * No slash command and nothing runs after every edit: the
 * loop acts at the turn boundary and when the agent is asked.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getLastEntry } from "../../lib/internal/state.js";
import { setVerificationFailing } from "../../lib/internal/verification/signal.js";
import { resolveLspBackend } from "../../lib/lsp/index.js";
import {
	type FileError,
	fastLayerVerdict,
	resolveCheckCommand,
} from "../../lib/verification/index.js";
import {
	createVerificationState,
	MAX_FIX_ATTEMPTS,
	type VerificationState,
} from "./state.js";

const STATUS_KEY = "verification-workflow";
/** Files the LSP fast layer can serve today. */
const SYNCABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** How long a medium-layer check command may run. */
const CHECK_TIMEOUT_MS = 300_000;
/** Cap on captured check output held in memory (a rolling tail). */
const MAX_CAPTURE_BYTES = 512 * 1024;

export default function verificationWorkflow(pi: ExtensionAPI) {
	const state = createVerificationState();
	let ctxRef: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		refreshStatus(ctx, state);
	});

	// Collect the files pi changed this turn.
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = event.input.path;
		if (typeof path !== "string") return;
		state.touched.add(isAbsolute(path) ? path : resolve(process.cwd(), path));
	});

	// Fast layer: when the agent is about to yield (a terminal
	// turn that ran no tools, so the loop is about to stop), run
	// the resident LSP over the files touched this run plus any
	// still-outstanding ones. On new error-severity problems,
	// enqueue the fix as a follow-up. pi.sendUserMessage with
	// deliverAs "followUp" feeds the loop's follow-up queue, which
	// it drains immediately after this event and before it ends
	// the run (turn_end is emitted just ahead of the follow-up
	// drain), so the agent continues and self-corrects before the
	// turn returns to the user.
	pi.on("turn_end", async (event, ctx) => {
		ctxRef = ctx;
		// A turn that executed tools loops again on its own; only
		// verify when the assistant is about to stop. An errored or
		// aborted turn is not a clean yield worth checking.
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (event.toolResults.length > 0) return;
		if (stopReason === "error" || stopReason === "aborted") return;

		const watched = new Set<string>(state.pending.map((e) => e.path));
		for (const p of state.touched) watched.add(p);
		state.touched.clear();
		const files = [...watched].filter((p) => SYNCABLE.test(p));

		const backend = resolveLspBackend();
		if (!backend || files.length === 0) {
			refreshStatus(ctx, state);
			return;
		}

		const { errors, failed } = await collectErrors(backend, files);
		const tddPhase =
			getLastEntry<{ phase?: string }>(ctx, "tdd-workflow")?.phase ?? "idle";
		const verdict = fastLayerVerdict({
			tddPhase,
			attempts: state.attempts,
			maxAttempts: MAX_FIX_ATTEMPTS,
			errors,
		});

		if (verdict.action === "inject") {
			state.attempts = verdict.attempt;
			state.pending = [...errors];
			state.outcome = "failing";
			refreshStatus(ctx, state);
			// Continue the run so the agent fixes this before yielding.
			pi.sendUserMessage(verdict.message, { deliverAs: "followUp" });
			return;
		}
		if (verdict.action === "giveUp") {
			// Stop nagging and let the run end so the user sees the
			// agent's last word; the status line still shows failing.
			state.attempts = 0;
			state.pending = [];
			state.outcome = "failing";
		} else if (verdict.reason.includes("TDD")) {
			state.outcome = "deferred";
		} else if (failed) {
			// The server errored for the touched files, so "no errors"
			// is not "checked clean": report deferred rather than lie
			// green and unblock a commit on unchecked code.
			state.attempts = 0;
			state.pending = [];
			state.outcome = "deferred";
		} else {
			state.attempts = 0;
			state.pending = [];
			state.outcome = "clean";
		}
		refreshStatus(ctx, state);
	});

	pi.registerTool({
		name: "verify",
		label: "Verify",
		description:
			"Run the project's verification check command (lint, typecheck, " +
			"test) and report whether the code still builds and passes. Use " +
			"this when asked whether something works, still builds, or is green.",
		promptSnippet:
			"When asked whether the code still builds or passes, run the verify " +
			"tool rather than guessing.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId,
			_params,
			signal,
		): Promise<AgentToolResult<VerifyDetails>> {
			const project = findProject(process.cwd());
			const questVerify = ctxRef
				? (getLastEntry<{ verify?: string | null }>(ctxRef, "quest-workflow")
						?.verify ?? undefined)
				: undefined;
			const resolved = resolveCheckCommand({
				questVerify: questVerify ?? undefined,
				packageScripts: project?.scripts ?? {},
				packageManager: project?.packageManager ?? "pnpm",
			});
			if (!resolved) {
				return {
					content: [
						{
							type: "text",
							text: "No verification command found (no lint, typecheck, test or verify script).",
						},
					],
					details: { ok: false },
				};
			}
			const run = await runCommand(
				resolved.command,
				project?.dir ?? process.cwd(),
				signal,
			);
			if (ctxRef) {
				state.outcome = run.code === 0 ? "clean" : "failing";
				refreshStatus(ctxRef, state);
			}
			// A passing run needs only its summary; a failing one keeps
			// the captured tail so the errors are there to act on.
			if (run.code === 0) {
				const tail = run.output.split("\n").slice(-12).join("\n").trim();
				return {
					content: [
						{
							type: "text",
							text: `Passed: ${resolved.command}\n\n${tail}`.trim(),
						},
					],
					details: { ok: true, command: resolved.command },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Failed (exit ${run.code}): ${resolved.command}\n\n${run.output}`.trim(),
					},
				],
				details: { ok: false, command: resolved.command },
			};
		},
	});
}

interface VerifyDetails {
	readonly ok: boolean;
	readonly command?: string;
}

interface DiagnosticsResult {
	readonly errors: FileError[];
	/** True when a diagnostics call threw, so "no errors" is not "checked clean". */
	readonly failed: boolean;
}

async function collectErrors(
	backend: { diagnostics: (path: string) => Promise<readonly unknown[]> },
	files: readonly string[],
): Promise<DiagnosticsResult> {
	const errors: FileError[] = [];
	let failed = false;
	for (const path of files) {
		let diagnostics: readonly unknown[];
		try {
			diagnostics = await backend.diagnostics(path);
		} catch {
			// The server errored for a file it was expected to serve.
			// Remember that so the caller does not report "clean" for a
			// check that never actually ran.
			failed = true;
			continue;
		}
		for (const raw of diagnostics) {
			const d = raw as {
				severity?: string;
				message?: string;
				range?: { start?: { line?: number; character?: number } };
			};
			if (d.severity !== "error") continue;
			errors.push({
				path,
				line: d.range?.start?.line ?? 1,
				character: d.range?.start?.character ?? 0,
				message: d.message ?? "error",
			});
		}
	}
	return { errors, failed };
}

interface ProjectInfo {
	readonly dir: string;
	readonly scripts: Readonly<Record<string, string>>;
	readonly packageManager: string;
}

function findProject(startDir: string): ProjectInfo | null {
	let dir = startDir;
	while (true) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
					scripts?: Record<string, string>;
				};
				return {
					dir,
					scripts: pkg.scripts ?? {},
					packageManager: detectPackageManager(dir),
				};
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function detectPackageManager(dir: string): string {
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(dir, "yarn.lock"))) return "yarn";
	if (existsSync(join(dir, "package-lock.json"))) return "npm";
	return "pnpm";
}

interface CommandResult {
	readonly code: number;
	readonly output: string;
}

/**
 * Strip ANSI escape sequences (colour and cursor control) from
 * captured output. A test runner emits these even into a pipe, and
 * left in the returned text they smear the TUI when the result is
 * rendered.
 */
// ESC[ control sequences (colour, cursor) and ESC] ... BEL (OSC).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires the ESC and BEL control bytes.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
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
		// pi's screen and clobber the status line; the pipes are still
		// captured here. The environment forces plain, non-interactive
		// output so nothing tries cursor control in the first place.
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

/** Cap the captured output so a noisy suite does not flood the turn. */
function truncate(output: string, maxLines = 200): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) return output.trim();
	return [
		`... (${lines.length - maxLines} earlier lines omitted)`,
		...lines.slice(lines.length - maxLines),
	]
		.join("\n")
		.trim();
}

function refreshStatus(ctx: ExtensionContext, state: VerificationState): void {
	// Publish the outcome so the commit guardian can refuse a
	// commit while checks are red. Only a definite failing verdict
	// blocks; deferred and unknown leave the signal clear.
	setVerificationFailing(state.outcome === "failing");
	const theme = ctx.ui.theme;
	const label =
		state.outcome === "clean"
			? theme.fg("success", "verify \u2713")
			: state.outcome === "failing"
				? theme.fg(
						"error",
						`verify \u2717${state.attempts ? ` ${state.attempts}/${MAX_FIX_ATTEMPTS}` : ""}`,
					)
				: state.outcome === "deferred"
					? theme.fg("muted", "verify (tdd)")
					: undefined;
	ctx.ui.setStatus(STATUS_KEY, label);
}
