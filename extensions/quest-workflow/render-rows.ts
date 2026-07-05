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
	priority: string;
	title: string | null;
}

/**
 * Render one brief row as a single parsable line. The kind,
 * status and priority are spelled out as `key=value` words
 * rather than glyphs so the agent reads them without a legend;
 * the glyph form lives in {@link renderRowGlyph} for the
 * human-facing expanded view.
 */
export function renderRowBrief(row: QuestRowBrief): string {
	const title = row.title ?? "(untitled)";
	return `${row.id} kind=${row.kind} status=${row.status} priority=${row.priority} ${title}`;
}

/** Render one row in the glyph form for the expanded human view. */
export function renderRowGlyph(row: QuestRowBrief): string {
	const kindGlyph = KIND_GLYPHS[row.kind];
	const statusGlyph = STATUS_GLYPHS[row.status];
	const title = row.title ?? "(untitled)";
	return `${row.id} ${kindGlyph} ${statusGlyph} ${title}`;
}

/** A legend mapping each kind and status glyph to its word. */
export function questGlyphLegend(): string {
	const kinds = Object.entries(KIND_GLYPHS)
		.map(([word, glyph]) => `${glyph} ${word}`)
		.join("  ");
	const statuses = Object.entries(STATUS_GLYPHS)
		.map(([word, glyph]) => `${glyph} ${word}`)
		.join("  ");
	return `Legend -- kind: ${kinds}; status: ${statuses}`;
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
	const lines = [renderRowGlyph(row)];
	const parent = row.parent ?? "none";
	// Sparse rows (e.g. the synthetic (orphans) tree node)
	// arrive with an empty updated; suppress the dangling
	// `updated:` field rather than print an empty value.
	const metaParts = [`priority: ${row.priority}`, `parent: ${parent}`];
	if (row.updated) metaParts.push(`updated: ${row.updated}`);
	lines.push(`  ${metaParts.join("  ")}`);
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
 * A row in the listing payload that `renderResult` reads
 * to paint the expanded view on Ctrl-O. Each row already
 * carries every field `renderRowExpanded` needs, so the
 * renderer does no further disk IO when toggling.
 */
export interface ListingFlatRow extends QuestRowExpanded {
	/** Indent depth, used by tree-shaped listings. Flat
	 * listings leave this as 0. */
	depth: number;
}

/**
 * The structured payload a listing verb attaches to
 * `result.details.listing`. `renderResult` reads this on
 * Ctrl-O and reformats the rows into the expanded view
 * without re-running discovery.
 */
export interface ListingDetails {
	rows: ListingFlatRow[];
	total: number;
	offset: number;
	limit: number;
	remaining: number;
}

/**
 * Render a listing as expanded blocks, one block per row,
 * separated by blank lines. Tree-shaped listings indent
 * each block by the row's `depth`. The trailing pagination
 * hint comes from `renderListing` so the format matches
 * the brief view.
 */
export function renderListingExpanded(details: ListingDetails): string {
	if (details.rows.length === 0) {
		if (details.total === 0) return "(no matches)";
		return `(empty page; ${details.total} total, try offset 0)`;
	}
	const blocks = details.rows.map((row) => {
		const block = renderRowExpanded(row);
		if (row.depth <= 0) return block;
		const indent = "  ".repeat(row.depth);
		return block
			.split("\n")
			.map((line) => `${indent}${line}`)
			.join("\n");
	});
	const body = blocks.join("\n\n");
	const legend = questGlyphLegend();
	if (details.remaining === 0) return `${legend}\n\n${body}`;
	const nextOffset = details.offset + details.rows.length;
	return `${legend}\n\n${body}\n\n... and ${details.remaining} more (offset ${nextOffset} to continue)`;
}

/**
 * Join already-rendered row strings into one listing block,
 * appending the "... and N more" tail when more rows exist
 * past the current page.
 *
 * Empty-page output discriminates between the two reasons:
 *
 * - The whole set really is empty: returns `(no matches)`.
 * - The user paged past the end of a non-empty set: returns
 *   a hint about the total and a working offset to start
 *   from. Without this, an agent paging through a list got
 *   `(no matches)` on the trailing page and concluded
 *   nothing was there.
 */
export function renderListing<T>(
	rendered: string[],
	view: PaginationView<T>,
): string {
	if (rendered.length === 0) {
		if (view.total === 0) return "(no matches)";
		return `(empty page; ${view.total} total, try offset 0)`;
	}
	const body = rendered.join("\n");
	if (view.remaining === 0) return body;
	const nextOffset = view.offset + view.rows.length;
	return `${body}\n\n... and ${view.remaining} more (offset ${nextOffset} to continue)`;
}

/**
 * Defensive shape check for a listing payload. The
 * `renderResult` callback runs inside pi's render loop,
 * where a thrown error tanks the frame; trust the cast
 * only after the shape clears.
 */
export function isListingDetails(value: unknown): value is ListingDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ListingDetails>;
	return (
		Array.isArray(v.rows) &&
		typeof v.total === "number" &&
		typeof v.offset === "number" &&
		typeof v.limit === "number" &&
		typeof v.remaining === "number"
	);
}

/**
 * One-line preview of a listing result for the collapsed
 * (default) tool widget. Shows the first brief row and a
 * row-count suffix so the human can tell how much more
 * is hidden before pressing Ctrl-O. The count combines
 * the remaining rows on this page with whatever paging
 * left behind, so a paged result reads honestly. Empty
 * listings fall back to the rendered content, which
 * already says `(no matches)` or `(no quests)`.
 */
export function collapseListingPreview(
	listing: ListingDetails,
	content: string,
): string {
	if (listing.rows.length === 0) return content.split("\n")[0];
	const firstRow = content.split("\n")[0];
	const more = listing.rows.length - 1 + listing.remaining;
	if (more <= 0) return firstRow;
	return `${firstRow} (+${more} more)`;
}

/**
 * Collapse a multi-line, non-listing result (show, who, links) for the
 * human TUI. Expanded or single-line content is returned whole; a
 * multi-line result collapses to its first line plus a count of the
 * hidden lines and an expand hint, so the reader knows the rich output
 * is there and how to see it. This is the counterpart that keeps the
 * human render and the agent result fed from one text, rather than
 * silently dropping everything past the first line for the human.
 */
export function collapseText(
	content: string,
	expanded: boolean,
	expandHint: string,
): string {
	if (expanded) return content;
	const lines = content.split("\n");
	if (lines.length <= 1) return content;
	const hidden = lines.length - 1;
	return `${lines[0]} (+${hidden} more line${hidden === 1 ? "" : "s"}, ${expandHint})`;
}
