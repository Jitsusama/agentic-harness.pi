/**
 * `notes find` / `notes show` / `notes tree` / `notes types`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	discoverNotes,
	type NoteEntry,
	type NoteIndex,
} from "../../internal/notes/discovery.ts";
import { NOTE_TYPES } from "../types.ts";
import { type NoteResult, type NoteToolParams, ok, refuse } from "./shared.ts";

/** Accept a full id, or an unambiguous prefix of one. */
export function resolveId(
	index: NoteIndex,
	ref: string,
): { id: string } | { error: string } {
	if (index.notes.has(ref)) return { id: ref };
	const matches = [...index.notes.keys()].filter(
		(id) => id.startsWith(ref) || id.includes(ref),
	);
	if (matches.length === 1) return { id: matches[0] };
	if (matches.length > 1) {
		return {
			error: `"${ref}" is ambiguous, matches: ${matches.slice(0, 10).join(", ")}`,
		};
	}
	return { error: `no note matches "${ref}"` };
}

function matchesFilters(
	entry: NoteEntry,
	index: NoteIndex,
	params: NoteToolParams,
): boolean {
	const fm = entry.doc.frontMatter;
	if (params.type && fm.type !== params.type) return false;
	if (params.tags && !fm.tags.includes(params.tags)) return false;
	if (params.parent) {
		const resolved = resolveId(index, params.parent);
		if ("error" in resolved) return false;
		if (fm.parent !== resolved.id) return false;
	}
	if (params.since && fm.created < params.since) return false;
	if (params.until && fm.created > params.until) return false;
	return true;
}

export function find(notesRoot: string, params: NoteToolParams): NoteResult {
	const { index } = discoverNotes(notesRoot);
	let results = [...index.notes.values()].filter((e) =>
		matchesFilters(e, index, params),
	);

	if (params.q) {
		const needle = params.q.toLowerCase();
		results = results.filter((e) => {
			const haystack =
				`${e.doc.frontMatter.title}\n${e.doc.body}`.toLowerCase();
			return haystack.includes(needle);
		});
	}

	results.sort((a, b) =>
		a.doc.frontMatter.created.localeCompare(b.doc.frontMatter.created),
	);
	if (params.limit) results = results.slice(0, params.limit);

	const rows = results.map((e) => ({
		id: e.doc.frontMatter.id,
		type: e.doc.frontMatter.type,
		created: e.doc.frontMatter.created,
		title: e.doc.frontMatter.title,
	}));
	return ok(`${rows.length} match(es)`, { count: rows.length, notes: rows });
}

export function show(notesRoot: string, params: NoteToolParams): NoteResult {
	if (!params.id) return refuse("show needs an id");
	const { index } = discoverNotes(notesRoot);
	const resolved = resolveId(index, params.id);
	if ("error" in resolved) return refuse(resolved.error);
	const path = join(notesRoot, resolved.id, "README.md");
	const text = readFileSync(path, "utf8");
	return ok(text, { id: resolved.id, path });
}

interface TreeRow {
	id: string;
	depth: number;
	type: string;
	title: string;
}

function renderSubtree(
	index: NoteIndex,
	id: string,
	depth: number,
	out: TreeRow[],
): void {
	const entry = index.notes.get(id);
	if (!entry) return;
	out.push({
		id,
		depth,
		type: entry.doc.frontMatter.type,
		title: entry.doc.frontMatter.title,
	});
	for (const childId of index.children.get(id) ?? []) {
		renderSubtree(index, childId, depth + 1, out);
	}
}

export function tree(notesRoot: string, params: NoteToolParams): NoteResult {
	const { index } = discoverNotes(notesRoot);
	const rows: TreeRow[] = [];

	if (params.id) {
		const resolved = resolveId(index, params.id);
		if ("error" in resolved) return refuse(resolved.error);
		renderSubtree(index, resolved.id, 0, rows);
	} else {
		for (const rootId of index.children.get("") ?? []) {
			renderSubtree(index, rootId, 0, rows);
		}
	}

	const message = rows
		.map((r) => `${"  ".repeat(r.depth)}- ${r.id}  [${r.type}]  ${r.title}`)
		.join("\n");
	return ok(message || "(empty)", { rows });
}

export function types(notesRoot: string): NoteResult {
	const { index } = discoverNotes(notesRoot);
	const counts: Record<string, number> = Object.fromEntries(
		NOTE_TYPES.map((t) => [t, 0]),
	);
	for (const entry of index.notes.values()) {
		counts[entry.doc.frontMatter.type] =
			(counts[entry.doc.frontMatter.type] ?? 0) + 1;
	}
	const message = NOTE_TYPES.map((t) => `${t.padEnd(10)} ${counts[t]}`).join(
		"\n",
	);
	return ok(message, { counts });
}
