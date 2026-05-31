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

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PERSONAS_DIR_ENV_VAR = "PR_WORKFLOW_PERSONAS_DIR";
const CONFIG_DIR = "pi";
const PERSONAS_DIRNAME = "personas";
const FRONTMATTER_FENCE = "---";

/**
 * Resolve the directory pr-workflow reads personas from. It sits
 * beside `pr-workflow.json`: an explicit
 * `PR_WORKFLOW_PERSONAS_DIR` wins, then `$XDG_CONFIG_HOME/pi/`
 * `personas`, then `~/.config/pi/personas`.
 */
export function personasDir(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const explicit = env[PERSONAS_DIR_ENV_VAR];
	if (explicit && explicit.trim() !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg && xdg.trim() !== "") {
		return join(xdg, CONFIG_DIR, PERSONAS_DIRNAME);
	}
	return join(home, ".config", CONFIG_DIR, PERSONAS_DIRNAME);
}

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

/** The writable fields of a persona: identity plus charter, no id. */
export interface PersonaDraft {
	readonly name: string;
	readonly description: string;
	readonly charter: string;
}

/**
 * Render a persona draft into the markdown-with-frontmatter form
 * {@link parsePersona} reads back. The inverse of parsing: name
 * and description become frontmatter fields, the charter becomes
 * the body. The round-trip is lossless for the flat fields a
 * persona uses.
 */
export function serializePersona(draft: PersonaDraft): string {
	return [
		FRONTMATTER_FENCE,
		`name: ${draft.name}`,
		`description: ${draft.description}`,
		FRONTMATTER_FENCE,
		`${draft.charter.trim()}\n`,
	].join("\n");
}

/** One persona file that failed to parse, with its reason. */
export interface PersonaLoadError {
	readonly id: string;
	readonly error: string;
}

/** The outcome of loading a persona directory. */
export interface LoadedPersonas {
	readonly personas: readonly Persona[];
	readonly errors: readonly PersonaLoadError[];
}

const PERSONA_FILE_SUFFIX = ".md";
// A README.md is documentation a user may keep beside their
// personas; it is not a persona and must not surface as a parse
// error. Other .md files are personas.
const README_FILENAME = "readme.md";

/**
 * Load every persona file (`*.md`) from `dir`, deriving each id
 * from its filename stem and parsing it. Personas come back sorted
 * by id; files that fail to parse surface as per-file errors
 * rather than aborting the load. A missing directory is empty, not
 * an error — a user who has authored no personas is normal.
 */
export async function loadPersonas(dir: string): Promise<LoadedPersonas> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { personas: [], errors: [] };
		}
		throw error;
	}
	const files = entries.filter(
		(name) =>
			name.endsWith(PERSONA_FILE_SUFFIX) &&
			name.toLowerCase() !== README_FILENAME,
	);
	const personas: Persona[] = [];
	const errors: PersonaLoadError[] = [];
	for (const file of files) {
		const id = basename(file, PERSONA_FILE_SUFFIX);
		const text = await readFile(join(dir, file), "utf8");
		const result = parsePersona(id, text);
		if (result.ok) personas.push(result.persona);
		else errors.push({ id, error: result.error });
	}
	personas.sort((a, b) => a.id.localeCompare(b.id));
	errors.sort((a, b) => a.id.localeCompare(b.id));
	return { personas, errors };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

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
