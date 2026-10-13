/**
 * Verification Workflow extension.
 *
 * Closes the trust gap after an edit without stalling an
 * autonomous run. Three moments:
 *
 *   Fast layer, at the turn boundary. When the agent is about
 *   to yield, it asks the resident LSP backend for diagnostics
 *   on the files touched this run. New error-severity problems
 *   are enqueued as a follow-up so the agent continues and
 *   self-corrects before handing the turn to the user. It caps
 *   its fix requests so it never thrashes.
 *
 *   Medium layer, on request. The verify tool runs the
 *   project's resolved check command, in the project the work
 *   is in, when the user asks whether the code still builds or
 *   passes.
 *
 *   At a commit. The commit guardian asks whether anything is
 *   failing, and the answer is checked then, in the repository
 *   the commit lands in: the files that last had errors are
 *   diagnosed again, and a failed check run counts only while
 *   the tree is the one it judged. Nothing stored is trusted.
 *
 * No slash command and nothing runs after every edit: the
 * loop acts at the turn boundary, at a commit, and when the
 * agent is asked.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveLspBackend } from "@jitsusama/agentic-harness.core/lsp";
import { findProject, runVerify } from "@jitsusama/agentic-harness.core/verify";
import { Type } from "@sinclair/typebox";
import { getLastEntry } from "../../lib/internal/state.ts";
import {
	provideVerificationCheck,
	type VerificationCheck,
} from "../../lib/internal/verification/signal.ts";
import {
	checkRunVerdict,
	fastLayerVerdict,
} from "../../lib/verification/index.ts";
import { currentFailure, settle } from "./current.ts";
import { collectErrors, rememberChecked } from "./diagnostics.ts";
import {
	createVerificationState,
	FAST_LAYER_WALL_MS,
	MAX_FIX_ATTEMPTS,
	type VerificationState,
} from "./state.ts";
import { directoryOf, treeFingerprint, within } from "./tree.ts";

const STATUS_KEY = "verification-workflow";
/** Files the LSP fast layer can serve today. */
const SYNCABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export default function verificationWorkflow(pi: ExtensionAPI) {
	const state = createVerificationState();
	let ctxRef: ExtensionContext | null = null;

	// Answer the commit guardian's question freshly each time it asks.
	const check: VerificationCheck = async (scope) => {
		const failure = await currentFailure(state, scope, resolveLspBackend());
		if (state.outcome === "failing" || failure) state.outcome = settle(state);
		if (ctxRef) refreshStatus(ctxRef, state);
		return failure;
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		provideVerificationCheck(check);
		refreshStatus(ctx, state);
	});

	pi.on("session_shutdown", async () => {
		// The next session offers its own; a stale one would answer for
		// state nobody is keeping any more.
		provideVerificationCheck(undefined);
	});

	// Collect the files pi changed this turn.
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = event.input.path;
		if (typeof path !== "string") return;
		const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
		state.touched.add(absolute);
		state.lastEdited = absolute;
		// An edit under a failed run's project means the run judged a
		// tree that no longer exists.
		if (state.failedRun && within(state.failedRun.root, absolute)) {
			state.failedRun = undefined;
		}
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

		// Read the run now: the context answers with whichever run is
		// current when asked.
		const run = ctx.signal;
		const result = await collectErrors(backend, files, run, FAST_LAYER_WALL_MS);
		rememberChecked(state, result);
		if (run?.aborted) {
			// Stopped by the person, so nothing was checked and nobody
			// wants the agent to carry on with a fix.
			state.outcome = "deferred";
			refreshStatus(ctx, state);
			return;
		}
		const { errors, failed } = result;
		const verdict = fastLayerVerdict({
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
		state.attempts = 0;
		state.pending = [];
		if (verdict.action === "giveUp") {
			// Stop nagging and let the run end so the user sees the
			// agent's last word; the status line still shows failing,
			// and a commit still re-checks what it gave up on.
			state.outcome = "failing";
		} else {
			// When the server errored for a touched file, "no errors" is
			// not "checked clean", so it reads deferred unless something
			// else is known to be failing.
			const settled = settle(state);
			state.outcome = failed && settled === "clean" ? "deferred" : settled;
		}
		refreshStatus(ctx, state);
	});

	pi.registerTool({
		name: "verify",
		label: "Verify",
		description:
			"Run the project's verification check command (lint, typecheck, " +
			"test) and report whether the code still builds and passes. It " +
			"checks the project holding the file edited most recently, or the " +
			"one `path` names. Use this when asked whether something works, " +
			"still builds, or is green.",
		promptSnippet:
			"When asked whether the code still builds or passes, run the verify " +
			"tool rather than guessing.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"A file or directory in the project to check. Defaults to the " +
						"project holding the file edited most recently, else the " +
						"session's directory.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<VerifyDetails>> {
			const dir = verifyDirectory(params.path, state.lastEdited);
			const root = findProject(dir)?.dir ?? dir;
			const questVerify = ctxRef
				? (getLastEntry<{ verify?: string | null }>(ctxRef, "quest-workflow")
						?.verify ?? undefined)
				: undefined;
			const result = await runVerify({
				cwd: dir,
				...(questVerify ? { questVerify } : {}),
				...(signal ? { signal } : {}),
			});
			const verdict = checkRunVerdict(result);
			if (verdict.outcome === "failing" && result.command) {
				const fingerprint = treeFingerprint(root);
				state.failedRun = {
					root,
					command: result.command,
					...(fingerprint ? { fingerprint } : {}),
				};
			} else if (
				verdict.outcome === "clean" &&
				state.failedRun?.root === root
			) {
				state.failedRun = undefined;
			}
			// A check that could not start leaves what else is known as it
			// was; with nothing else known it says nothing was checked.
			const settled = settle(state);
			state.outcome =
				verdict.outcome === "deferred" && settled === "clean"
					? "deferred"
					: settled;
			if (ctxRef) refreshStatus(ctxRef, state);
			const said =
				verdict.outcome === "deferred"
					? `Checked nothing in ${root}: ${verdict.reason}. This says ` +
						`nothing about the code.\n\n${result.output}`
					: `In ${root}:\n${result.output}`;
			return {
				content: [{ type: "text", text: said }],
				details: {
					ok: result.ok,
					outcome: verdict.outcome,
					dir: root,
					...(result.command ? { command: result.command } : {}),
				},
			};
		},
	});
}

interface VerifyDetails {
	readonly ok: boolean;
	readonly outcome: "clean" | "failing" | "deferred";
	readonly dir: string;
	readonly command?: string;
}

/**
 * Where verify runs: the path it was handed, else where the last edit
 * landed, else the session's directory. The session's directory is the
 * last resort because it is often not where the work is: a worktree
 * sits elsewhere, and the checkout it was cut from may have no
 * dependencies installed at all.
 */
function verifyDirectory(
	given: string | undefined,
	lastEdited: string | undefined,
): string {
	if (given) {
		const expanded =
			given === "~"
				? homedir()
				: given.startsWith("~/")
					? join(homedir(), given.slice(2))
					: given;
		return directoryOf(resolve(process.cwd(), expanded));
	}
	if (lastEdited) return directoryOf(lastEdited);
	return process.cwd();
}

function refreshStatus(ctx: ExtensionContext, state: VerificationState): void {
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
					? theme.fg("muted", "verify (deferred)")
					: undefined;
	ctx.ui.setStatus(STATUS_KEY, label);
}
