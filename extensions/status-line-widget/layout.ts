/**
 * The line's layout, in the prompt's language, apart from how it is
 * painted so it can be read for what it says.
 *
 * On the left: where pi is working, told from its root; what git is in the
 * middle of; and the model, with how hard it thinks. On the right: what
 * extensions say, the panel's height when it isn't the usual one, context
 * and money as one meter, and the branch, muted, with git's notation for
 * its changes and its upstream. Fields are two spaces apart and a mark sits
 * one space from its words, so each reads with its own. Each field shows
 * only while it's true, and they give way a step at a time as the window
 * narrows, the folder's name standing last. A field that gives way goes
 * without a trace: a mark saying only that something is missing is one to
 * learn, and the wider window shows it again.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { GitState } from "./git.ts";
import type { Told } from "./place.ts";
import type { Marks } from "./where.ts";

/**
 * How a piece reads. `painted` is a piece an extension painted itself,
 * which the line places whole and never recolours.
 */
export type Role =
	| "text"
	| "muted"
	| "strong"
	| "alert"
	| "warning"
	| "thinking"
	| "painted";

export interface Piece {
	readonly role: Role;
	readonly text: string;
}

export interface Facts {
	readonly place: Told;
	/** The engine's answer for the folder, when it has given one. */
	readonly git: GitState | null;
	/** pi's own word for the branch, until or unless the engine answers. */
	readonly branch: string | null;
	readonly model: string;
	/** pi's thinking level; `off` says nothing. */
	readonly thinking: string;
	/** Each extension's status, painted by its owner. */
	readonly statuses: readonly string[];
	/** The panel's height mark, painted, or null at the usual height. */
	readonly panel: string | null;
	/** Context in tokens, then as a share, each a mark and its reading. */
	readonly context: readonly Piece[];
	readonly contextShare: readonly Piece[];
	/** What the next turn costs and what the session has; null for none. */
	readonly rate: string | null;
	readonly total: string | null;
	readonly marks: Marks;
}

/**
 * The steps the line gives way by, in order, each keeping the ones before:
 * the session's total, the branch's middle, the path's middle, context to a
 * share, the model to its short name, how hard it thinks, the branch to its
 * mark, what's under way to its mark, the path to the folder's name, the
 * model, and then the name's own middle. The rate is never given up: it is
 * the one reading here that changes what to do next.
 */
export const STEPS = [
	"total",
	"branchshort",
	"pathshort",
	"share",
	"modelshort",
	"thinking",
	"branchglyph",
	"opshort",
	"nameonly",
	"model",
	"nameshort",
] as const;

export type Step = (typeof STEPS)[number];

/** Between two fields. */
const GAP = "  ";

export function width(pieces: readonly Piece[]): number {
	let total = 0;
	for (const piece of pieces) total += visibleWidth(piece.text);
	return total;
}

/** Shorten a model ID: claude-sonnet-4-20250514 → sonnet-4. */
export function shortenModel(id: string): string {
	return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * A name kept to a number of columns by cutting its middle, as the prompt
 * shortens a branch: the start and the end stay, the more mark between.
 */
export function middle(name: string, keep: number, more: string): string {
	const chars = [...name];
	if (chars.length <= keep) return name;
	const head = Math.floor((keep - 1) / 2);
	const tail = keep - 1 - head;
	return `${chars.slice(0, head).join("")}${more}${chars.slice(chars.length - tail).join("")}`;
}

function putPath(
	pieces: Piece[],
	place: Told,
	marks: Marks,
	short: boolean,
	nameOnly: boolean,
): void {
	const { parts } = place;
	const n = parts.length;
	if (n === 0) {
		pieces.push({ role: "strong", text: "/" });
	} else if (n === 1) {
		pieces.push({ role: "strong", text: `${place.lead}${parts[0]}` });
	} else if (nameOnly) {
		pieces.push({ role: "muted", text: `${marks.more}/` });
		pieces.push({ role: "strong", text: parts[n - 1] ?? "" });
	} else {
		let between = parts.slice(1, n - 1).join("/");
		if (short && n > 2) between = marks.more;
		pieces.push({ role: place.first, text: `${place.lead}${parts[0]}` });
		pieces.push({
			role: "muted",
			text: `/${between !== "" ? `${between}/` : ""}`,
		});
		pieces.push({ role: "strong", text: parts[n - 1] ?? "" });
	}
}

function putOperation(
	pieces: Piece[],
	git: GitState,
	marks: Marks,
	short: boolean,
): void {
	const op = git.op;
	if (!op) return;
	const hue: Role = git.conflicted ? "alert" : "warning";
	pieces.push({ role: "text", text: GAP });
	if (short) {
		pieces.push({ role: hue, text: marks.active });
	} else if (op.at !== undefined && op.of !== undefined) {
		pieces.push({ role: "text", text: `${op.name} ` });
		if (op.of > 8) {
			pieces.push({ role: "text", text: `${op.at}/${op.of}` });
		} else {
			for (let step = 1; step <= op.of; step++) {
				if (step < op.at) pieces.push({ role: "text", text: marks.complete });
				else if (step === op.at) pieces.push({ role: hue, text: marks.active });
				else pieces.push({ role: "muted", text: marks.pending });
			}
		}
	} else {
		pieces.push({ role: hue, text: marks.active });
		pieces.push({ role: "text", text: ` ${op.name}` });
	}
}

/** The line's two sides with the given steps taken. */
export function draw(
	facts: Facts,
	on: ReadonlySet<Step>,
): { left: Piece[]; right: Piece[] } {
	const { marks } = facts;
	const left: Piece[] = [];
	const right: Piece[] = [];

	if (on.has("nameshort") && facts.place.parts.length > 0) {
		const parts = [...facts.place.parts];
		parts[parts.length - 1] = middle(parts.at(-1) ?? "", 16, marks.more);
		putPath(left, { ...facts.place, parts }, marks, true, true);
	} else {
		putPath(left, facts.place, marks, on.has("pathshort"), on.has("nameonly"));
	}

	if (facts.git) putOperation(left, facts.git, marks, on.has("opshort"));

	const thinks = facts.thinking !== "" && facts.thinking !== "off";
	if (!on.has("model")) {
		const model = on.has("modelshort")
			? shortenModel(facts.model)
			: facts.model;
		left.push({ role: "muted", text: `${GAP}${model}` });
		if (thinks && !on.has("thinking")) {
			left.push({ role: "text", text: " " });
			if (marks.thinking !== "") {
				left.push({ role: "thinking", text: marks.thinking });
				left.push({ role: "text", text: " " });
			}
			left.push({ role: "muted", text: facts.thinking });
		}
	}

	const field = (pieces: readonly Piece[]) => {
		if (pieces.length === 0) return;
		if (right.length > 0) right.push({ role: "text", text: GAP });
		right.push(...pieces);
	};

	for (const status of facts.statuses)
		field([{ role: "painted", text: status }]);
	if (facts.panel) field([{ role: "painted", text: facts.panel }]);

	const meter: Piece[] = [
		...(on.has("share") ? facts.contextShare : facts.context),
	];
	if (facts.rate) meter.push({ role: "muted", text: ` ${facts.rate}` });
	if (facts.total && !on.has("total"))
		meter.push({ role: "muted", text: ` ${facts.total}` });
	field(meter);

	const branch = facts.git ? facts.git.branch : facts.branch;
	if (branch) {
		const pieces: Piece[] = [];
		const glyph = marks.branch;
		if (glyph !== "") pieces.push({ role: "muted", text: glyph });
		if (!on.has("branchglyph")) {
			const name = on.has("branchshort")
				? middle(branch, 14, marks.more)
				: branch;
			pieces.push({ role: "muted", text: glyph !== "" ? ` ${name}` : name });
		}
		for (const group of facts.git ? notation(facts.git) : []) {
			pieces.push({
				role: "text",
				text: `${pieces.length > 0 ? " " : ""}${group}`,
			});
		}
		field(pieces);
	}

	return { left, right };
}

/**
 * What the tree holds and how the branch stands with its upstream, in the
 * notation git's own short status and the usual prompts use: `*` for
 * changes not staged, `+` for staged, `?` for untracked files, together,
 * then `↑N` ahead of its upstream and `↓N` behind, together. Nothing
 * when the tree is clean and in step, so there is never a mark to explain.
 */
export function notation(git: GitState): string[] {
	const changes = [
		git.unstaged ? "*" : "",
		git.staged ? "+" : "",
		git.untracked ? "?" : "",
	].join("");
	const upstream = [
		git.ahead > 0 ? `${AHEAD}${git.ahead}` : "",
		git.behind > 0 ? `${BEHIND}${git.behind}` : "",
	].join("");
	return [changes, upstream].filter((group) => group !== "");
}

/** The arrows for commits ahead of an upstream and behind it. */
const AHEAD = "↑";
const BEHIND = "↓";

/**
 * The line at a width: each step taken in turn until both sides fit with a
 * gap between them. When even the last step won't fit, the folder's name
 * is all that's left, kept to the width by its middle.
 */
export function layout(
	facts: Facts,
	columns: number,
): { left: Piece[]; right: Piece[] } {
	const on = new Set<Step>();
	let drawn = draw(facts, on);
	const fits = () =>
		width(drawn.left) +
			(drawn.right.length > 0 ? GAP.length : 0) +
			width(drawn.right) <=
		columns;
	for (const step of STEPS) {
		if (fits()) return drawn;
		on.add(step);
		drawn = draw(facts, on);
	}
	if (fits()) return drawn;
	const name = facts.place.parts.at(-1) ?? "/";
	return {
		left: [
			{
				role: "strong",
				text: middle(name, Math.max(1, columns), facts.marks.more),
			},
		],
		right: [],
	};
}
