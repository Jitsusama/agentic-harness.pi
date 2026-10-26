/**
 * Front-matter parser and serializer for note READMEs.
 *
 * The block is YAML between two `---` fences. We use the
 * `yaml` library for both directions rather than hand-rolled
 * regex parsing, the same choice quest's own frontmatter
 * module makes (`internal/quest/frontmatter.ts`) and for the
 * same reason: a title or source string containing a colon,
 * a quote, or a backslash is exactly the kind of value a
 * regex-based reader/writer round-trips incorrectly, and
 * silently -- an earlier prototype of this library hand-rolled
 * its own escaping and produced titles with accumulating
 * doubled backslashes on repeated edits before this was
 * caught. A real YAML parser has no such failure mode.
 *
 * Validation rules:
 *
 * - `id`, `type`, `title`, `created`, `updated` are
 *   required; a missing or invalid one makes the whole parse
 *   fail so callers surface a clean error instead of writing
 *   back a corrupted file.
 * - `type` is a strict enum; an unrecognised value fails
 *   the parse rather than being coerced to a guess.
 * - `tags` defaults to `[]` rather than being omitted, so
 *   callers never have to distinguish "no tags" from "tags
 *   field missing".
 * - `parent` and `source` are optional and only appear in
 *   the serialized output when set.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { NOTE_TYPES, type NoteFrontMatter } from "../../notes/types.ts";

/** Split a note's text into its raw front-matter YAML and body. */
export function splitFrontMatter(
	text: string,
): { fmText: string; body: string } | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return undefined;
	const fmText = lines.slice(1, end).join("\n");
	let body = lines.slice(end + 1).join("\n");
	if (body.startsWith("\n")) body = body.slice(1);
	return { fmText, body };
}

function parseFrontMatterBlock(
	text: string,
): Record<string, unknown> | undefined {
	const split = splitFrontMatter(text);
	if (!split) return undefined;
	let raw: unknown;
	try {
		raw = parseYaml(split.fmText) ?? {};
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	return raw as Record<string, unknown>;
}

function asEnum<T extends string>(value: unknown, options: T[]): T | undefined {
	if (typeof value !== "string") return undefined;
	return options.includes(value as T) ? (value as T) : undefined;
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	// created/updated timestamps and ids are always strings on write, but
	// a hand-edited file could plausibly leave one unquoted; YAML would
	// then hand back a number or Date for some shapes. Round-trip those
	// back to string rather than failing the whole parse over it.
	if (typeof value === "number") return String(value);
	return undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
}

/** Reasons a front-matter block might fail to parse, for a caller to surface. */
export function noteFrontMatterProblem(text: string): string | undefined {
	const raw = parseFrontMatterBlock(text);
	if (!raw)
		return "no valid front-matter block (missing --- fences or invalid YAML)";
	if (!asString(raw.id)) return "missing or invalid id";
	if (!asEnum(raw.type, NOTE_TYPES)) {
		return `missing or invalid type (must be one of: ${NOTE_TYPES.join(", ")})`;
	}
	if (!asString(raw.title)) return "missing or invalid title";
	if (!asString(raw.created)) return "missing or invalid created";
	if (!asString(raw.updated)) return "missing or invalid updated";
	return undefined;
}

/** Parse a note's full text into front matter plus body, or `undefined` if invalid. */
export function parseNoteFrontMatter(
	text: string,
): { frontMatter: NoteFrontMatter; body: string } | undefined {
	const split = splitFrontMatter(text);
	if (!split) return undefined;
	const raw = parseFrontMatterBlock(text);
	if (!raw) return undefined;

	const id = asString(raw.id);
	const type = asEnum(raw.type, NOTE_TYPES);
	const title = asString(raw.title);
	const created = asString(raw.created);
	const updated = asString(raw.updated);
	if (!id || !type || !title || !created || !updated) return undefined;

	const frontMatter: NoteFrontMatter = {
		id,
		type,
		title,
		created,
		updated,
		tags: asStringArray(raw.tags),
	};
	const parent = asString(raw.parent);
	if (parent) frontMatter.parent = parent;
	const source = asString(raw.source);
	if (source) frontMatter.source = source;

	return { frontMatter, body: split.body };
}

/**
 * Serialize front matter back to a YAML block, in a fixed
 * field order (id, type, title, created, updated, tags,
 * parent, source) so a diff on a note that only changed one
 * field's value shows one changed line, not a reordered
 * block.
 */
export function serializeNoteFrontMatter(fm: NoteFrontMatter): string {
	const ordered: Record<string, unknown> = {
		id: fm.id,
		type: fm.type,
		title: fm.title,
		created: fm.created,
		updated: fm.updated,
		tags: fm.tags,
	};
	if (fm.parent) ordered.parent = fm.parent;
	if (fm.source) ordered.source = fm.source;
	return stringifyYaml(ordered, { lineWidth: 0 }).trimEnd();
}

/** Assemble a note's full file text from front matter and body. */
export function serializeNote(fm: NoteFrontMatter, body: string): string {
	return `---\n${serializeNoteFrontMatter(fm)}\n---\n\n${body.replace(/^\n+/, "")}`;
}
