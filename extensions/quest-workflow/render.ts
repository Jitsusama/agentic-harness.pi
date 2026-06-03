/**
 * Status line and widget rendering for the quest workflow.
 *
 * Two surfaces:
 *
 * - Status line: a constant "Quest" label beside a kind
 *   glyph (◇/◈/◆ for sidequest/subquest/quest) and a
 *   status glyph (○ ◔ ◑ ◕ ● for active → concluded).
 * - Widget line: a progress glyph for the focused
 *   document's checkboxes (or the quest's Milestones when
 *   no document is focused), followed by the quest title
 *   and, when present, the focused document's kind label
 *   and stage.
 *
 * Both fall silent when no quest is loaded.
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

const GLYPH_COLS = 2;

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
	paused: { char: "\u25d4", token: "dim" }, // ◔
	blocked: { char: "\u25d1", token: "warning" }, // ◑
	concluded: { char: "\u25cf", token: "success" }, // ●
	retired: { char: "\u25d5", token: "dim" }, // ◕
};

const STAGE_LABELS: Record<Stage, string> = {
	idle: "",
	think: "think",
	draft: "draft",
	build: "build",
	concluded: "done",
	retired: "retired",
};

const DOCUMENT_LABELS: Record<DocumentKind, string> = {
	plan: "PLAN",
	research: "RSCH",
	brief: "BRIF",
	report: "RPRT",
};

const STATUS_LABEL = "Quest";

/** Status-line indicator: kind + status glyph + steady "Quest" label. */
export function renderStatus(
	state: {
		questId: string | null;
		questKind: QuestKind | null;
		questStatus: QuestStatus | null;
	},
	theme: Theme,
): string | undefined {
	if (!state.questId || !state.questKind || !state.questStatus)
		return undefined;
	const kindGlyph = KIND_GLYPHS[state.questKind];
	const statusGlyph = STATUS_GLYPHS[state.questStatus];
	return `${theme.fg("accent", kindGlyph)} ${theme.fg(statusGlyph.token, statusGlyph.char)} ${theme.fg("muted", STATUS_LABEL)}`;
}

const FILL = ["\u25cb", "\u25d4", "\u25d1", "\u25d5", "\u25cf"];

function progressGlyph(done: number, total: number): Glyph {
	if (total <= 0 || done <= 0) return { char: FILL[0], token: "accent" };
	if (done >= total) return { char: FILL[4], token: "success" };
	const ratio = done / total;
	const bucket = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : 3;
	return { char: FILL[bucket], token: "accent" };
}

function progressText(done: number, total: number): string {
	if (total <= 0) return "";
	const step = done >= total ? total : done + 1;
	return ` \u00b7 ${step}/${total}`;
}

/** Inputs the widget needs to paint a line. */
export interface WidgetInput {
	questId: string | null;
	questTitle: string | null;
	documentKind: DocumentKind | null;
	documentStage: Stage;
	done: number;
	total: number;
}

/** Widget line. Returns empty when no quest is loaded. */
export function renderWidget(
	input: WidgetInput,
	theme: Theme,
	width: number,
): string[] {
	if (!input.questId) return [];
	const { char, token } = progressGlyph(input.done, input.total);
	const colouredGlyph = theme.fg(token, char);
	let label = input.questId;
	if (input.documentKind) {
		const kindLabel = DOCUMENT_LABELS[input.documentKind];
		const stage = STAGE_LABELS[input.documentStage];
		label += ` \u00b7 ${kindLabel}`;
		if (stage) label += `(${stage})`;
	}
	label += progressText(input.done, input.total);
	const prefix = `${colouredGlyph} ${theme.fg("muted", label)}`;
	if (!input.questTitle) return [truncateToWidth(prefix, width)];
	const room = Math.max(0, width - GLYPH_COLS - (label.length + 1));
	const line = `${prefix} ${theme.fg("dim", truncateToWidth(input.questTitle, room))}`;
	return [truncateToWidth(line, width)];
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
