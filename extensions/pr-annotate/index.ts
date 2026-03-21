/**
 * PR Annotate Extension
 *
 * Tool for the LLM to propose self-review comments on a PR.
 * The user vets each comment through the shared gate:
 * approve, edit, reject, or steer. Only approved comments
 * are posted as a single PR review via `gh api`.
 *
 * Supports multi-round flows: if the user adds comments
 * via natural language, the tool returns them for the LLM
 * to resolve. Previously approved comments are passed back
 * with `preApproved: true` and skip vetting on the next call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { fetchDiff, parseDiff } from "../lib/github/diff.js";
import { getCurrentRepo } from "../lib/github/repo-discovery.js";
import type { PRReference } from "../lib/parse/pr-reference.js";
import { postReview } from "./post.js";
import { vetComments } from "./vet.js";

const CommentSchema = Type.Object({
	path: Type.String({ description: "File path relative to repo root" }),
	line: Type.Number({
		description: "End line number in the diff to comment on",
	}),
	startLine: Type.Optional(
		Type.Number({
			description: "Start line number for a multi-line comment range",
		}),
	),
	body: Type.String({ description: "The review comment text" }),
	rationale: Type.String({
		description: "Why this is worth flagging (shown to user only, not posted)",
	}),
	side: Type.Optional(
		Type.String({
			description: "Side of the diff: LEFT or RIGHT (default: RIGHT)",
		}),
	),
	preApproved: Type.Optional(
		Type.Boolean({
			description: "If true, skip vetting: already approved in a prior round",
		}),
	),
});

const PrReviewParams = Type.Object({
	pr: Type.Number({ description: "Pull request number" }),
	repo: Type.Optional(
		Type.String({
			description: "Repository in owner/repo format. Defaults to current repo.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"Summary body for the review. Brief context about what the review comments cover.",
		}),
	),
	comments: Type.Array(CommentSchema, {
		description:
			"Candidate review comments. May be empty if nothing warrants attention: the user can still add their own.",
	}),
});

export interface ReviewComment {
	path: string;
	line: number;
	startLine?: number;
	body: string;
	rationale: string;
	side: string;
}

export interface VetResult {
	approved: ReviewComment[];
	rejected: number;
	edited: number;
	steerFeedback?: string;
	userRequests: string[];
}

function formatCommentRef(c: ReviewComment): string {
	const range = c.startLine ? `${c.startLine}-${c.line}` : `${c.line}`;
	return `- ${c.path}:${range}: ${c.body}`;
}

/** Fetch and parse the PR diff for workspace context. */
async function fetchPRDiff(pi: ExtensionAPI, pr: number, repo?: string) {
	try {
		let ref: PRReference;
		if (repo) {
			const parts = repo.split("/");
			ref = { owner: parts[0] ?? "", repo: parts[1] ?? "", number: pr };
		} else {
			const current = await getCurrentRepo(pi);
			if (!current) return [];
			ref = { owner: current.owner, repo: current.repo, number: pr };
		}

		const diff = await fetchDiff(pi, ref);
		return parseDiff(diff);
	} catch {
		/* Diff fetch failed: workspace will show without diff context */
		return [];
	}
}

export default function prAnnotate(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pr_annotate",
		label: "PR Annotate",
		description:
			"Propose self-review comments on a pull request for the user to vet before posting. " +
			"Call this as part of PR creation to flag areas of possible contention, deviations " +
			"from what was originally asked, scope questions, or design decisions worth reviewer input. " +
			"The comments array may be empty if nothing warrants attention: the user can still add their own.",
		promptGuidelines: [
			"Call `pr_annotate` after creating a PR to propose self-review comments.",
			"Focus on: design decisions worth explaining, assumptions that need validation, " +
				"scope boundaries reviewers should weigh in on, and deviations from the original plan.",
			"Do NOT flag: style issues, obvious code, or things the diff already makes clear.",
			"The rationale field is for the user only: explain why you think this is worth flagging.",
			"It is fine to pass an empty comments array if nothing warrants reviewer attention.",
			"The body field is a brief summary for the review itself: it appears as the review header in GitHub.",
			"If the tool returns user requests, resolve each into a structured comment (path, line, body) " +
				"and call pr_annotate again with the previously approved comments plus the new ones.",
			"If posting fails, the approved comments are returned: fix the issue and retry with the same comments.",
			"Be concise in your review comment body: explain why you think this is worth flagging.",
			"The line range is the most important part of a review comment: it frames what the reviewer " +
				"sees before they read a word. Read your comment body, identify the specific code it " +
				"discusses and select exactly those lines. A comment about validation logic must highlight " +
				"the validation code, not the function signature above it.",
			"Scope the range tightly: a naming concern → single declaration line; a logic concern → the " +
				"conditional block; a design decision → the function or type embodying it. Don't select " +
				"20 lines when the comment is about 3.",
			"Use a single line (no startLine) only when the comment is about one line. " +
				"For anything structural, use startLine + line to show the full relevant construct.",
			"When calling again with previously approved comments, set preApproved: true on each to skip re-vetting.",
		],
		parameters: PrReviewParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "Error: pr_annotate requires interactive mode",
						},
					],
					details: { pr: params.pr, posted: 0 },
				};
			}

			// We split the comments into pre-approved and new ones.
			const preApproved: ReviewComment[] = [];
			const toVet: ReviewComment[] = [];

			for (const c of params.comments) {
				const comment: ReviewComment = {
					path: c.path,
					line: c.line,
					startLine: c.startLine,
					body: c.body,
					rationale: c.rationale,
					side: c.side || "RIGHT",
				};
				if (c.preApproved) {
					preApproved.push(comment);
				} else {
					toVet.push(comment);
				}
			}

			// We fetch the diff for workspace context.
			const diffFiles = await fetchPRDiff(pi, params.pr, params.repo);

			const result = await vetComments(
				toVet,
				preApproved.length,
				ctx,
				diffFiles,
			);

			if (!result) {
				return {
					content: [{ type: "text", text: "Review cancelled." }],
					details: { pr: params.pr, posted: 0, cancelled: true },
				};
			}

			// We combine pre-approved with newly approved comments.
			const allApproved = [...preApproved, ...result.approved];

			if (result.steerFeedback) {
				const parts = [
					`User feedback on review comments:\n\n${result.steerFeedback}`,
				];
				if (allApproved.length > 0) {
					parts.push("");
					parts.push(
						"Already approved (include with preApproved: true on next call):",
					);
					parts.push(...allApproved.map(formatCommentRef));
				}
				return {
					content: [{ type: "text", text: parts.join("\n") }],
					details: { pr: params.pr, posted: 0, steered: true },
				};
			}

			// The user requested additional comments, so we return them for the LLM to resolve.
			if (result.userRequests.length > 0) {
				const requests = result.userRequests
					.map((r, i) => `${i + 1}. ${r}`)
					.join("\n");
				const parts = [
					`The user wants these additional review comments on PR #${params.pr}.`,
					`Resolve each into a structured comment (path, startLine, line, body) and call pr_annotate again`,
					`with both the previously approved comments (set preApproved: true) and the new ones.`,
					"",
					"Already approved (include with preApproved: true):",
					...allApproved.map(formatCommentRef),
					"",
					"User requests (resolve these into new comments):",
					requests,
				];
				return {
					content: [{ type: "text", text: parts.join("\n") }],
					details: {
						pr: params.pr,
						posted: 0,
						approvedComments: allApproved,
						userRequests: result.userRequests,
					},
				};
			}

			if (allApproved.length === 0) {
				return {
					content: [
						{ type: "text", text: "No comments approved for posting." },
					],
					details: { pr: params.pr, posted: 0 },
				};
			}

			const postResult = await postReview(
				pi,
				params.pr,
				allApproved,
				params.body,
				params.repo,
			);

			if (postResult.error) {
				return {
					content: [
						{
							type: "text",
							text:
								`Failed to post review: ${postResult.error}\n\n` +
								`The following approved comments were not posted. ` +
								`Fix the issue and call pr_annotate again with these comments (set preApproved: true):\n` +
								allApproved.map(formatCommentRef).join("\n"),
						},
					],
					details: {
						pr: params.pr,
						posted: 0,
						error: postResult.error,
						approvedComments: allApproved,
					},
				};
			}

			const summary = [
				`Posted ${allApproved.length} review comment(s) on PR #${params.pr}.`,
				result.rejected > 0 ? ` ${result.rejected} rejected.` : "",
				result.edited > 0 ? ` ${result.edited} edited.` : "",
			].join("");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					pr: params.pr,
					posted: allApproved.length,
					rejected: result.rejected,
					edited: result.edited,
				},
			};
		},

		renderCall(args, theme) {
			const comments = Array.isArray(args.comments) ? args.comments : [];
			const newCount = comments.filter(
				(c: { preApproved?: boolean }) => !c.preApproved,
			).length;
			const preCount = comments.filter(
				(c: { preApproved?: boolean }) => c.preApproved,
			).length;
			let text = theme.fg("toolTitle", theme.bold("pr_annotate "));
			text += theme.fg("muted", `PR #${args.pr}`);
			if (preCount > 0) {
				text += theme.fg("dim", ` · ${preCount} approved`);
			}
			if (newCount > 0) {
				text += theme.fg("accent", ` · ${newCount} to review`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Review cancelled"), 0, 0);
			}

			if (details.steered) {
				return new Text(theme.fg("accent", "↩ Steered"), 0, 0);
			}

			if (details.userRequests) {
				const count = (details.userRequests as string[]).length;
				return new Text(
					theme.fg(
						"accent",
						`↩ ${count} user request${count !== 1 ? "s" : ""} to resolve`,
					),
					0,
					0,
				);
			}

			const posted = details.posted as number;
			if (posted === 0) {
				return new Text(theme.fg("dim", "No comments posted"), 0, 0);
			}

			return new Text(
				theme.fg("success", "✓ ") +
					theme.fg(
						"muted",
						`${posted} comment${posted !== 1 ? "s" : ""} posted`,
					),
				0,
				0,
			);
		},
	});
}
