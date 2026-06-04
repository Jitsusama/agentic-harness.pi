/**
 * Visual surfaces for the quest workflow.
 *
 * Three scopes, cleanly separated:
 *
 * - Pi session name: a Title Case slice of the quest's
 *   title, truncated to 20 characters with an ellipsis
 *   when longer. No id, no kind glyph. The terminal-tab
 *   label.
 * - Status line: the quest's identity. Kind glyph,
 *   status glyph and either the full quest id (when the
 *   width budget allows) or the literal word "Quest".
 * - Widget: the focused document's activity. Stage verb,
 *   kind noun, doc title, step count and the prose of
 *   the next unchecked checkbox. No glyphs; the status
 *   line owns the visual glyph footprint.
 *
 * All surfaces fall silent when no quest is loaded.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

import type { QuestEntry } from "../../lib/internal/quest/discovery.js";
import type {
	DocumentKind,
	QuestKind,
	QuestStatus,
} from "../../lib/quest/index.js";
import type { Stage } from "./machine.js";

const KIND_GLYPHS: Record<QuestKind, string> = {
	quest: "\u25c6", // ◆
	subquest: "\u25c8", // ◈
	sidequest: "\u25c7", // ◇
};

type GlyphToken = "dim" | "warning" | "accent" | "success";

interface Glyph {
	char: string;
	token: GlyphToken;
}

const STATUS_GLYPHS: Record<QuestStatus, Glyph> = {
	active: { char: "\u25cb", token: "warning" }, // ○
	paused: { char: "\u25d0", token: "dim" }, // ◐
	blocked: { char: "\u2298", token: "warning" }, // ⊘
	concluded: { char: "\u25cf", token: "success" }, // ●
	retired: { char: "\u2297", token: "dim" }, // ⊗
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
const STATUS_NARROW_LABEL = "Quest";

/**
 * Terminal width below which the status line collapses
 * the id to the literal `Quest` label. The status line
 * shares space with whatever other extensions paint, so
 * the threshold is set against the whole terminal width
 * rather than against the budget left after other
 * segments: any column count below this is the regime
 * where the id crowds out everything else anyway.
 */
const STATUS_NARROW_THRESHOLD = 60;

/**
 * The session-name label pi sets on the terminal tab when
 * a quest loads. A Title Case slice of the title truncated
 * to `SESSION_NAME_LIMIT` characters; longer titles take
 * 19 characters plus an ellipsis. Returns `undefined`
 * when no title is supplied.
 */
export function sessionNameFor(title: string | null): string | undefined {
	if (!title) return undefined;
	const cased = titleCase(title);
	if (cased.length <= SESSION_NAME_LIMIT) return cased;
	return `${cased.slice(0, SESSION_NAME_LIMIT - 1)}\u2026`;
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
 * Status-line render: kind glyph, status glyph, and the
 * quest id (when the width budget allows) or the literal
 * "Quest" label when it does not.
 */
export function renderStatus(
	state: {
		questId: string | null;
		questKind: QuestKind | null;
		questStatus: QuestStatus | null;
	},
	theme: Theme,
	width?: number,
): string | undefined {
	if (!state.questId || !state.questKind || !state.questStatus)
		return undefined;
	const kindGlyph = theme.fg("accent", KIND_GLYPHS[state.questKind]);
	const statusGlyph = STATUS_GLYPHS[state.questStatus];
	const colouredStatus = theme.fg(statusGlyph.token, statusGlyph.char);
	const tail =
		width !== undefined && width < STATUS_NARROW_THRESHOLD
			? STATUS_NARROW_LABEL
			: state.questId;
	return `${kindGlyph} ${colouredStatus} ${theme.fg("muted", tail)}`;
}

/** Inputs the widget needs to paint a line. */
export interface WidgetInput {
	questId: string | null;
	questTitle: string | null;
	documentKind: DocumentKind | null;
	documentStage: Stage;
	documentTitle: string | null;
	done: number;
	total: number;
	currentItem?: string;
}

/**
 * Widget line. Returns empty when no quest is loaded.
 *
 * Three layouts depending on what's focused:
 *
 * 1. Focused document, mid-stage: `{Stage-Verb} {Kind-Noun}:
 *    {Doc Title} \u00b7 {step}/{total} \u2192 {next item}`
 * 2. Focused document, concluded/retired: drops the
 *    `{Stage-Verb} {Kind-Noun}:` prefix and shows just
 *    the doc title plus progress.
 * 3. No focused document: falls back to the quest title
 *    plus the quest README's own checkbox count.
 *
 * When the underlying body has no checkboxes the count
 * segment and arrow drop entirely; the line reads as
 * prose with no trailing noise.
 */
export function renderWidget(
	input: WidgetInput,
	theme: Theme,
	width: number,
): string[] {
	if (!input.questId) return [];
	const line = buildWidgetLine(input);
	const coloured = theme.fg("muted", line);
	return [truncateToWidth(coloured, width)];
}

function buildWidgetLine(input: WidgetInput): string {
	const counter = progressText(input.done, input.total);
	const trailer = progressTrailer(input);
	if (input.documentKind && input.documentTitle) {
		const stageVerb = STAGE_VERB[input.documentStage];
		const kindNoun = KIND_NOUN[input.documentKind];
		const head =
			stageVerb &&
			input.documentStage !== "concluded" &&
			input.documentStage !== "retired"
				? `${stageVerb} ${kindNoun}: ${input.documentTitle}`
				: input.documentTitle;
		return `${head}${counter}${trailer}`;
	}
	const title = input.questTitle ?? "(untitled quest)";
	return `${title}${counter}${trailer}`;
}

function progressText(done: number, total: number): string {
	if (total <= 0) return "";
	const step = done >= total ? total : done + 1;
	return ` \u00b7 ${step}/${total}`;
}

function progressTrailer(input: WidgetInput): string {
	if (input.total <= 0) return "";
	if (input.done >= input.total) return "";
	if (!input.currentItem) return "";
	return ` \u2192 ${input.currentItem}`;
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
