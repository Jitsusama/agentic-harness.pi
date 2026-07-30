/**
 * What a participant is told.
 *
 * The prose here is deliberately about how to review rather than
 * about JSON. The output contract belongs in a skill loaded into the
 * subagent, because a contract repeated in two places drifts, and
 * the one in the prompt is the copy nobody updates.
 *
 * What the prompt owes the reviewer is the material: the change, its
 * body, the diff, and where an anchor is allowed to land. That last
 * one is why this module exists rather than the prompt being a
 * template string at the call site.
 */

import type { Proposal } from "../change.js";
import type { DiffModel } from "../diff.js";
import { filePath, hunkHeader } from "../diff.js";
import { anchorableRanges, describeRanges } from "./anchorable.js";

/**
 * How a discovery round closes.
 *
 * It names the contract skill rather than restating it, and it does not
 * promise a verify tool: nothing in this path attaches one, and telling
 * a reviewer to call a tool it cannot see spends a turn on a failed
 * lookup and teaches it to distrust the rest of the prompt.
 */
const ANSWER_AS_CONTRACTED =
	"Answer in the JSON your output contract skill describes. A pass with nothing to say answers with an empty findings list rather than prose.";

/** What a round needs to say to whoever it asks. */
export interface PromptInput {
	proposal: Proposal;
	diff: DiffModel;
	/** Extra direction for this round only. */
	intent?: string;
}

/** What a judge needs, on top of the change itself. */
export interface JudgePromptInput extends PromptInput {
	/** What the reviewers said, rendered for the judge to weigh. */
	findings: string;
}

/** The prompt a discovery reviewer answers. */
export function councilPrompt(input: PromptInput): string {
	return [
		"You are one of several reviewers reading the same change independently. Your pass is for discovery: find what is worth saying, and say why you believe it. Another pass will consolidate, and a third will push back, so a finding you are unsure of is still worth raising as long as the uncertainty comes with the evidence that would settle it.",
		"Read the change below, then use your tools on the tree to check what the diff cannot tell you: who calls this, what the tests around it assume, whether the library really behaves the way the code expects. A finding grounded in something you went and read is worth ten that restate the diff.",
		"Cover correctness, security, performance, interface design, readability, test quality and naming. Say where each finding points and what the consequence is. Do not describe what the diff already shows.",
		anchorGuidance(input.diff),
		intentSection(input.intent),
		changeSection(input.proposal),
		diffSection(input.diff),
		ANSWER_AS_CONTRACTED,
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** The prompt a consolidating judge answers. */
export function judgePrompt(input: JudgePromptInput): string {
	return [
		"Several reviewers read this change independently and raised the findings below. Your pass is consolidation: decide what is real, merge what is the same observation in different words, and drop what does not survive contact with the code.",
		"Agreement between reviewers who could not see each other's work is evidence, so record it: when you merge several into one, name the reviewer ids that raised it in raisedBy. That is how a reader later knows a finding was found twice rather than once.",
		"Be willing to drop a finding entirely. A reviewer that misread the code, or flagged a risk the surrounding code already handles, produced a finding that would waste the author's time. Check the ones that matter against the tree before you keep them.",
		anchorGuidance(input.diff),
		intentSection(input.intent),
		changeSection(input.proposal),
		"## What the reviewers said",
		input.findings.trim() === ""
			? "(nothing was raised, so there is nothing to consolidate)"
			: input.findings.trim(),
		diffSection(input.diff),
		"Answer in the JSON your output contract skill describes.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** What a critic needs: the findings, and leave to disagree. */
export interface CritiquePromptInput extends PromptInput {
	/** The findings put up for challenge, numbered as they will be cited. */
	findings: string;
}

/** The prompt a critic answers. */
export function critiquePrompt(input: CritiquePromptInput): string {
	return [
		"A judge consolidated several reviewers' findings on this change into the list below. Your pass is to push back on it. For each finding you have a view on, say where you stand and why.",
		"Take a position of agree, disagree, qualify or unsure. Disagree when you think the finding is wrong about the code. Qualify when it is right but overstated, or right only under a condition it does not name. Unsure when you can see the argument and cannot settle it from what is here.",
		"Every position needs a rationale, and the rationale is the whole value: a bare vote cannot be weighed against the finding it disputes, so one without an argument is worth less than saying nothing. Go and read the code before you disagree with somebody about it.",
		"Say nothing about a finding you have no view on. Silence is read as no position, never as agreement, so there is no cost to leaving one out and a real cost to guessing.",
		"You are not raising new findings here. If you notice something nobody raised, that is worth knowing, but this round records positions only.",
		intentSection(input.intent),
		changeSection(input.proposal),
		"## The findings put to you",
		input.findings.trim() === ""
			? "(nothing was consolidated, so there is nothing to challenge)"
			: input.findings.trim(),
		diffSection(input.diff),
		"Answer in the JSON your output contract skill describes, citing each finding by the number it was given.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** What an auditor needs: the threads, and the change to weigh them against. */
export interface AuditPromptInput extends PromptInput {
	/** The threads put up, rendered with the indices they are cited by. */
	threads: string;
	/** The rest of the stack, when the change sits in one. */
	stack?: string;
}

/** The prompt an auditor answers. */
export function auditPrompt(input: AuditPromptInput): string {
	return [
		"People have left the review threads below on this change. Some of them were answered by later commits and never marked resolved. Your job is to work out which, and to say why for each one.",
		"Report a standing of addressed, outstanding, elsewhere or unclear. Addressed means the change as it now stands does what the thread asked. Outstanding means it does not. Elsewhere means another change answers it, which happens constantly in a stack and matters because reporting it as addressed sends somebody looking in the wrong diff. Unclear means you cannot tell from what is here, which is a useful answer and much better than a guess.",
		"Go and read the code before you call something addressed. A thread saying the handle leaks is addressed by a close on the error path, not by a comment saying it should be closed. Cite where you saw it.",
		"You are not replying to anybody and not raising findings. These are other people's words, and what you produce informs a reply that somebody else will write.",
		intentSection(input.intent),
		changeSection(input.proposal),
		input.stack?.trim()
			? `## The rest of the stack\n\n${input.stack.trim()}`
			: "",
		"## The threads put to you",
		input.threads.trim() === ""
			? "(no unresolved threads, so there is nothing to weigh)"
			: input.threads.trim(),
		diffSection(input.diff),
		"Answer in the JSON your output contract skill describes, citing each thread by the index it was given.",
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** One change in a stack, as a reviewer reading the whole stack sees it. */
export interface StackChangePrompt {
	/** How a finding names this change. */
	ref: string;
	proposal: Proposal;
	diff: DiffModel;
}

/** What a stack-wide reviewer needs: every change, in order. */
export interface StackPromptInput {
	/** Roots before children, the order the stack reports them in. */
	changes: StackChangePrompt[];
	intent?: string;
}

/**
 * The prompt a stack-wide reviewer answers.
 *
 * The one thing this prompt has to get across that no other does: a
 * finding names the changes it is about. A reviewer that reports
 * everything against the change it happened to be reading turns a
 * cross-change finding into three unrelated ones, which is the whole
 * failure this round exists to avoid.
 */
export function stackPrompt(input: StackPromptInput): string {
	return [
		"You are reading a stack of changes together, in the order they apply. Your pass is for discovery, and specifically for what only becomes visible across changes: an interface introduced early and used wrongly later, a split that leaves a middle change unable to stand on its own, a decision made once and contradicted afterwards.",
		"Name the changes each finding is about, by the refs given below. A finding about one change names one. A finding that only exists between changes names every change it involves, and stays one finding: reporting it separately against each change turns one observation into several unrelated ones and loses the thing that made it worth saying.",
		"Review each change on its own merits too. A stack pass that only reports cross-change findings is half a review.",
		"Read the changes below, then use your tools on the tree to check what the diffs cannot tell you. When a change looks wrong on its own, check whether a later change in the stack fixes it before you say so.",
		intentSection(input.intent),
		...input.changes.map(stackChangeSection),
		ANSWER_AS_CONTRACTED,
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** One change, named by the ref a finding uses to refer to it. */
function stackChangeSection(change: StackChangePrompt): string {
	return [
		`## ${change.ref}`,
		changeSection(change.proposal),
		anchorGuidance(change.diff),
		diffSection(change.diff),
	]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** Where anchors may land, so a finding does not degrade for nothing. */
function anchorGuidance(diff: DiffModel): string {
	return [
		"## Where a finding may anchor",
		"A line finding has to name a line that appears in the diff below. One that points elsewhere still counts, but it degrades to a remark on the change as a whole and loses the line it meant, so use a file-scoped or change-scoped finding when what you have to say is not about one line.",
		describeRanges(anchorableRanges(diff)),
	].join("\n\n");
}

/** The round's own direction, when it was given one. */
function intentSection(intent: string | undefined): string {
	const trimmed = intent?.trim() ?? "";
	return trimmed === "" ? "" : `## For this pass in particular\n\n${trimmed}`;
}

/** The change, as its author described it. */
function changeSection(proposal: Proposal): string {
	const parts = [`## The change\n\n${proposal.title || "(no title)"}`];
	const body = proposal.body?.trim() ?? "";
	if (body !== "") parts.push(`### As its author described it\n\n${body}`);
	return parts.join("\n\n");
}

/** The diff itself, hunk by hunk. */
function diffSection(diff: DiffModel): string {
	if (diff.files.length === 0) return "## The diff\n\n(no files changed)";
	const files = diff.files.map((file) => {
		const hunks = file.hunks.map((hunk) => {
			const lines = hunk.lines.map((line) => {
				const marker =
					line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
				return `${marker}${line.text}`;
			});
			return [hunkHeader(hunk), ...lines].join("\n");
		});
		return [`### ${filePath(file)}`, "```", ...hunks, "```"].join("\n");
	});
	return ["## The diff", ...files].join("\n\n");
}
