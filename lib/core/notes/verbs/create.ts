/**
 * `notes create`: mint a fresh note.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { discoverNotes } from "../../internal/notes/discovery.ts";
import { serializeNote } from "../../internal/notes/frontmatter.ts";
import { mintIdFromDateString } from "../../internal/notes/id.ts";
import { atomicWriteFile } from "../../internal/notes/io.ts";
import type { NoteFrontMatter } from "../types.ts";
import {
	isNoteType,
	type NoteResult,
	type NoteToolParams,
	ok,
	refuse,
} from "./shared.ts";

export function create(notesRoot: string, params: NoteToolParams): NoteResult {
	const title = params.title?.trim();
	if (!title) return refuse("create needs a title");
	if (!params.type) return refuse("create needs a type");
	if (!isNoteType(params.type)) {
		return refuse(
			`type must be one of: journal, reference, faith, financial, gaming, travel, writing, inbox (got "${params.type}")`,
		);
	}

	const { index } = discoverNotes(notesRoot);
	const now = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	const created = params.created ?? now;

	let id: string;
	do {
		id = mintIdFromDateString(created);
	} while (index.notes.has(id));

	if (params.parent) {
		if (!index.notes.has(params.parent)) {
			return refuse(`no note matches parent "${params.parent}"`);
		}
	}

	const tags = params.tags
		? params.tags
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: [];

	const frontMatter: NoteFrontMatter = {
		id,
		type: params.type,
		title,
		created,
		updated: now,
		tags,
	};
	if (params.parent) frontMatter.parent = params.parent;

	const noteDir = join(notesRoot, id);
	mkdirSync(noteDir, { recursive: true });
	atomicWriteFile(
		join(noteDir, "README.md"),
		serializeNote(frontMatter, `\n# ${title}\n`),
	);

	return ok(id, { id, type: frontMatter.type, title });
}
