/**
 * Notes discovery: walk a notes root on disk and build an
 * in-memory index.
 *
 * Canonical disk layout (within `notesRoot`):
 *
 *     NOTE-20130120-3MX6UQ/
 *       README.md
 *       attachment-1.jpg
 *     NOTE-20260822-AJ1W97/           (parent of the note
 *       README.md                       above, via its own
 *                                        `parent:` field --
 *                                        lives flat at the
 *                                        notes root, not
 *                                        nested in its
 *                                        parent's directory)
 *
 * All notes live as immediate children of `notesRoot`.
 * Hierarchy is expressed by the `parent:` front-matter field
 * on each note, not by directory nesting -- the same
 * invariant quest enforces for its own tree
 * (`internal/quest/discovery.ts`), and for the same reason:
 * a note's location on disk should never need to change just
 * because its place in a hierarchy does.
 *
 * A directory whose name doesn't match the `NOTE-*` id shape
 * is skipped, not an error -- `.git`, `.claude`, scratch
 * directories and the like are expected to sit alongside the
 * notes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NoteDoc } from "../../notes/types.ts";
import { parseNoteFrontMatter } from "./frontmatter.ts";
import { isId } from "./id.ts";

/** One discovered note. */
export interface NoteEntry {
	/** The note's directory name, equal to its id. */
	dir: string;
	doc: NoteDoc;
}

/** The whole tree, indexed for lookup and hierarchy traversal. */
export interface NoteIndex {
	/** Every discovered note by id. */
	notes: Map<string, NoteEntry>;
	/**
	 * Parent-to-children adjacency. The empty key `""` holds
	 * every note with no `parent` set.
	 */
	children: Map<string, string[]>;
}

interface DiscoveryError {
	dir: string;
	message: string;
}

/** Result of a discovery walk. */
export interface DiscoveryResult {
	index: NoteIndex;
	errors: DiscoveryError[];
}

function readMaybe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Walk `notesRoot` and build a `NoteIndex` of every note found. */
export function discoverNotes(notesRoot: string): DiscoveryResult {
	const notes = new Map<string, NoteEntry>();
	const children = new Map<string, string[]>();
	const errors: DiscoveryError[] = [];

	let entries: string[];
	try {
		entries = readdirSync(notesRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory() && isId(e.name))
			.map((e) => e.name);
	} catch (err) {
		errors.push({
			dir: notesRoot,
			message: err instanceof Error ? err.message : String(err),
		});
		return { index: { notes, children }, errors };
	}

	for (const dir of entries) {
		const readmePath = join(notesRoot, dir, "README.md");
		const text = readMaybe(readmePath);
		if (text === undefined) {
			errors.push({ dir, message: `missing ${readmePath}` });
			continue;
		}
		const parsed = parseNoteFrontMatter(text);
		if (!parsed) {
			errors.push({ dir, message: "invalid or missing front matter" });
			continue;
		}
		if (parsed.frontMatter.id !== dir) {
			errors.push({
				dir,
				message: `front-matter id "${parsed.frontMatter.id}" does not match directory name`,
			});
			continue;
		}
		notes.set(dir, { dir, doc: parsed });
	}

	for (const entry of notes.values()) {
		const parentKey = entry.doc.frontMatter.parent ?? "";
		const list = children.get(parentKey) ?? [];
		list.push(entry.dir);
		children.set(parentKey, list);
	}
	for (const list of children.values()) list.sort();

	return { index: { notes, children }, errors };
}
