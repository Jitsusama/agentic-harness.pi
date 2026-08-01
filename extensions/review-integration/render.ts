/**
 * How the substrate talks to a person.
 *
 * Three rules hold this together. The first is that a glyph is a
 * noun: one per concept, always the same one, never two in a
 * row, so the eye learns the vocabulary instead of decoding a
 * new rebus each time. The second is that degradation is
 * narrated as a sentence rather than tabulated as a diagnostic,
 * because "three remarks will land on lines, one becomes prose
 * because its anchor moved" is something a person can act on.
 *
 * The third is that the interface is drawn in geometry, not
 * emoji. That is the house style, and it is a legibility
 * argument rather than a taste one: a geometric glyph is one
 * column wide in every terminal, renders the same on every
 * machine, and stays distinguishable in monochrome, none of
 * which is true of emoji. Shape carries the meaning, so the
 * vocabulary works without colour at all.
 *
 * Shapes are grouped by what kind of thing they name. Diamonds
 * are the review and its parts, circles are what will happen to
 * them, and the rest are containers and marks.
 *
 * Artifacts are a different surface and play by different
 * rules: a pull request body, an issue body and a quest README
 * all carry emoji section markers by convention, and none of
 * this applies to them. Nor does any of it reach a forge. What
 * gets posted is someone else's surface, and decorating it
 * would be rude.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { detectProseViolations } from "../../lib/prose/index.js";
import type {
	Anchor,
	ChecksRollup,
	Proposal,
	PublishOutcome,
	PublishPlan,
	Stack,
	Thread,
} from "../../lib/review/index.js";
import { describeAnchor, standsAt } from "../../lib/review/index.js";
import { count } from "../../lib/ui/count.js";
import { wordWrap } from "../../lib/ui/text-layout.js";

/** Below this a gate is not wrapping text, it is shredding it. */
const MIN_GATE_WIDTH = 24;

/** The vocabulary. One glyph per concept, used everywhere. */
/**
 * The review surface's glyphs.
 *
 * Triangles, because the other families are taken and a glyph that means two
 * things means neither. The harness runs these tools in one session, so the
 * allocation is package-wide rather than per-extension:
 *
 * - diamonds belong to quests, which are the spine everything else hangs off
 * - circle fills belong to the TDD phase, where the fill is a progression
 * - squares belong to work, where a tree is a place
 * - triangles are review's, and they point, which is what a remark does
 *
 * `tests/package/glyphs-are-owned.test.ts` holds the line. Before this, a
 * filled diamond was a quest and a finding, a hollow one a sidequest and a
 * verdict, and a filled circle was a review that landed and a tree with
 * uncommitted work in it: the same mark for the best and worst news on screen.
 */
export const GLYPH = {
	// Triangles: the review and its parts. Size reads as scope, so the
	// change is the largest and a remark inside it the smallest, and
	// hollow is a stance rather than a thing.
	target: "\u25b6",
	finding: "\u25b8",
	verdict: "\u25bd",

	// What becomes of a remark. Not a fill progression: that is the TDD
	// phase's, and borrowing it made landing and degrading look like two
	// steps of one process rather than two different outcomes.
	lands: "\u2714",
	// Accepted but not landed. The round panel already draws an open triangle
	// for a participant not finished, and a queued change is the same fact
	// about a different subject, so it is the same mark rather than a new one.
	queued: "\u25b7",
	degrades: "\u2193",
	refused: "\u2298",
	checks: "\u25ce",

	// A run that broke, as against one that said no. The round progress panel
	// draws this against a participant that failed, and the recorded answer used
	// to draw the identical line with `refused`, so watching a reviewer fail and
	// then reading about it suggested two different things had happened to it.
	// One definition, so the two cannot drift apart again.
	failed: "\u2715",

	// Containers and marks. A stack is layers rather than a square,
	// which is work's family and would read as a tree.
	stack: "\u2261",
	document: "\u00b6",
	thread: "\u276f",
	reaction: "\u2726",
	resolved: "\u2611",
	unresolved: "\u2610",

	// What is about to be said, as against what was already said. Only a
	// write gate draws it, to hold the outgoing text apart from the exchange
	// quoted above it, which is the one distinction those panels must not
	// blur: approving a reply against the wrong remark is invisible.
	reply: "\u21b3",
} as const;

/** One remark quoted into a gate, so a person sees what is being answered. */
export interface GateQuote {
	/** Who said it, with their address where it has one: "C4 binks". */
	who: string;
	/** What they said. Clipped: the outgoing text matters more than this. */
	body: string;
}

/** The text a gate is about to send. */
export interface GatePayload {
	/** "replying as joel.gerber". Absent for a remark answering nobody. */
	as?: string;
	body: string;
}

/**
 * What a write gate is about, in the order a person needs it.
 *
 * Four parts, always the same four, so the shape is learned once and every
 * gate in the surface reads the same way.
 */
export interface GatePanel {
	/** The change and its provider: "shop/world#2000980 · meteorite". */
	destination: string;
	/** Where it hangs: "policy.go:166 · open · 3 replies". */
	where?: string;
	/** The exchange being answered or reacted to. */
	context?: GateQuote[];
	/** What is being sent. Never clipped. */
	payload?: GatePayload;
	/** What follows: settling, a verdict, a degradation. */
	consequence?: string[];
}

/**
 * How many lines of any one quoted remark a gate shows.
 *
 * Per remark rather than across the exchange, so an opening wall of text
 * cannot push the reply that prompted all this off the bottom.
 */
const QUOTE_LINES = 6;

/** Indent for anything quoted or being sent, holding it off the margin. */
const INSET = "   ";

/**
 * Draw one write gate.
 *
 * Pure: data in, lines out, no terminal and no context. That is what makes
 * the panels above testable, and it is the reason nothing here reaches for
 * `ctx`. Everything untestable stays in the thin call to the prompt.
 */
export function gateLines(
	panel: GatePanel,
	theme: Theme,
	width: number,
): string[] {
	return rowsOf(panel, width).map((row) =>
		row.muted && row.text ? theme.fg("muted", row.text) : row.text,
	);
}

/**
 * The same panel as plain text, for the redirect to quote back.
 *
 * One layout, two outputs. A second rendering would let what the redirect
 * says was on screen drift from what was on screen.
 */
export function gateText(panel: GatePanel, width: number): string {
	return rowsOf(panel, width)
		.map((row) => row.text)
		.join("\n");
}

/** One line of a gate, and whether it is chrome or the thing itself. */
interface GateRow {
	text: string;
	muted?: boolean;
}

/** The layout, once, before anything decides how to colour it. */
function rowsOf(panel: GatePanel, width: number): GateRow[] {
	const room = Math.max(MIN_GATE_WIDTH, width - INSET.length);
	const rows: GateRow[] = [
		{ text: `${GLYPH.target} ${panel.destination}`, muted: true },
	];
	if (panel.where) {
		rows.push({ text: `${GLYPH.thread} ${panel.where}`, muted: true });
	}

	for (const quote of panel.context ?? []) {
		rows.push({ text: "" }, ...quoted(quote, room));
	}

	if (panel.payload) {
		rows.push({ text: "" });
		if (panel.payload.as) {
			rows.push({
				text: `${INSET}${GLYPH.reply} ${panel.payload.as}`,
				muted: true,
			});
		}
		// Whole, however long. This is the one thing the gate exists to show,
		// and a gate that elides it is the gate this surface used to have.
		rows.push(
			...inset(wordWrap(panel.payload.body, room)).map((text) => ({ text })),
		);
	}

	if (panel.consequence?.length) {
		rows.push({ text: "" });
		for (const one of panel.consequence) {
			rows.push(...wordWrap(one, width).map((text) => ({ text })));
		}
	}
	return rows;
}

/** One remark, attributed and clipped, with the clip owned up to. */
function quoted(quote: GateQuote, room: number): GateRow[] {
	const wrapped = wordWrap(`${quote.who}: ${quote.body}`, room);
	const kept = wrapped.slice(0, QUOTE_LINES);
	if (wrapped.length > QUOTE_LINES) kept.push("\u2026");
	return inset(kept).map((text) => ({ text, muted: true }));
}

/** Hold lines off the margin, leaving blank ones blank. */
function inset(lines: string[]): string[] {
	return lines.map((line) => (line ? `${INSET}${line}` : line));
}

/** Where a remark points, in a form a person can scan. */
export function anchorLabel(anchor: Anchor): string {
	return describeAnchor(anchor);
}

// The pluralizer this file used to define privately now lives in lib/ui/count.ts,
// so quest and work share it rather than spelling `(s)` inline.
export { count };

/**
 * Where a change stands with a merge queue, when that is worth saying.
 *
 * Unqueued is the normal case and goes unsaid, since a line that reports
 * the absence of everything reports nothing. Queued is worth interrupting
 * for: it is the state in which touching the change is expensive, and a
 * reader who cannot see it will find out by causing it.
 */
function queueNote(proposal: Proposal): string {
	const queue = proposal.queue;
	if (!queue || queue.posture === "unqueued") return "";
	if (queue.posture === "waiting") return " · waiting to merge";
	const place = queue.position === undefined ? "" : ` #${queue.position}`;
	const batched = queue.solo === false ? ", batched" : "";
	return ` · in the merge queue${place}${batched}`;
}

/**
 * How big the change is, when the provider said.
 *
 * Absent means unreported, which is not the same as zero, so nothing is
 * printed rather than a confident `0 files`. Reported piecemeal for the same
 * reason: a backend that gives a file count and no line counts should say the
 * part it knows.
 *
 * Worth printing at all because it is the first thing anybody wants to know
 * about a change they have not read, and because the contract carried these
 * three for a while without a single reader. Meteorite reads the API rather
 * than the CLI largely to get them, so they were fetched on every change and
 * dropped on the floor.
 */
function sizeNote(proposal: Proposal): string {
	const files =
		proposal.changedFiles === undefined
			? undefined
			: `${proposal.changedFiles} ${proposal.changedFiles === 1 ? "file" : "files"}`;
	const lines =
		proposal.additions === undefined && proposal.deletions === undefined
			? undefined
			: `+${proposal.additions ?? 0} -${proposal.deletions ?? 0}`;
	const said = [files, lines].filter((part) => part !== undefined);
	return said.length === 0 ? "" : ` · ${said.join(", ")}`;
}

/** A change, in one line. */
export function proposalLine(proposal: Proposal): string {
	const draft = proposal.draft ? " (draft)" : "";
	// Landing on its own line rather than appended to the first. It is the
	// question somebody asks before merging, it can name two blockers at once,
	// and burying that at the end of a line about size and authorship is how a
	// failing check goes unread.
	const standing = standsAt(proposal.landing);
	const landing = standing === "" ? "" : `\n   ${standing}`;
	// Labels and assignees were parsed on every read by both providers and
	// drawn by nothing, so editing a label reported that a field had changed
	// and then showed a change with no labels on it. An empty array is a
	// different fact from an absent one and neither is worth a line, so both
	// go unsaid; only actually having some does.
	const tagged = proposal.labels?.length
		? `\n   ${proposal.labels.join(", ")}`
		: "";
	const owned = proposal.assignees?.length
		? `\n   assigned to ${proposal.assignees.map((who) => who.name ?? who.id).join(", ")}`
		: "";
	return `${GLYPH.target} ${proposal.ref.label} ${proposal.title}${draft}\n   ${proposal.state} · ${proposal.author.id} · ${proposal.head} → ${proposal.base}${sizeNote(proposal)}${queueNote(proposal)}${landing}${tagged}${owned}`;
}

/** CI, with unreported kept apart from failed. */
export function checksLines(rollup: ChecksRollup): string {
	if (rollup.checks.length === 0) {
		return `${GLYPH.checks} nothing has reported yet`;
	}
	const byState = new Map<string, number>();
	for (const check of rollup.checks) {
		byState.set(check.state, (byState.get(check.state) ?? 0) + 1);
	}
	const parts = [...byState].map(([state, n]) => `${n} ${state}`);
	const notable = rollup.checks
		.filter((check) => check.state === "failing")
		.map((check) => `   ${check.name}`)
		.join("\n");
	const head = `${GLYPH.checks} ${rollup.state}: ${parts.join(", ")}`;
	return notable ? `${head}\n${notable}` : head;
}

/**
 * A stack as a lane graph. The cursor is marked because the
 * question people actually have is "where am I in this".
 */
export function stackLines(stack: Stack): string {
	const provenance =
		stack.provenance === "authoritative"
			? "recorded by the backend"
			: "derived from branch names, so it may be wrong at the edges";
	const header = `${GLYPH.stack} ${count(stack.nodes.length, "branch", "branches")}, ${provenance}`;
	const trunk = stack.trunk ? `\n   ╿ ${stack.trunk} (trunk)` : "";

	// Top of the stack first: that is how people draw them.
	const rows = [...stack.nodes.entries()].reverse().map(([index, node]) => {
		const here = index === stack.cursor ? "▶" : " ";
		const proposal = node.proposal;
		const label = proposal
			? `${node.ref} · ${proposal.title}`
			: `${node.ref} · not proposed anywhere`;
		const behind = node.behindParent ? "  (behind its parent)" : "";
		return `  ${here} ${index === 0 ? "╽" : "┃"} ${label}${behind}`;
	});
	return `${header}\n${rows.join("\n")}${trunk}`;
}

/** One thread, with its anchor and its state. */
export function threadLines(
	thread: Thread,
	index: number,
	/**
	 * What each comment in the thread is addressed as, by comment id.
	 *
	 * Passed in rather than computed, because the numbering spans the whole
	 * conversation and a single thread cannot see the rest of it. Absent where
	 * a caller is rendering threads for something other than acting on them.
	 */
	addresses?: Map<string, string>,
): string {
	const mark = thread.resolved ? GLYPH.resolved : GLYPH.unresolved;
	const where = thread.anchor ? anchorLabel(thread.anchor) : "on the change";
	const stale = thread.stale ? " · stale" : "";
	const first = thread.comments[0];
	const at = first ? addresses?.get(first.id) : undefined;
	// The opener carries its own address, since reacting to the remark that
	// started an exchange is the common case and having to read further to
	// find its number would defeat printing numbers at all.
	const opener = first
		? `${at ? `${at} ` : ""}${first.author.id}: ${first.body}`
		: "(empty)";
	const rest = thread.comments.slice(1);
	const more =
		rest.length > 0
			? addresses
				? // With addresses to hand, each reply is listed rather than
					// counted: a reply nobody can name cannot be reacted to, and
					// a count is exactly as much use as no listing at all.
					`\n${rest
						.map((one) => {
							const label = addresses.get(one.id);
							return `     ${label ? `${label} ` : ""}${one.author.id}: ${one.body}`;
						})
						.join("\n")}`
				: `\n     …${count(rest.length, "more reply", "more replies")}`
			: "";
	return `${mark} [T${index + 1}] ${GLYPH.thread} ${where}${stale}\n     ${opener}${more}`;
}

/**
 * Every piece of prose a plan is about to send.
 *
 * Not every op carries text: resolving a thread and adding a
 * reaction do not, and a review carries a body plus one per
 * anchored comment.
 */
function bodiesIn(plan: PublishPlan): string[] {
	const bodies: string[] = [];
	for (const op of plan.ops) {
		if (op.kind === "review") {
			bodies.push(op.body, ...op.comments.map((one) => one.body));
		} else if (op.kind === "comment" || op.kind === "reply") {
			bodies.push(op.body);
		} else if (op.kind === "commentOn") {
			// A remark that travels on its own is still prose somebody else
			// reads. Leaving it out would have made the gate's coverage depend
			// on which request happened to carry the text, and the same remark
			// would pass or fail by where the provider makes it go.
			bodies.push(op.comment.body);
		}
	}
	return bodies.filter((body) => body.trim() !== "");
}

/**
 * A refusal naming the prose that must be fixed, or nothing.
 *
 * This existed in the extension the review tools replaced, and
 * came back because it is the one gate whose absence is
 * invisible until somebody else reads the comment. Most of the
 * text here was written by a model, and models emit emdashes,
 * curly quotes and Unicode ellipses by default, so without this
 * the standard holds everywhere in the repo except the one
 * place the writing leaves it.
 */
export function proseComplaint(plan: PublishPlan): string | undefined {
	const found = bodiesIn(plan).flatMap((body) => detectProseViolations(body));
	if (found.length === 0) return undefined;

	// Deduplicated, because one habit repeated forty times is one
	// thing to fix and forty lines of noise.
	const seen = new Map<string, number>();
	for (const violation of found) {
		seen.set(violation.rule, (seen.get(violation.rule) ?? 0) + 1);
	}

	return [
		"This review is not ready to send: the prose standard applies to what goes on somebody else's change.",
		...[...seen].map(
			([rule, count]) => `   ${rule}${count > 1 ? ` (${count} times)` : ""}`,
		),
		"Rewrite the bodies with review_draft finding or reply, then publish.",
	].join("\n");
}

/**
 * What publishing will do, narrated.
 *
 * The order is deliberate: what will happen, then what will
 * happen differently, then what will not happen. Someone who
 * reads only the first line still learns the important part.
 */
export function planNarration(plan: PublishPlan): string {
	const lines: string[] = [];

	if (plan.ops.length === 0 && plan.refused.length === 0) {
		return "Nothing to publish yet. Add a finding, a reply or a verdict.";
	}

	for (const op of plan.ops) {
		if (op.kind === "review") {
			const anchored = count(op.comments.length, "anchored remark");
			lines.push(
				`${GLYPH.lands} one review, ${op.verdict}, carrying ${anchored}`,
			);
		} else if (op.kind === "comment") {
			lines.push(`${GLYPH.lands} one top-level message`);
		} else if (op.kind === "reply") {
			lines.push(`${GLYPH.lands} a reply into ${GLYPH.thread} ${op.thread.id}`);
		} else if (op.kind === "resolve") {
			lines.push(`${GLYPH.lands} resolving ${GLYPH.thread} ${op.thread.id}`);
		} else if (op.kind === "unresolve") {
			lines.push(`${GLYPH.lands} reopening ${GLYPH.thread} ${op.thread.id}`);
		} else if (op.kind === "commentOn") {
			// Said as its own line, and said to be separate, because that is
			// what a person is approving: two posts rather than one, so a
			// backend refusing this remark cannot take the review with it.
			const anchor = op.comment.anchor;
			const at = anchor.subject === "change" ? "the change" : anchor.path;
			lines.push(
				`${GLYPH.lands} a remark on ${at}, posted on its own, since a review cannot carry one`,
			);
		} else {
			lines.push(`${GLYPH.reaction} ${op.reaction} on ${op.subject.id}`);
		}
	}

	for (const degraded of plan.degraded) {
		lines.push(
			`${GLYPH.degrades} #${degraded.itemId} was ${degraded.from}; it becomes ${degraded.to}, because ${degraded.reason}`,
		);
	}

	for (const refusal of plan.refused) {
		const which = refusal.itemId ? `#${refusal.itemId} ` : "";
		lines.push(
			`${GLYPH.refused} ${which}${refusal.subject} will not be sent: ${refusal.reason}`,
		);
	}

	return lines.join("\n");
}

/** What publishing actually did. */
export function outcomeNarration(outcome: PublishOutcome): string {
	if (outcome.outcomes.length === 0) return "Nothing was sent.";
	const landed = outcome.outcomes.filter((entry) => entry.ok);
	const failed = outcome.outcomes.filter((entry) => !entry.ok);
	const lines: string[] = [];

	if (landed.length > 0) {
		lines.push(`${GLYPH.lands} ${count(landed.length, "operation")} landed`);
		for (const entry of landed) {
			if (entry.posted?.url) lines.push(`   ${entry.posted.url}`);
		}
	}
	for (const entry of failed) {
		lines.push(
			`${GLYPH.refused} ${entry.op.kind} did not land: ${entry.error}`,
		);
	}
	if (failed.length > 0) {
		lines.push(
			"What failed is still in the draft, so publishing again sends only that.",
		);
	}
	return lines.join("\n");
}
