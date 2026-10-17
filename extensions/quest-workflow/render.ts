/**
 * Visual surfaces for the quest workflow.
 *
 * Three scopes, cleanly separated:
 *
 * - Pi session name: a Title Case slice of the quest's
 *   title, truncated to 20 characters with an ellipsis
 *   when longer. No id, no kind glyph. The terminal-tab
 *   label.
 * - Widget: the quest's one line. Kind glyph and status
 *   glyph, the quest title, the focused document's
 *   activity (stage verb, kind noun, doc title), the step
 *   count and the prose of the next unchecked checkbox,
 *   with the quest id right-aligned and dimmed.
 *
 * Nothing goes on the shared footer. It used to carry the
 * two glyphs and the full quest id, which put the quest in
 * two places at once and spent twenty columns of a line
 * that never shortens an extension's status. The id now
 * sits on the quest's own line, which costs no row the
 * screen did not already give the quest.
 *
 * All surfaces fall silent when no quest is loaded.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { QuestEntry } from "../../lib/internal/quest/discovery.ts";
import {
	QUEST_KIND_MARK,
	QUEST_STATUS_MARK,
} from "../../lib/internal/quest/quest-marks.ts";
import type {
	DocumentKind,
	QuestKind,
	QuestStatus,
} from "../../lib/quest/index.ts";
import type { Stage } from "./machine.ts";

/** The colour each status's mark is drawn in; the marks are the quest's own. */
const STATUS_COLOUR: Record<QuestStatus, "dim" | "warning" | "success"> = {
	active: "warning",
	paused: "dim",
	blocked: "warning",
	concluded: "success",
	retired: "dim",
};

/**
 * Stage verb in Title Case, e.g. `think` -> `Thinking On`,
 * `draft` -> `Drafting`. The verb pairs with the kind noun
 * to read as prose: "Drafting Plan: ...".
 */
const STAGE_VERB: Record<Stage, string> = {
	idle: "",
	think: "Thinking On",
	draft: "Drafting",
	build: "Building",
	concluded: "Concluded",
	retired: "Retired",
};

const KIND_NOUN: Record<DocumentKind, string> = {
	plan: "Plan",
	research: "Research",
	brief: "Brief",
	report: "Report",
};

const SESSION_NAME_LIMIT = 20;

/**
 * Hard cap on visible characters in the widget's arrow
 * trailer (the `→ first-unchecked-item` segment). Plan
 * checklist items are written as sentences because the
 * plan is a document for humans to read, but the widget
 * is status chrome: it should hint at next-up without
 * painting a paragraph. 40 visible chars fits the useful
 * leading words in even the narrowest reasonable
 * terminal and stays tight in wide ones.
 */
const WIDGET_TRAILER_LIMIT = 40;

/**
 * Strip markdown emphasis chrome that bleeds through from
 * checklist item source text into the widget trailer.
 * Backticks, asterisks and underscores are wrappers when
 * they sit at non-word edges, content when they don't:
 * an underscore inside `internal_quest` is part of an
 * identifier, not chrome. The non-word anchors keep
 * identifiers intact while still stripping markers that
 * sit next to whitespace, punctuation or string edges.
 */
function stripChrome(source: string): string {
	return source.replace(/(?<=^|\W)[`*_]+|[`*_]+(?=\W|$)/g, "");
}

/**
 * Truncate to `limit` visible characters, appending an
 * ellipsis when the source is longer. Operates on the
 * stripped string so the ellipsis represents real lost
 * content, not just chrome.
 */
function truncateTrailer(source: string, limit: number): string {
	const stripped = stripChrome(source).trim();
	if (stripped.length <= limit) return stripped;
	// One column, not three periods: the slice leaves room for exactly
	// one character so the result is exactly `limit` wide.
	return `${stripped.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Pi renders widget lines through `new Text(line, 1, 0)`,
 * with `1` being a one-column left indent. The widget's
 * effective render width is therefore one column less
 * than the terminal width, and the truncation must use
 * the smaller number or pi's Text component wraps the
 * overflow onto a second line.
 */
const WIDGET_INDENT_COLS = 1;

/**
 * The session-name label pi sets on the terminal tab when a quest
 * loads. When a quest id is supplied, the stable short id (the
 * trailing segment of `QEST-YYYYMMDD-XXXXXX`) leads so a person
 * reading their terminal's tabs can identify the quest without a query; the id is
 * kept whole and only the Title Case title is truncated to fit
 * `SESSION_NAME_LIMIT`. With no id the title alone is used, and with
 * neither the result is `undefined`.
 */
export function sessionNameFor(
	title: string | null,
	questId?: string,
): string | undefined {
	const short = questId ? shortQuestId(questId) : undefined;
	const cased = title ? titleCase(title) : undefined;
	if (!short && !cased) return undefined;
	if (!short) return truncateLabel(cased ?? "");
	if (!cased) return short;
	// The id anchors the label, so spend the remaining budget on the
	// title and drop it entirely rather than crowd the id out.
	const room = SESSION_NAME_LIMIT - short.length - 1;
	if (room <= 0) return short;
	return `${short} ${truncateLabel(cased, room)}`;
}

/** The stable short id: the trailing segment of a quest id. */
function shortQuestId(questId: string): string {
	const segments = questId.split("-");
	return segments[segments.length - 1] || questId;
}

/** Title Case text truncated to a budget, with an ellipsis when cut. */
function truncateLabel(text: string, limit = SESSION_NAME_LIMIT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}\u2026`;
}

function titleCase(text: string): string {
	return text
		.split(/(\s+)/)
		.map((piece) => {
			if (/^\s+$/.test(piece)) return piece;
			if (piece.length === 0) return piece;
			return piece[0].toUpperCase() + piece.slice(1);
		})
		.join("");
}

/**
 * The quest's two marks: its kind, and its status in the status's
 * colour. Only the glyphs carry colour; the text beside them stays
 * quiet. The kind is muted: the line sits above the editor all session,
 * and the accent belongs where the keys go.
 */
function questMarks(
	kind: QuestKind | null | undefined,
	status: QuestStatus | null | undefined,
	theme: Theme,
): string {
	const marks: string[] = [];
	if (kind) marks.push(theme.fg("muted", QUEST_KIND_MARK[kind]));
	if (status) {
		marks.push(theme.fg(STATUS_COLOUR[status], QUEST_STATUS_MARK[status]));
	}
	return marks.length > 0 ? `${marks.join(" ")} ` : "";
}

/** Inputs the widget needs to paint a line. */
export interface WidgetInput {
	questId: string | null;
	questKind?: QuestKind | null;
	questStatus?: QuestStatus | null;
	questTitle: string | null;
	documentKind: DocumentKind | null;
	documentStage: Stage;
	documentTitle: string | null;
	done: number;
	total: number;
	currentItem?: string;
}

/** Columns always kept clear between the activity and the quest id. */
const ID_GAP_COLS = 3;

/**
 * The narrowest a shortened quest title may get before it goes
 * entirely: below this an ellipsis is most of what is left, which
 * tells the reader nothing the id beside it does not.
 */
const MIN_TITLE_COLS = 8;

/** Separates the line's activity pieces. */
const PIECE_SEP = " \u00b7 ";

/**
 * Widget line. Returns empty when no quest is loaded.
 *
 * It reads, left to right: the quest's kind and status glyphs, the
 * quest title, the focused document (`{Stage-Verb} {Kind-Noun}:
 * {Doc Title}`, or the title alone once it is concluded or retired),
 * the step count, and an arrow to the next unchecked item. The
 * quest id sits right-aligned and dimmed, since it is how the quest
 * is named everywhere else.
 *
 * The step is the focused document's, or the quest README's when
 * nothing is focused, and it is left out only when there are no
 * checkboxes to count.
 *
 * When the line is short of room it gives way in this order: the
 * next item goes first, then the document, then the quest title
 * shortens and finally goes. The marks, the step count and the id
 * stay, so the line always says which quest and how far along.
 */
export function renderWidget(
	input: WidgetInput,
	theme: Theme,
	width: number,
): string[] {
	if (!input.questId) return [];
	const budget = Math.max(0, width - WIDGET_INDENT_COLS);
	const marks = questMarks(input.questKind, input.questStatus, theme);
	const id = input.questId;
	const title = input.questTitle ?? "(untitled quest)";
	const document = documentHead(input);
	const step = stepText(input.done, input.total);
	const next = progressTrailer(input);

	// The marks, the gap and the id never give way, so the activity
	// shares whatever they leave.
	const room = budget - visibleWidth(marks) - ID_GAP_COLS - visibleWidth(id);
	const layouts = [
		activity([title, document], step, next),
		activity([title, document], step, ""),
		activity([title], step, ""),
	];
	let text = layouts.find((candidate) => visibleWidth(candidate) <= room);
	if (text === undefined) {
		const stepCols = step ? visibleWidth(PIECE_SEP) + visibleWidth(step) : 0;
		const titleRoom = room - stepCols;
		text =
			titleRoom >= MIN_TITLE_COLS
				? activity([shortenTo(title, titleRoom)], step, "")
				: activity([], step, "");
	}

	const left = `${marks}${theme.fg("muted", text)}`;
	const pad = Math.max(
		ID_GAP_COLS,
		budget - visibleWidth(left) - visibleWidth(id),
	);
	// Only a terminal too narrow for the marks, the step and the id
	// reaches the cut, and there it is the safe thing rather than
	// the designed one: a wrapped widget pushes the editor down.
	return [
		truncateToWidth(`${left}${" ".repeat(pad)}${theme.fg("dim", id)}`, budget),
	];
}

/**
 * The activity text: the pieces present, joined, then the step count
 * and the arrow to the next item.
 */
function activity(
	pieces: readonly (string | undefined)[],
	step: string,
	next: string,
): string {
	const present = pieces.filter((piece): piece is string => Boolean(piece));
	if (step) present.push(step);
	return `${present.join(PIECE_SEP)}${next}`;
}

/**
 * Plain text cut to `cols` visible columns, ending in one ellipsis.
 * The text is still plain at this point, so cutting it here leaves
 * no reset code in the middle of the muted span the way cutting a
 * coloured line would.
 */
function shortenTo(text: string, cols: number): string {
	if (visibleWidth(text) <= cols) return text;
	let kept = "";
	for (const { segment } of new Intl.Segmenter().segment(text)) {
		if (visibleWidth(kept + segment) > cols - 1) break;
		kept += segment;
	}
	return `${kept.trimEnd()}\u2026`;
}

/** The focused document's part of the line, or nothing when none is. */
function documentHead(input: WidgetInput): string | undefined {
	if (!input.documentKind || !input.documentTitle) return undefined;
	const stageVerb = STAGE_VERB[input.documentStage];
	const kindNoun = KIND_NOUN[input.documentKind];
	return stageVerb &&
		input.documentStage !== "concluded" &&
		input.documentStage !== "retired"
		? `${stageVerb} ${kindNoun}: ${input.documentTitle}`
		: input.documentTitle;
}

function stepText(done: number, total: number): string {
	if (total <= 0) return "";
	const step = done >= total ? total : done + 1;
	return `${step}/${total}`;
}

function progressTrailer(input: WidgetInput): string {
	if (input.total <= 0) return "";
	if (input.done >= input.total) return "";
	if (!input.currentItem) return "";
	const tightened = truncateTrailer(input.currentItem, WIDGET_TRAILER_LIMIT);
	if (!tightened) return "";
	return ` \u2192 ${tightened}`;
}

/** Format a list of quests as plain-text rows for /quest-list. */
export function formatQuestList(entries: QuestEntry[]): string {
	const idWidth = Math.max(...entries.map((e) => e.doc.frontMatter.id.length));
	const statusWidth = Math.max(
		...entries.map((e) => e.doc.frontMatter.status.length),
	);
	return entries
		.map((e) => {
			const fm = e.doc.frontMatter;
			const title = e.doc.title ?? "(untitled)";
			return `${fm.id.padEnd(idWidth)}  ${fm.kind.padEnd(8)}  ${fm.status.padEnd(statusWidth)}  ${fm.priority.padEnd(8)}  ${title}`;
		})
		.join("\n");
}
