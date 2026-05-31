/**
 * The plan document model. The document is the single source of
 * truth for a plan effort, so this module owns reading and
 * writing it: parsing the front-matter floor, serializing it
 * back, stamping changes, counting checkbox progress and
 * scaffolding a fresh plan.
 *
 * The parsed surface is deliberately tiny. Only the front-matter
 * (id, stage, updated, sessions) and GitHub task-list checkboxes
 * are interpreted; everything else in the body is free prose the
 * author owns. The front-matter shape is fixed and we are the
 * only writer, so a narrow hand-rolled parser is safer than
 * pulling in a general YAML dependency and parsing far more than
 * the contract needs.
 */

import type { Stage } from "./machine.js";

/** The machine-readable front-matter floor. */
export interface PlanFrontMatter {
	id: string;
	stage: Stage;
	/** Last-touched date, YYYY-MM-DD. */
	updated: string;
	/** Pi session ids that have worked this plan. */
	sessions: string[];
}

/** A parsed plan: its front-matter and the markdown body. */
export interface PlanDoc {
	frontMatter: PlanFrontMatter;
	body: string;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Compact date for an id: YYYYMMDD. */
function ymd(date: Date): string {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** Human date for the updated stamp: YYYY-MM-DD. */
function ymdDash(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Build a plan id of the form PLAN-YYYYMMDD-suffix. */
export function formatPlanId(date: Date, suffix: string): string {
	return `PLAN-${ymd(date)}-${suffix}`;
}

function parseInlineList(value: string): string[] {
	return value
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseFrontMatter(lines: string[]): PlanFrontMatter | null {
	let id: string | undefined;
	let stage: string | undefined;
	let updated: string | undefined;
	const sessions: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const match = /^(\w+):\s*(.*)$/.exec(lines[i]);
		if (!match) continue;
		const [, key, raw] = match;
		const value = raw.trim();
		if (key === "id") id = value;
		else if (key === "stage") stage = value;
		else if (key === "updated") updated = value;
		else if (key === "sessions") {
			if (value.startsWith("[")) {
				sessions.push(...parseInlineList(value));
			} else {
				for (let j = i + 1; j < lines.length; j++) {
					const item = /^\s*-\s+(.*)$/.exec(lines[j]);
					if (!item) break;
					sessions.push(item[1].trim());
				}
			}
		}
	}

	if (!id || !stage || !updated) return null;
	return { id, stage: stage as Stage, updated, sessions };
}

/**
 * Parse a plan document. Returns null when the text has no
 * front-matter block or the block is missing a required key.
 */
export function parsePlan(text: string): PlanDoc | null {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return null;

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return null;

	const frontMatter = parseFrontMatter(lines.slice(1, end));
	if (!frontMatter) return null;

	let body = lines.slice(end + 1).join("\n");
	if (body.startsWith("\n")) body = body.slice(1);
	return { frontMatter, body };
}

function serializeFrontMatter(fm: PlanFrontMatter): string {
	const lines = [
		`id: ${fm.id}`,
		`stage: ${fm.stage}`,
		`updated: ${fm.updated}`,
	];
	if (fm.sessions.length === 0) {
		lines.push("sessions: []");
	} else {
		lines.push("sessions:");
		for (const s of fm.sessions) lines.push(`  - ${s}`);
	}
	return ["---", ...lines, "---"].join("\n");
}

/** Serialize a plan back to text. parse(serialize(doc)) equals doc. */
export function serializePlan(doc: PlanDoc): string {
	return `${serializeFrontMatter(doc.frontMatter)}\n${doc.body}`;
}

/** The plan's title: the first H1 in the body, or null. */
export function extractTitle(body: string): string | null {
	const match = /^#\s+(.+)$/m.exec(body);
	return match ? match[1].trim() : null;
}

/** Count GitHub task-list checkboxes in a body: total and done. */
export function progress(body: string): { total: number; done: number } {
	const rx = /^\s*-\s+\[([ xX])\]/gm;
	let total = 0;
	let done = 0;
	for (let m = rx.exec(body); m !== null; m = rx.exec(body)) {
		total++;
		if (m[1].toLowerCase() === "x") done++;
	}
	return { total, done };
}

/** A change to a plan's front-matter. All fields optional. */
export interface PlanRevision {
	stage?: Stage;
	/** Stamp `updated` from this date. */
	date?: Date;
	/** Attach a session id if not already present. */
	session?: string;
}

/** Apply a revision to a plan's front-matter, leaving the body intact. */
export function revise(doc: PlanDoc, change: PlanRevision): PlanDoc {
	const fm: PlanFrontMatter = {
		...doc.frontMatter,
		sessions: [...doc.frontMatter.sessions],
	};
	if (change.stage) fm.stage = change.stage;
	if (change.date) fm.updated = ymdDash(change.date);
	if (change.session && !fm.sessions.includes(change.session)) {
		fm.sessions.push(change.session);
	}
	return { frontMatter: fm, body: doc.body };
}

/** Fields needed to scaffold a fresh plan document. */
export interface ScaffoldInput {
	id: string;
	title: string;
	stage: Stage;
	updated: string;
	sessions?: string[];
}

/**
 * Build a fresh plan document with the recommended sections. The
 * sections are a starting shape, not a contract: the author is
 * free to reshape the body. Only the front-matter and checkboxes
 * are ever parsed.
 */
export function scaffold(input: ScaffoldInput): string {
	const body = [
		`# ${input.title}`,
		"",
		"## Spirit",
		"The stable north star: why this work exists and what good looks",
		"like. This is the part that must survive every deviation.",
		"",
		"## Context",
		"What framing the problem surfaced. Constraints. What is in and",
		"out of scope.",
		"",
		"## Approach",
		"The shape we settled on and the decisions behind it, each with",
		"its rationale.",
		"",
		"## Work",
		"- [ ] First increment, sequenced so each step forces the least",
		"",
		"## Open Questions",
		"- [ ] Anything still unresolved, tracked as its own checklist",
		"",
		"## Discovery & Deviations",
		"An append-only, dated log. When the work surfaces something that",
		"changes the plan, it lands here with the decision and the",
		"consent behind it.",
		"",
	].join("\n");
	return serializePlan({
		frontMatter: {
			id: input.id,
			stage: input.stage,
			updated: input.updated,
			sessions: input.sessions ?? [],
		},
		body,
	});
}
