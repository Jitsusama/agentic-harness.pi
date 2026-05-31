/**
 * Persona library for pr-workflow councils.
 *
 * A persona is a charter for a review lens, authored as a markdown
 * file with YAML frontmatter (identity) and a prose body (the
 * charter). The frontmatter is pure identity — name and
 * description — and carries no mechanism; model, thinking level
 * and tools live in the config entry that references the persona
 * by id. The body is the distinctive charter prose only; the
 * invariant scaffolding (output contract, diff-reading rules) is
 * wrapped on at dispatch.
 */

/** A parsed persona: identity plus the charter prose. */
export interface Persona {
	/** Stable id, derived from the file name. */
	readonly id: string;
	/** Human-readable name from frontmatter. */
	readonly name: string;
	/** One-line description from frontmatter. */
	readonly description: string;
	/** The charter prose: the file body, frontmatter stripped. */
	readonly charter: string;
}

/** Result of parsing a persona file. */
export type ParsePersonaResult =
	| { ok: true; persona: Persona }
	| { ok: false; error: string };

/**
 * Parse persona markdown into a {@link Persona}. The id is supplied
 * by the caller (derived from the file name); the name and
 * description come from YAML frontmatter and the charter is the
 * body with the frontmatter block removed.
 */
export function parsePersona(id: string, text: string): ParsePersonaResult {
	const split = splitFrontmatter(text);
	if (!split.ok) return split;
	const name = split.fields.name;
	if (name === undefined || name === "") {
		return { ok: false, error: "frontmatter is missing a name" };
	}
	const description = split.fields.description;
	if (description === undefined || description === "") {
		return { ok: false, error: "frontmatter is missing a description" };
	}
	const charter = split.body.trim();
	if (charter === "") {
		return { ok: false, error: "persona body (charter) is empty" };
	}
	return { ok: true, persona: { id, name, description, charter } };
}

const FRONTMATTER_FENCE = "---";

type SplitResult =
	| { ok: true; fields: Record<string, string>; body: string }
	| { ok: false; error: string };

/**
 * Split a markdown document into its YAML frontmatter fields and
 * the body that follows. Hand-rolled because the package takes no
 * YAML dependency; it handles the flat `key: value` subset a
 * persona needs and nothing more.
 */
function splitFrontmatter(text: string): SplitResult {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
		return { ok: false, error: "missing opening frontmatter fence (---)" };
	}
	let closing = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === FRONTMATTER_FENCE) {
			closing = i;
			break;
		}
	}
	if (closing === -1) {
		return { ok: false, error: "missing closing frontmatter fence (---)" };
	}
	const fields: Record<string, string> = {};
	for (let i = 1; i < closing; i += 1) {
		const line = lines[i];
		if (line === undefined || line.trim() === "") continue;
		const sep = line.indexOf(":");
		if (sep === -1) {
			return {
				ok: false,
				error: `frontmatter line is not key: value: ${line}`,
			};
		}
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		fields[key] = value;
	}
	const body = lines.slice(closing + 1).join("\n");
	return { ok: true, fields, body };
}
