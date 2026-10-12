/**
 * Commit guardian review: presents the commit message for
 * approval with validation indicators, or in report mode puts the
 * same message and marks in the transcript and lets it run.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { readCommitFile } from "@jitsusama/agentic-harness.core/guardian/commit-file";
import {
	type CommitValidation,
	validate,
} from "@jitsusama/agentic-harness.core/guardian/commit-format";
import { runProseGate } from "@jitsusama/agentic-harness.core/guardian/prose-gate";
import {
	ALLOW,
	approvalUnder,
	type CommandGuardian,
	formatRedirectBlock,
	type GuardianResult,
	refusalUnder,
	reportGuard,
} from "../../lib/guardian/index.ts";
import { sessionGateDeps } from "../../lib/internal/gate/session-deps.ts";
import { GUARDS } from "../../lib/internal/guardian/guards.ts";
import { isVerificationFailing } from "../../lib/internal/verification/signal.ts";
import { promptSingle } from "../../lib/ui/index.ts";
import { extractMessage, isCommitCommand } from "./parse.ts";

const COMMIT_ACTIONS = [{ key: "r", label: "Reject" }];

interface CommitParsed {
	message: string;
	isAmend: boolean;
}

/**
 * Guardian that intercepts git commit commands and presents the
 * message for review.
 *
 * Built as a factory so the review closure can capture `pi` for
 * the prose gate's session-backed signature persistence.
 */
export function createCommitGuardian(
	pi: ExtensionAPI,
): CommandGuardian<CommitParsed> {
	return {
		detect(command) {
			return isCommitCommand(command);
		},

		parse(command) {
			// Resolve a `git commit -F <file>` too, so the gate still
			// sees the message even when the message lives in a file.
			const message = extractMessage(command, readCommitFile);
			if (!message) return null;

			const isAmend = /--amend\b/.test(command);
			return { message, isAmend };
		},

		async review(
			parsed: CommitParsed,
			ctx: ExtensionContext,
			mode = "block",
		): Promise<GuardianResult> {
			// Refuse a commit while verification reports the code is
			// failing. The guard has its own name, so when the block is
			// wrong or stale it can be switched without the commit panel.
			const failing = refusalUnder(
				GUARDS.commitVerification.name,
				isVerificationFailing()
					? {
							block: true,
							reason:
								"Verification reports errors in files changed this run. " +
								"Fix them before committing. If the report is wrong or " +
								"stale, ask the user to run `/guards commit-verification report`.",
						}
					: undefined,
				"Committed while verification reports errors",
			);
			if (failing) return failing;

			// Prose violations in the message body. prose-standard governs
			// commit body tone, spelling and punctuation even though
			// commit-format owns structure; the gate relents on a repeat.
			const proseBlock = refusalUnder(
				GUARDS.prose.name,
				runProseGate(sessionGateDeps(ctx, pi), parsed.message),
				"Commit message prose",
			);
			if (proseBlock) return proseBlock;

			if (mode === "report") {
				reportGuard({
					guard: GUARDS.commit.name,
					kind: "shown",
					title: parsed.isAmend ? "Amend Commit" : "Commit",
					body: commitReportBody(parsed.message, parsed.isAmend),
					notes: validationMarks(validate(parsed.message)).map((m) => m.text),
				});
				return ALLOW;
			}

			// While the person is away the commit is held for their return
			// rather than waiting on a panel. Nothing is committed.
			const approval = approvalUnder(
				GUARDS.commit.name,
				parsed.isAmend ? "Amend Commit" : "Commit",
				() => commitReportBody(parsed.message, parsed.isAmend),
			);
			if (approval.kind === "go") return ALLOW;
			if (approval.kind === "held")
				return { block: true, reason: approval.reason };

			// Without a UI the gate has done its job and there is no
			// panel to show; allow rather than block so headless and
			// subagent commits are gated, not stalled.
			if (!ctx.hasUI) return ALLOW;

			const result = await promptSingle(ctx, {
				title: parsed.isAmend ? "Amend Commit" : "Commit",
				content: renderCommitContent(parsed.message, parsed.isAmend),
				actions: COMMIT_ACTIONS,
			});

			if (!result) {
				return {
					block: true,
					reason: "User cancelled the commit review.",
				};
			}

			if (result.type === "redirect") {
				return formatRedirectBlock(
					result.note,
					`Original commit:\n${parsed.message}`,
				);
			}

			if (result.type === "action") {
				// Reject
				if (result.key === "r") {
					if (result.note) {
						return formatRedirectBlock(
							result.note,
							`Original commit:\n${parsed.message}`,
						);
					}
					return {
						block: true,
						reason:
							"User rejected the commit. Ask for guidance on the commit description.",
					};
				}

				// Enter (approve)
				if (result.note) {
					return formatRedirectBlock(
						result.note,
						`Original commit:\n${parsed.message}`,
					);
				}
				return ALLOW;
			}
		},
	};
}

/** One validation mark: whether it passed and what it says. */
interface ValidationMark {
	ok: boolean;
	text: string;
}

/** The validation results as marks, shared by the panel and the report. */
export function validationMarks(v: CommitValidation): ValidationMark[] {
	const marks: ValidationMark[] = [
		v.subjectOk
			? { ok: true, text: `✓ ${v.subjectLength} chars` }
			: { ok: false, text: `⚠ ${v.subjectLength} chars (limit: 50)` },
	];
	if (v.bodyLongestLine > 0) {
		marks.push(
			v.bodyWrapOk
				? { ok: true, text: "✓ wrap" }
				: {
						ok: false,
						text: `⚠ line ${v.bodyLongestLineNum}: ${v.bodyLongestLine} chars`,
					},
		);
	}
	marks.push(
		v.conventionalOk
			? { ok: true, text: "✓ conventional" }
			: { ok: false, text: "⚠ not conventional" },
	);
	return marks;
}

/** The commit message as report markdown, fenced so it reads verbatim. */
export function commitReportBody(message: string, isAmend: boolean): string {
	const fenced = `\`\`\`text\n${message.trimEnd()}\n\`\`\``;
	return isAmend ? `${fenced}\n\nAmends the previous commit.` : fenced;
}

/** Render validation as a compact indicator line. */
function renderValidation(v: CommitValidation, theme: Theme): string {
	const dot = theme.fg("dim", " · ");
	const parts = validationMarks(v).map((m) =>
		theme.fg(m.ok ? "success" : "warning", m.text),
	);
	return ` ${parts.join(dot)}`;
}

/** Render a commit message as gate content lines. */
function renderCommitContent(
	message: string,
	isAmend: boolean,
): (theme: Theme, width: number) => string[] {
	const lines = message.split("\n");
	const subject = lines[0] || "";
	const bodyLines = lines.length > 2 ? lines.slice(2) : [];
	const validation = validate(message);

	return (theme, _width) => {
		const out: string[] = [];

		out.push(theme.fg("text", ` ${subject}`));

		if (bodyLines.length > 0) {
			out.push("");
			for (const line of bodyLines) {
				out.push(` ${theme.fg("text", line)}`);
			}
		}

		if (isAmend) {
			out.push("");
			out.push(theme.fg("warning", " ⚠ Amends previous commit"));
		}

		out.push("");
		out.push(renderValidation(validation, theme));

		return out;
	};
}
