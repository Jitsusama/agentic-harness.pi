/**
 * `notes retype` / `notes retitle` / `notes tag` / `notes reparent`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	discoverNotes,
	type NoteIndex,
} from "../../internal/notes/discovery.ts";
import {
	parseNoteFrontMatter,
	serializeNote,
} from "../../internal/notes/frontmatter.ts";
import { atomicWriteFile } from "../../internal/notes/io.ts";
import { resolveId } from "./queries.ts";
import {
	isNoteType,
	type NoteResult,
	type NoteToolParams,
	ok,
	refuse,
} from "./shared.ts";

function loadForWrite(notesRoot: string, id: string) {
	const path = join(notesRoot, id, "README.md");
	const text = readFileSync(path, "utf8");
	const parsed = parseNoteFrontMatter(text);
	if (!parsed) return undefined;
	return { path, ...parsed };
}

export function retype(notesRoot: string, params: NoteToolParams): NoteResult {
	if (!params.id) return refuse("retype needs an id");
	if (!params.type) return refuse("retype needs a type");
	if (!isNoteType(params.type)) {
		return refuse(
			`type must be one of: journal, reference, faith, financial, gaming, travel, writing, inbox (got "${params.type}")`,
		);
	}
	const { index } = discoverNotes(notesRoot);
	const resolved = resolveId(index, params.id);
	if ("error" in resolved) return refuse(resolved.error);

	const loaded = loadForWrite(notesRoot, resolved.id);
	if (!loaded) return refuse(`could not read ${resolved.id}`);
	loaded.frontMatter.type = params.type;
	atomicWriteFile(loaded.path, serializeNote(loaded.frontMatter, loaded.body));
	return ok(`${resolved.id}: type -> ${params.type}`, {
		id: resolved.id,
		type: params.type,
	});
}

/**
 * A note's body opens with `# <title>`, an echo of the same
 * front-matter field, not independent content -- kept in
 * sync on retitle rather than left stale. Only the heading
 * line itself is replaced; the blank line separating it from
 * the rest of the body is preserved untouched, since a
 * regex greedy enough to also consume trailing whitespace
 * collapses that separator (caught the hard way once
 * already, when a Python prototype of this tool did exactly
 * that across every note it retitled in one pass).
 */
function retitleHeading(
	body: string,
	oldTitle: string,
	newTitle: string,
): string {
	const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingRe = new RegExp(`^# ${escaped} *$`, "m");
	return body.replace(headingRe, `# ${newTitle}`);
}

export function retitle(notesRoot: string, params: NoteToolParams): NoteResult {
	if (!params.id) return refuse("retitle needs an id");
	if (!params.title?.trim()) return refuse("retitle needs a title");
	const { index } = discoverNotes(notesRoot);
	const resolved = resolveId(index, params.id);
	if ("error" in resolved) return refuse(resolved.error);

	const loaded = loadForWrite(notesRoot, resolved.id);
	if (!loaded) return refuse(`could not read ${resolved.id}`);
	const newTitle = params.title.trim();
	const newBody = retitleHeading(
		loaded.body,
		loaded.frontMatter.title,
		newTitle,
	);
	loaded.frontMatter.title = newTitle;
	atomicWriteFile(loaded.path, serializeNote(loaded.frontMatter, newBody));
	return ok(`${resolved.id}: title -> "${newTitle}"`, {
		id: resolved.id,
		title: newTitle,
	});
}

export function tag(notesRoot: string, params: NoteToolParams): NoteResult {
	if (!params.id) return refuse("tag needs an id");
	const { index } = discoverNotes(notesRoot);
	const resolved = resolveId(index, params.id);
	if ("error" in resolved) return refuse(resolved.error);

	const loaded = loadForWrite(notesRoot, resolved.id);
	if (!loaded) return refuse(`could not read ${resolved.id}`);
	let tags = [...loaded.frontMatter.tags];
	if (params.add) {
		for (const t of params.add.split(",")) {
			const trimmed = t.trim();
			if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
		}
	}
	if (params.remove) {
		const toRemove = new Set(params.remove.split(",").map((t) => t.trim()));
		tags = tags.filter((t) => !toRemove.has(t));
	}
	loaded.frontMatter.tags = tags;
	atomicWriteFile(loaded.path, serializeNote(loaded.frontMatter, loaded.body));
	return ok(`${resolved.id}: tags -> [${tags.join(", ")}]`, {
		id: resolved.id,
		tags,
	});
}

/** Is `candidate` inside `ancestor`'s subtree? Mirrors quest's own cycle guard (`internal/quest/structural.ts`). */
function isDescendant(
	index: NoteIndex,
	candidate: string,
	ancestor: string,
): boolean {
	const seen = new Set<string>();
	let cursor: string | undefined = candidate;
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		if (cursor === ancestor) return true;
		cursor = index.notes.get(cursor)?.doc.frontMatter.parent;
	}
	return false;
}

export function reparent(
	notesRoot: string,
	params: NoteToolParams,
): NoteResult {
	if (!params.id) return refuse("reparent needs an id");
	const { index } = discoverNotes(notesRoot);
	const resolved = resolveId(index, params.id);
	if ("error" in resolved) return refuse(resolved.error);

	const loaded = loadForWrite(notesRoot, resolved.id);
	if (!loaded) return refuse(`could not read ${resolved.id}`);

	if (!params.parent || params.parent.toLowerCase() === "none") {
		delete loaded.frontMatter.parent;
		atomicWriteFile(
			loaded.path,
			serializeNote(loaded.frontMatter, loaded.body),
		);
		return ok(`${resolved.id}: parent cleared`, {
			id: resolved.id,
			parent: null,
		});
	}

	const resolvedParent = resolveId(index, params.parent);
	if ("error" in resolvedParent) return refuse(resolvedParent.error);
	if (resolvedParent.id === resolved.id) {
		return refuse(`${resolved.id} cannot be its own parent (cycle)`);
	}
	if (isDescendant(index, resolvedParent.id, resolved.id)) {
		return refuse(
			`reparenting ${resolved.id} under ${resolvedParent.id} would form a cycle`,
		);
	}

	loaded.frontMatter.parent = resolvedParent.id;
	atomicWriteFile(loaded.path, serializeNote(loaded.frontMatter, loaded.body));
	return ok(`${resolved.id}: parent -> ${resolvedParent.id}`, {
		id: resolved.id,
		parent: resolvedParent.id,
	});
}
