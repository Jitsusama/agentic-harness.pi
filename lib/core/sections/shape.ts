/**
 * Shape rules for the sections of a body: how long each may be, and
 * what each may hold. The section detector says whether the right
 * headings are there; this says whether what sits under them is
 * something a person can read in the time they have.
 *
 * The limits come from the research behind the github-pr-format
 * skill. A reader takes in about 238 words a minute (Brysbaert,
 * 2019), so a 40-word TL;DR is the eight-second read it promises. A
 * problem told as cause and effect is remembered far better than a
 * list of facts about a topic (Meyer and Freedle, 1984), so the
 * Problem is prose and the Solution may not become an inventory of
 * the files it touched. Every rule is mechanical on purpose: a gate
 * that judges cannot be held to the same answer twice.
 *
 * A large change gets room inside its sections rather than longer
 * ones. Each section it may deepen opens with a paragraph held to the
 * ordinary ceiling, so the TL;DR and the openings stay the two-minute
 * description, and below the opening it may carry parts under
 * subheadings, each with a ceiling of its own, and in Validation one
 * kind of table, counted by its rows. Whether a change is large is
 * measured by the caller and handed in as its size, never claimed by
 * the writer: a size that is missing or unknown holds the ordinary
 * shape, and the refusal says why.
 *
 * Detection never rewrites. It names the section, the rule, the limit
 * and what it found, and leaves the repair to the author.
 */

import type { Violation } from "../../gate/index.ts";
import {
	type SectionWording,
	type WordingRule,
	wordingProblems,
} from "./wording.ts";

/**
 * What one section may hold. Every limit is a maximum; absent means no
 * limit. The wording rules it inherits say which misleading phrasings
 * the section refuses.
 */
export interface SectionShape extends SectionWording {
	/** Words of prose, not counting code blocks, context lines or the link footer. */
	readonly words?: number;
	/** Sentences of prose. */
	readonly sentences?: number;
	/** Inline code spans. */
	readonly codeSpans?: number;
	/** List items. */
	readonly bullets?: number;
	/** Links, reference or inline, and bare URLs. */
	readonly links?: number;
	/** When true, refuse list items labelled as artifacts ("Docs:", "Tests:"). */
	readonly noArtifactLists?: boolean;
}

/**
 * The room a large change is given inside its sections. Each limit is
 * a maximum.
 */
export interface DepthShape {
	/** Changed lines, added and deleted, from which a change is large. */
	readonly fromLines: number;
	/** The sections that may go deeper, by exact heading. */
	readonly sections: readonly string[];
	/** The hashes a part's subheading takes, such as "####". */
	readonly partHashes: string;
	/** Parts in one section. */
	readonly parts: number;
	/** Words in one part. */
	readonly partWords: number;
	/** The one section a results table may sit in, by exact heading. */
	readonly tableIn: string;
	/** Data rows in one table, not counting its header. */
	readonly tableRows: number;
	/** Words in one cell. */
	readonly cellWords: number;
}

/**
 * How big the change a body describes is, as the caller measured it:
 * its changed lines, or why they could not be counted.
 */
export type ChangeSize =
	| { readonly lines: number }
	| { readonly unknown: string };

/** The shape of a whole body. */
export interface BodyShape {
	/** Rules per section, keyed by the exact heading. */
	readonly sections: Readonly<Record<string, SectionShape>>;
	/** The room a large change is given, when the body may have any. */
	readonly depth?: DepthShape;
	/** The longest sentence allowed in any section with rules. */
	readonly sentenceWords?: number;
	/** When true, nothing may sit above the first heading. */
	readonly headingFirst?: boolean;
}

/** Which rule a shape violation broke. */
export type ShapeRule =
	| "words"
	| "sentences"
	| "codeSpans"
	| "bullets"
	| "links"
	| "artifactLists"
	| "sentenceWords"
	| "empty"
	| "above"
	| "depth"
	| "parts"
	| "tableRows"
	| "cellWords"
	| "tableNumbers"
	| "tableAfter"
	| "tablePlace"
	| "docLinks"
	| WordingRule;

/** One way a body breaks its shape. */
export interface ShapeViolation extends Violation {
	readonly kind: "shape";
	/** The heading the violation sits under, or "" for the text above the first. */
	readonly section: string;
	readonly rule: ShapeRule;
	/** The maximum the rule allows; 0 for rules that allow nothing. */
	readonly limit: number;
	/** What the section actually holds, in the rule's unit. */
	readonly actual: number;
	/** The opening of the offending sentence or line, where there is one. */
	readonly excerpt?: string;
	/** For a wording rule, the word or phrase that broke it. */
	readonly word?: string;
	/** For the depth rule, why this change was not given any. */
	readonly why?: string;
}

const FENCE = /```[\s\S]*?```/g;
const CODE_SPAN = /`[^`\n]+`/g;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const VARIATION_SELECTOR = /\uFE0F/g;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
const LINK = /\[[^\]\n]+\]\[[^\]\n]*\]|\[[^\]\n]+\]\([^)\n]*\)|https?:\/\/\S+/g;
const ABBREVIATION = /\b(e\.g|i\.e|etc|vs|cf)\./gi;
const EXCERPT_WORDS = 10;
const TABLE_LINE = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*:?-+:?\s*$/;
const FENCE_LINE = /^\s*```/;
/** A code span or a link whose target is a markdown file in the repository. */
const DOC_REFERENCE =
	/`[^`\n]*\.md(?:#[^`\n]*)?`|\]\([^)\s]*\.md(?:#[^)\s]*)?\)|^\s*\[[^\]]+\]:\s+\S*\.md(?:#\S*)?\s*$/gm;

/** Why a path that hands in no size gives no change any depth. */
const UNMEASURED =
	"this path does not measure the change, so propose or edit it through review_offer, which does";

/**
 * Labels that make a list item an inventory of what the diff touched
 * rather than a behaviour. Matched only as a label (the item's first
 * words followed by a colon), so a bullet that mentions tests in a
 * sentence is left alone. Dependencies and configuration are not on the
 * list: "Dependency: core moves to 0.9.0, which breaks X" is the must-act
 * item the skill asks for, so refusing the label would refuse it.
 */
const ARTIFACT_LABEL =
	/^\s*(?:[-*+]|\d+\.)\s+(?:\*\*)?(?:docs?|documentation|tests?|testing|files?|changelog|readme)(?:\*\*)?\s*:/i;

/**
 * Lines that are context rather than prose: the tracking-issue line,
 * a stack note and the reference-link footer. They are allowed in a
 * section but are not what its limits measure.
 */
function isContext(line: string): boolean {
	return (
		/^\s*Part of #\d+/i.test(line) ||
		/^\s*>/.test(line) ||
		/^\s*\[[^\]]+\]:\s+\S/.test(line)
	);
}

/** A heading's canonical form, `<hashes> <text>` with no variation selector. */
function canonical(hashes: string, text: string): string {
	return `${hashes} ${text}`.replace(VARIATION_SELECTOR, "");
}

/**
 * Whether a heading at these hashes, under this section, is one of the
 * section's parts rather than a heading of its own.
 */
export function isPartHeading(
	hashes: string,
	section: string | undefined,
	depth: DepthShape | undefined,
): boolean {
	return (
		depth !== undefined &&
		section !== undefined &&
		hashes === depth.partHashes &&
		depth.sections.some((s) => s.replace(VARIATION_SELECTOR, "") === section)
	);
}

/**
 * The text under each heading, with fenced blocks kept out of the
 * heading scan. A part's subheading stays in its section's text.
 */
function split(
	body: string,
	depth?: DepthShape,
): { heading: string; text: string }[] {
	const masked = body.replace(FENCE, (m) => m.replace(/#/g, " "));
	const lines = body.split("\n");
	const maskedLines = masked.split("\n");
	const out: { heading: string; lines: string[] }[] = [
		{ heading: "", lines: [] },
	];
	for (const [i, line] of lines.entries()) {
		const match = HEADING.exec(maskedLines[i] ?? "");
		const within = out.at(-1)?.heading;
		if (match && !isPartHeading(match[1] ?? "", within, depth)) {
			out.push({
				heading: canonical(match[1] ?? "", match[2] ?? ""),
				lines: [],
			});
		} else {
			out.at(-1)?.lines.push(line);
		}
	}
	return out.map((s) => ({ heading: s.heading, text: s.lines.join("\n") }));
}

/** A section's opening and the parts below it, by their subheadings. */
function partsOf(
	text: string,
	hashes: string,
): { opening: string; parts: { title: string; text: string }[] } {
	const opening: string[] = [];
	const parts: { title: string; lines: string[] }[] = [];
	let fenced = false;
	for (const line of text.split("\n")) {
		if (FENCE_LINE.test(line)) fenced = !fenced;
		const match = fenced ? null : HEADING.exec(line);
		if (match && match[1] === hashes) {
			parts.push({
				title: (match[2] ?? "").replace(VARIATION_SELECTOR, ""),
				lines: [],
			});
		} else {
			(parts.at(-1)?.lines ?? opening).push(line);
		}
	}
	return {
		opening: opening.join("\n"),
		parts: parts.map((p) => ({ title: p.title, text: p.lines.join("\n") })),
	};
}

/** A markdown table: its rows as cells, and whether prose follows it. */
interface Table {
	readonly header: string[];
	readonly rows: string[][];
	readonly followed: boolean;
}

function cellsOf(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

/**
 * The tables in some text, and the text with them taken out. A table
 * is a run of lines opening with a pipe; its separator row is not a
 * row, and its first row is its header.
 */
function tablesOf(text: string): { tables: Table[]; rest: string } {
	const lines = text.split("\n");
	const tables: Table[] = [];
	const rest: string[] = [];
	let at = 0;
	while (at < lines.length) {
		if (!TABLE_LINE.test(lines[at] ?? "")) {
			rest.push(lines[at] ?? "");
			at++;
			continue;
		}
		const run: string[][] = [];
		while (at < lines.length && TABLE_LINE.test(lines[at] ?? "")) {
			const cells = cellsOf(lines[at] ?? "");
			if (!cells.every((cell) => TABLE_SEPARATOR.test(cell))) run.push(cells);
			at++;
		}
		const next = lines.slice(at).find((line) => line.trim() !== "");
		const followed =
			next !== undefined && !TABLE_LINE.test(next) && countWords(next) > 0;
		tables.push({ header: run[0] ?? [], rows: run.slice(1), followed });
		rest.push("");
	}
	return { tables, rest: rest.join("\n") };
}

/** The prose of a section: no context lines, no fenced blocks. */
function proseOf(text: string): string {
	return text
		.replace(FENCE, "")
		.split("\n")
		.filter((line) => !isContext(line))
		.join("\n")
		.trim();
}

/** The words a reader reads, with markdown syntax taken out. */
export function countWords(text: string): number {
	const plain = text
		.replace(FENCE, " ")
		.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1")
		.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
		.replace(new RegExp(LIST_ITEM.source, "gm"), "")
		.replace(/[*_`#>]/g, " ");
	return plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * The sentences of some prose. A code span is held as one word so a
 * dot inside it never ends a sentence, a common abbreviation keeps
 * its dot, and a paragraph break or a new list item always ends one.
 * A semicolon does not: a chain of clauses joined by semicolons reads
 * as one long sentence, and is measured as one.
 *
 * What follows a stop may start lowercase. A sentence opening with a
 * tool or identifier (`niri`, `core`) is still a new sentence, and
 * reading it as part of the one before refused descriptions for a run-on
 * nobody wrote. The abbreviations above have lost their stop by now, so
 * they cannot end one.
 */
export function sentencesOf(text: string): string[] {
	const prose = text
		.replace(FENCE, " ")
		.replace(CODE_SPAN, "CODE")
		.replace(ABBREVIATION, "$1");
	return prose
		.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/)
		.flatMap((chunk) =>
			chunk.split(/(?<=[.!?]["')\]]?)\s+(?=["'([]?[\p{L}\p{N}])/u),
		)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => countWords(s) > 0);
}

/** The sentence's opening, marked as cut only when it was; a whole sentence is quoted without its closing stop. */
function excerpt(sentence: string): string {
	const words = sentence.split(/\s+/);
	if (words.length <= EXCERPT_WORDS) return sentence.replace(/[.!?]+$/, "");
	return `${words.slice(0, EXCERPT_WORDS).join(" ")}...`;
}

function violation(
	section: string,
	rule: ShapeRule,
	limit: number,
	actual: number,
	quoted?: string,
): ShapeViolation {
	return {
		kind: "shape",
		section,
		rule,
		limit,
		actual,
		found: `${section} ${rule}`,
		...(quoted ? { excerpt: excerpt(quoted) } : {}),
	};
}

/** A limit broken, as a violation, or nothing. */
function over(
	section: string,
	rule: ShapeRule,
	limit: number | undefined,
	actual: number,
): ShapeViolation[] {
	return limit !== undefined && actual > limit
		? [violation(section, rule, limit, actual)]
		: [];
}

/** Every way one stretch of prose breaks the rules it is held to. */
function proseViolations(
	label: string,
	text: string,
	rules: SectionShape,
	sentenceWords: number | undefined,
): ShapeViolation[] {
	const prose = proseOf(text);
	const sentences = sentencesOf(prose);
	const wordCount = countWords(prose);
	if (wordCount === 0) return [violation(label, "empty", 0, 0)];

	const found: ShapeViolation[] = [];
	found.push(...over(label, "words", rules.words, wordCount));
	found.push(...over(label, "sentences", rules.sentences, sentences.length));
	const code = prose.match(CODE_SPAN)?.length ?? 0;
	found.push(...over(label, "codeSpans", rules.codeSpans, code));
	const lines = prose.split("\n");
	const items = lines.filter((l) => LIST_ITEM.test(l)).length;
	found.push(...over(label, "bullets", rules.bullets, items));
	const links = prose.match(LINK)?.length ?? 0;
	found.push(...over(label, "links", rules.links, links));
	if (rules.noArtifactLists) {
		const labelled = lines.filter((l) => ARTIFACT_LABEL.test(l));
		if (labelled.length > 0) {
			found.push(
				violation(label, "artifactLists", 0, labelled.length, labelled[0]),
			);
		}
	}
	for (const problem of wordingProblems(prose, rules)) {
		found.push({
			...violation(label, problem.rule, 0, 1, problem.sentence),
			word: problem.word,
		});
	}
	if (sentenceWords !== undefined) {
		for (const sentence of sentences) {
			const n = countWords(sentence);
			if (n > sentenceWords) {
				found.push(
					violation(label, "sentenceWords", sentenceWords, n, sentence),
				);
			}
		}
	}
	return found;
}

/** Whether a change of this size is given the room its depth allows. */
function isLarge(depth: DepthShape, size: ChangeSize | undefined): boolean {
	return size !== undefined && "lines" in size && size.lines >= depth.fromLines;
}

/** Why a change of this size, or of none, was given no depth. */
function whyShallow(depth: DepthShape, size: ChangeSize | undefined): string {
	if (size === undefined) return UNMEASURED;
	if ("unknown" in size) return size.unknown;
	return `it has ${size.lines} changed lines, and depth starts at ${depth.fromLines}`;
}

/** Every way a results table breaks its limits, or sits where none may. */
function tableViolations(
	label: string,
	tables: readonly Table[],
	allowed: boolean,
	depth: DepthShape,
): ShapeViolation[] {
	if (!allowed) {
		return tables.length > 0
			? [violation(label, "tablePlace", 0, tables.length)]
			: [];
	}
	const found: ShapeViolation[] = [];
	for (const table of tables) {
		found.push(...over(label, "tableRows", depth.tableRows, table.rows.length));
		const longest = Math.max(
			0,
			...[table.header, ...table.rows].flat().map((cell) => countWords(cell)),
		);
		found.push(...over(label, "cellWords", depth.cellWords, longest));
		const bare = table.rows.filter((row) => !/\p{N}/u.test(row.join(" ")));
		if (bare.length > 0) {
			found.push(
				violation(label, "tableNumbers", 0, bare.length, bare[0]?.join(" | ")),
			);
		}
		if (!table.followed) found.push(violation(label, "tableAfter", 0, 1));
	}
	return found;
}

/**
 * Every way a large change's section breaks its depth: the opening held
 * to the section's own rules, then each part to the part's.
 */
function deepViolations(
	heading: string,
	text: string,
	rules: SectionShape,
	shape: BodyShape,
	depth: DepthShape,
): ShapeViolation[] {
	const { opening, parts } = partsOf(text, depth.partHashes);
	const tablesAllowed =
		heading === depth.tableIn.replace(VARIATION_SELECTOR, "");
	const found: ShapeViolation[] = [];

	const top = tablesOf(opening);
	found.push(...proseViolations(heading, top.rest, rules, shape.sentenceWords));
	found.push(...tableViolations(heading, top.tables, tablesAllowed, depth));
	found.push(...over(heading, "parts", depth.parts, parts.length));

	const partRules: SectionShape = {
		words: depth.partWords,
		noArtifactLists: true,
	};
	for (const { title, text: under } of parts) {
		const label = `${heading} / ${title}`;
		const { tables, rest } = tablesOf(under);
		found.push(...proseViolations(label, rest, partRules, shape.sentenceWords));
		found.push(...tableViolations(label, tables, tablesAllowed, depth));
	}
	return found;
}

/** References to a repository's markdown documents, which a large description may not lean on. */
function docReferences(heading: string, text: string): ShapeViolation[] {
	const found = text.replace(FENCE, "").match(DOC_REFERENCE) ?? [];
	return found.length > 0
		? [violation(heading, "docLinks", 0, found.length, found[0]?.trim())]
		: [];
}

/**
 * Whether a body asks for a large change's depth: a part under one of
 * the sections that may have them. Only then is a change's size worth
 * measuring, since an ordinary body is held to the ordinary shape
 * whatever its size.
 */
export function usesDepth(body: string, shape: BodyShape): boolean {
	const depth = shape.depth;
	if (depth === undefined) return false;
	return split(body, depth).some(
		({ heading, text }) =>
			isPartHeading(depth.partHashes, heading, depth) &&
			partsOf(text, depth.partHashes).parts.length > 0,
	);
}

/**
 * Every way the body breaks its shape, in reading order. Empty when it
 * keeps it. The size is the change's as the caller measured it; left
 * out, the body is held to the ordinary shape, and any depth it asks
 * for is refused with a pointer to a path that measures.
 */
export function detectShapeViolations(
	body: string,
	shape: BodyShape,
	size?: ChangeSize,
): ShapeViolation[] {
	const depth = shape.depth;
	const [above, ...sections] = split(body, depth);
	const large = depth !== undefined && isLarge(depth, size);
	const found: ShapeViolation[] = [];

	if (shape.headingFirst && sections.length > 0 && above?.text.trim()) {
		const first = above.text.trim().split("\n")[0] ?? "";
		found.push(violation("", "above", 0, countWords(above.text), first));
	}

	for (const { heading, text } of sections) {
		const rules = shape.sections[heading];
		if (!rules) continue;
		const deepens =
			depth !== undefined && isPartHeading(depth.partHashes, heading, depth);
		if (large && depth !== undefined) {
			found.push(...docReferences(heading, text));
			if (deepens) {
				found.push(...deepViolations(heading, text, rules, shape, depth));
				continue;
			}
		}
		const parts =
			deepens && depth !== undefined
				? partsOf(text, depth.partHashes).parts.length
				: 0;
		if (parts > 0 && depth !== undefined) {
			found.push({
				...violation(heading, "depth", depth.fromLines, parts),
				why: whyShallow(depth, size),
			});
		}
		found.push(...proseViolations(heading, text, rules, shape.sentenceWords));
	}
	return found;
}
