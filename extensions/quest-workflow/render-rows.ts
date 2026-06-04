/**
 * Plain-text row rendering for the listing-style query
 * verbs (`list`, `find`, `who`, `links`, `tree`, `expand`).
 *
 * Two shapes:
 *
 * - Brief: one line per row, `{id} {kindGlyph} {statusGlyph} {title}`.
 *   This is what the agent reads first and acts on. The
 *   glyphs are picked so a quest and a sidequest are
 *   distinguishable at a glance without colour.
 * - Expanded: brief plus key front-matter (priority,
 *   parent, updated), summary line, cast bullets, recent
 *   journey entries and document list. What the user
 *   wants when they need the whole picture without
 *   leaving the tool.
 *
 * Plus a small pagination helper so every verb caps its
 * brief output at the same default and tails with a
 * single uniform "... and N more" hint.
 */

import type { QuestKind, QuestStatus } from "../../lib/quest/index.js";

const KIND_GLYPHS: Record<QuestKind, string> = {
	quest: "\u25c6", // ◆
	subquest: "\u25c8", // ◈
	sidequest: "\u25c7", // ◇
};

const STATUS_GLYPHS: Record<QuestStatus, string> = {
	active: "\u25cb", // ○
	paused: "\u25d0", // ◐
	blocked: "\u2298", // ⊘
	concluded: "\u25cf", // ●
	retired: "\u2297", // ⊗
};

/** The default cap on rows returned in brief mode. */
export const DEFAULT_LISTING_LIMIT = 25;

/** Smallest fields a brief row needs. */
export interface QuestRowBrief {
	id: string;
	kind: QuestKind;
	status: QuestStatus;
	title: string | null;
}

/** Render one brief row as a single line. */
export function renderRowBrief(row: QuestRowBrief): string {
	const kindGlyph = KIND_GLYPHS[row.kind];
	const statusGlyph = STATUS_GLYPHS[row.status];
	const title = row.title ?? "(untitled)";
	return `${row.id} ${kindGlyph} ${statusGlyph} ${title}`;
}

/** A document listed under a quest. */
export interface RowDocument {
	id: string;
	stage: string;
}

/** A cast bullet, brief. */
export interface RowCast {
	role: string;
	subject: string;
}

/** A journey entry, brief. */
export interface RowJourney {
	date: string;
	prose: string;
}

/** All the fields the expanded row uses. */
export interface QuestRowExpanded extends QuestRowBrief {
	priority: string;
	parent: string | null;
	updated: string;
	summary?: string;
	cast?: RowCast[];
	documents?: RowDocument[];
	recentJourney?: RowJourney[];
}

/** Render one expanded row as a small block of lines. */
export function renderRowExpanded(row: QuestRowExpanded): string {
	const lines = [renderRowBrief(row)];
	const parent = row.parent ?? "none";
	lines.push(
		`  priority: ${row.priority}  parent: ${parent}  updated: ${row.updated}`,
	);
	if (row.summary) lines.push(`  summary: ${row.summary}`);
	if (row.cast && row.cast.length > 0) {
		const cast = row.cast.map((c) => `${c.subject} (${c.role})`).join(", ");
		lines.push(`  cast: ${cast}`);
	}
	if (row.documents && row.documents.length > 0) {
		const docs = row.documents.map((d) => `${d.id} (${d.stage})`).join(", ");
		lines.push(`  docs: ${docs}`);
	}
	if (row.recentJourney && row.recentJourney.length > 0) {
		lines.push("  recent journey:");
		for (const j of row.recentJourney) {
			lines.push(`    ${j.date}: ${j.prose}`);
		}
	}
	return lines.join("\n");
}

/** Pagination request. */
export interface PaginationOpts {
	limit?: number;
	offset?: number;
	defaultLimit?: number;
}

/** Pagination result, used to render the trailing hint. */
export interface PaginationView<T> {
	rows: T[];
	total: number;
	offset: number;
	limit: number;
	remaining: number;
}

/**
 * Slice `items` according to `limit` and `offset`. Both
 * default to gentle values: limit to `DEFAULT_LISTING_LIMIT`
 * (or the caller's override) and offset to zero. Negative
 * inputs are clamped.
 */
export function paginate<T>(
	items: T[],
	opts: PaginationOpts = {},
): PaginationView<T> {
	const limit = Math.max(
		1,
		opts.limit ?? opts.defaultLimit ?? DEFAULT_LISTING_LIMIT,
	);
	const offset = Math.max(0, opts.offset ?? 0);
	const rows = items.slice(offset, offset + limit);
	const remaining = Math.max(0, items.length - offset - rows.length);
	return { rows, total: items.length, offset, limit, remaining };
}

/**
 * Join already-rendered row strings into one listing block,
 * appending the "... and N more" tail when more rows exist
 * past the current page. Returns "(no matches)" on an
 * empty page; the caller wraps that in a success result so
 * the agent sees a positive shape even when nothing
 * matched.
 */
export function renderListing<T>(
	rendered: string[],
	view: PaginationView<T>,
): string {
	if (rendered.length === 0) return "(no matches)";
	const body = rendered.join("\n");
	if (view.remaining === 0) return body;
	const nextOffset = view.offset + view.rows.length;
	return `${body}\n\n... and ${view.remaining} more (offset ${nextOffset} to continue)`;
}
