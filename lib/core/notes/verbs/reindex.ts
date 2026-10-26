/**
 * `notes reindex`: regenerate the notes root's INDEX.md.
 *
 * A static, human-browsable snapshot -- not the source of
 * truth. Every other verb reads the notes fresh off disk on
 * every call; this file exists purely for a person (or a
 * plain-text grep) scanning the archive outside the CLI, and
 * goes stale the moment a note changes until the next
 * `reindex`.
 */

import { join } from "node:path";
import { discoverNotes } from "../../internal/notes/discovery.ts";
import { atomicWriteFile } from "../../internal/notes/io.ts";
import { type NoteResult, ok } from "./shared.ts";

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|");
}

export function reindex(notesRoot: string): NoteResult {
	const { index } = discoverNotes(notesRoot);
	const rows = [...index.notes.values()].sort((a, b) =>
		a.doc.frontMatter.created.localeCompare(b.doc.frontMatter.created),
	);

	const lines = [
		"# Note Index",
		"",
		`${rows.length} notes. Regenerate with \`notes reindex\`.`,
		"",
		"| id | type | created | title |",
		"|---|---|---|---|",
		...rows.map((r) => {
			const fm = r.doc.frontMatter;
			return `| ${fm.id} | ${fm.type} | ${fm.created.slice(0, 8)} | ${escapeTableCell(fm.title)} |`;
		}),
	];

	atomicWriteFile(join(notesRoot, "INDEX.md"), `${lines.join("\n")}\n`);
	return ok(`wrote INDEX.md (${rows.length} notes)`, { count: rows.length });
}
