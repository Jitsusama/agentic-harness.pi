/**
 * Public types for the notes library.
 *
 * A note is a flat, self-contained directory --
 * `NOTE-<created-date>-<suffix>/README.md` plus whatever
 * attachments sit alongside it -- living directly under a
 * notes root with no folder-per-topic nesting. Unlike a
 * quest, a note owns no child documents of different kinds;
 * it is a single leaf. Hierarchy, where it's real, is a
 * `parent` front-matter link to another note's id, the same
 * way quest hierarchy is a link rather than directory
 * nesting -- see `internal/notes/discovery.ts`.
 */

/**
 * The note's kind: a small, fixed vocabulary, not a
 * subject. Subject-level detail belongs in `tags`. This is
 * deliberately narrow -- a note's type rarely needs to grow
 * new values, and an open vocabulary would just become an
 * uncontrolled tag by another name.
 */
export type NoteType =
	| "journal"
	| "reference"
	| "faith"
	| "financial"
	| "gaming"
	| "travel"
	| "writing"
	| "inbox";

export const NOTE_TYPES: NoteType[] = [
	"journal",
	"reference",
	"faith",
	"financial",
	"gaming",
	"travel",
	"writing",
	"inbox",
];

/**
 * A note's front matter, as read from and written to its
 * README.md. `created`/`updated` are free-form timestamp
 * strings (whatever the note's original source recorded,
 * typically `YYYYMMDDTHHMMSSZ`) rather than a parsed `Date`
 * -- the library never needs to do arithmetic on them, only
 * compare and display, and round-tripping the original text
 * exactly avoids a whole class of timezone-shift bugs a
 * parse/reformat cycle would invite.
 */
export interface NoteFrontMatter {
	id: string;
	type: NoteType;
	title: string;
	created: string;
	updated: string;
	/** Empty when the note carries no tags, never omitted. */
	tags: string[];
	/** Another note's id. Absent for the (common) case of no parent. */
	parent?: string;
	/** Where the note originally came from (an import source, a clip source, etc.). */
	source?: string;
}

/** A note as read from disk: its parsed front matter plus its body text. */
export interface NoteDoc {
	frontMatter: NoteFrontMatter;
	body: string;
}
