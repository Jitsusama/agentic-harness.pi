/**
 * What a reviewer's run answered, read off what its pi process returned.
 *
 * The final text, the usage, the verify_output outcome and the warnings
 * a caller acts on: a missing or failed verification, a non-zero exit
 * and the stderr line that explains it, a stale install, a dropped
 * stream. These change when what counts as an answer does.
 */

import { detectStaleInstallInStderr } from "./health.ts";
import { describeReviewerError } from "./reviewer-error.ts";
import type {
	ReviewerUsage,
	ReviewerVerification,
	RunPiResult,
	RunReviewerOptions,
	RunReviewerResult,
} from "./run-contract.ts";
import { ReviewerStreamParser } from "./stream.ts";

export function assembleReviewerResult(
	options: RunReviewerOptions,
	result: RunPiResult,
): RunReviewerResult {
	const parsed = extractRunPiOutput(result);
	const requiresVerification = options.requiresVerification === true;
	const verification =
		parsed.verification ??
		(requiresVerification
			? { called: false, ok: false, message: "verify_output was not called." }
			: undefined);
	const verificationMismatch = verificationStageMismatch(
		verification,
		options.expectedVerificationStage,
	);
	const verificationForResult = verificationMismatch
		? {
				...verificationMismatch.verification,
				ok: false,
				message: verificationMismatch.message,
			}
		: verification;
	const verified = verificationForResult?.ok
		? verifiedOutputText(
				verificationForResult.output,
				verificationForResult.outOfBand === true,
			)
		: null;
	const verifiedText = verified?.text ?? null;
	const hasRunnerCanonicalText =
		result.finalAssistantText !== undefined &&
		verificationForResult?.ok === true &&
		verificationForResult.canonicalText === true &&
		verificationForResult.output === undefined &&
		parsed.finalAssistantText.trim() !== "";
	const warnings = [...parsed.warnings];
	if (verified?.warning) warnings.push(verified.warning);
	if (verificationForResult?.warnings) {
		warnings.push(
			...verificationForResult.warnings.map(
				(warning) => `Reviewer verify_output warning: ${warning}`,
			),
		);
	}
	if (
		requiresVerification &&
		verifiedText === null &&
		!hasRunnerCanonicalText
	) {
		warnings.push(verificationFailureWarning(verificationForResult));
	}

	if (result.exitCode !== 0) {
		warnings.push(`Pi subprocess exited non-zero (exit ${result.exitCode})`);
		const stderrSnippet = summarizeStderr(parsed.stderr);
		if (stderrSnippet) {
			warnings.push(`Pi stderr: ${stderrSnippet}`);
		}
		// Defensive second layer: if the child's stderr
		// carries the canonical stale-install ENOENT shape,
		// add the actionable advisory so downstream summary
		// renderers can swap the per-reviewer retry hint for
		// a session-level "restart pi" message.
		const staleMessage = detectStaleInstallInStderr(parsed.stderr);
		if (staleMessage) warnings.push(staleMessage);
	}

	// A reviewer's final turn can die on a provider or
	// transport error while the child still exits 0. Name it
	// so the drop is not mistaken for a reviewer that simply
	// never verified, and carry it on the result so the
	// dispatcher can decide whether it is worth resuming.
	if (result.error) warnings.push(describeReviewerError(result.error));

	return {
		reviewerId: options.reviewer.id,
		exitCode: result.exitCode,
		finalAssistantText:
			requiresVerification && verifiedText === null && !hasRunnerCanonicalText
				? ""
				: (verifiedText ?? parsed.finalAssistantText),
		stderr: parsed.stderr,
		warnings,
		sessionIds: parsed.sessionIds,
		...(result.state ? { state: result.state } : {}),
		...(parsed.usage ? { usage: parsed.usage } : {}),
		...(verificationForResult
			? { verification: verificationWithoutOutput(verificationForResult) }
			: {}),
		// Carried whatever else happened, including a blanked answer:
		// what a reviewer wrote down is not conditional on it finishing.
		...(result.journal && result.journal.length > 0
			? { journal: result.journal }
			: {}),
		...(result.journalWarnings && result.journalWarnings.length > 0
			? { journalWarnings: result.journalWarnings }
			: {}),
		...(result.error ? { error: result.error } : {}),
	};
}

interface ExtractedRunPiOutput {
	readonly finalAssistantText: string;
	readonly usage?: ReviewerUsage;
	readonly sessionIds: readonly string[] | null;
	readonly warnings: readonly string[];
	readonly stderr: string;
	readonly verification?: ReviewerVerification;
}

function extractRunPiOutput(result: RunPiResult): ExtractedRunPiOutput {
	if (result.finalAssistantText !== undefined) {
		return {
			finalAssistantText: result.finalAssistantText,
			...(result.usage ? { usage: result.usage } : {}),
			sessionIds: result.sessionIds ?? null,
			warnings: result.warnings ?? [],
			stderr: result.stderrTail ?? result.stderr ?? "",
			...(result.verification ? { verification: result.verification } : {}),
		};
	}
	const parser = new ReviewerStreamParser();
	parser.ingestChunk(result.stdout ?? "");
	const parsed = parser.finish();
	return {
		finalAssistantText: parsed.finalAssistantText,
		...(parsed.usage ? { usage: parsed.usage } : {}),
		sessionIds: result.sessionIds ?? parsed.sessionIds,
		warnings: [...(result.warnings ?? []), ...parsed.warnings],
		stderr: result.stderrTail ?? result.stderr ?? "",
		...((result.verification ?? parsed.verification)
			? { verification: result.verification ?? parsed.verification }
			: {}),
	};
}

function verificationStageMismatch(
	verification: ReviewerVerification | undefined,
	expected: string | undefined,
): { verification: ReviewerVerification; message: string } | null {
	if (verification?.ok !== true || expected === undefined) return null;
	if (verification.stage === expected) return null;
	const actual = verification.stage ?? "missing";
	return {
		verification,
		message:
			"Reviewer output ignored because verify_output used the wrong stage " +
			`(${actual}); expected ${expected}.`,
	};
}

const MAX_VERIFIED_OUTPUT_BYTES = 512 * 1024;

function verifiedOutputText(
	output: unknown,
	outOfBand = false,
): { readonly text: string | null; readonly warning?: string } | null {
	if (output === undefined) return null;
	const text = JSON.stringify(output, null, 2);
	// Out-of-band output already travelled on a file, past
	// every stream and text cap on purpose. Re-truncating it
	// here would resurrect the very failure the file avoids,
	// so a trusted payload passes through whole.
	if (outOfBand) return { text };
	return truncateBytes(text, MAX_VERIFIED_OUTPUT_BYTES);
}

function verificationWithoutOutput(
	verification: ReviewerVerification,
): ReviewerVerification {
	const { output: _output, ...rest } = verification;
	return rest;
}

function truncateBytes(
	text: string,
	maxBytes: number,
): { readonly text: string | null; readonly warning?: string } {
	if (Buffer.byteLength(text) <= maxBytes) return { text };
	return {
		text: null,
		warning: `Reviewer verified output exceeded ${maxBytes} bytes; ignored`,
	};
}

function verificationFailureWarning(
	verification: ReviewerVerification | undefined,
): string {
	if (verification === undefined || !verification.called) {
		return "Reviewer output ignored because verify_output was not called.";
	}
	if (verification.ok && verification.output === undefined) {
		return "Reviewer output ignored because verify_output returned ok: true but the verified payload was not captured.";
	}
	if (verification.message?.startsWith("Reviewer output ignored")) {
		return verification.message;
	}
	const suffix = verification.message ? ` ${verification.message}` : "";
	return `Reviewer output ignored because verify_output did not return ok: true.${suffix}`;
}

const STDERR_SNIPPET_MAX = 240;

/**
 * Trim pi's stderr down to something fit for inline
 * warning display. Keeps the first non-empty line so
 * common errors like `Error: Model "..." not found.`
 * surface without dumping a full traceback at the user.
 */
function summarizeStderr(stderr: string): string {
	if (!stderr) return "";
	const lines = stderr.split(/\r?\n/);
	// A node child crash leads with an internal frame
	// ("node:internal/child_process:420") and buries the
	// actionable line (an errno like E2BIG, or an "Error:"
	// message) a few lines down. Prefer the meaningful line
	// so a spawn failure names its own cause instead of
	// making the caller guess.
	for (const line of lines) {
		const trimmed = line.trim();
		if (isMeaningfulStderrLine(trimmed)) {
			return truncate(trimmed, STDERR_SNIPPET_MAX);
		}
	}
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return truncate(trimmed, STDERR_SNIPPET_MAX);
	}
	return "";
}

/**
 * A stderr line that explains a failure: a system errno, a
 * node error code, or an "Error:" message. Internal V8 or
 * node frames and caret markers are not meaningful.
 */
function isMeaningfulStderrLine(line: string): boolean {
	if (!line || line === "^") return false;
	if (line.startsWith("at ") || line.startsWith("node:internal/")) return false;
	return (
		/\b(E2BIG|EMFILE|ENFILE|ENOENT|EACCES|ENOMEM|EAGAIN|ENOSPC|EPIPE)\b/.test(
			line,
		) ||
		/\bERR_[A-Z0-9_]+\b/.test(line) ||
		/\berrno\b/i.test(line) ||
		/^(?:[\w.]*Error)\b/.test(line)
	);
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
