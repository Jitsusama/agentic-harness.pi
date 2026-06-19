/**
 * GitHub CLI command parsing for gh pr/issue create/edit: detection
 * and field extraction (action, title, body, entity number).
 *
 * Parsing runs on the command model (lib/command): the command is
 * tokenized, the gh pr/issue command is located in the token stream,
 * and its title and body are read through caller-supplied flag specs.
 * This scopes extraction to the gh command itself, so a flag in a
 * chained command is never mistaken for the gh command's, and it
 * reads the short forms (-t, -b) as well as the long ones. Editing a
 * body for attribution is a splice (attribution-edit), not a rebuild,
 * so this module no longer reconstructs commands.
 */

import {
	type FlagSpec,
	findFlag,
	type SimpleCommand,
	tokenize,
} from "../../command/index.js";
import { unquote } from "../../shell/parse.js";
import { GH_BODY_SPEC } from "./command-spec.js";

/** The title flag of gh pr/issue, in its long and short forms. */
const GH_TITLE_SPEC: FlagSpec = {
	flags: [{ name: "title", long: "title", short: "t", takesValue: true }],
};

/** Detect whether a bash command contains a specific gh subcommand. */
export function isGhCommand(command: string, subcommand: string): boolean {
	const re = new RegExp(`\\bgh\\s+${subcommand}\\s+(create|edit)\\b`);
	return re.test(command);
}

// ── Shared gh entity parsing ────────────────────────────────

/** The reviewable fields of a gh pr/issue create or edit command. */
interface GhEntity {
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
	readonly number: string | null;
}

/** Locate a gh pr/issue create or edit command in the token stream. */
function findGhEntity(
	command: string,
	kind: "pr" | "issue",
): SimpleCommand | undefined {
	return tokenize(command).commands.find(
		(c) =>
			c.argv[0]?.text === "gh" &&
			c.argv[1]?.text === kind &&
			(c.argv[2]?.text === "create" || c.argv[2]?.text === "edit"),
	);
}

/** Read a flag's value, unquoted, or null when it is absent. */
function readFlagValue(
	command: SimpleCommand,
	spec: FlagSpec,
	name: string,
): string | null {
	const match = findFlag(command, spec, name);
	if (!match || match.value === undefined) return null;
	return unquote(match.value);
}

/**
 * Read the body: the heredoc body verbatim when the command has
 * one, otherwise the inline --body (or -b) value, unquoted.
 */
function readBody(command: string, gh: SimpleCommand): string | null {
	if (gh.heredoc)
		return command.slice(gh.heredoc.bodySpan.start, gh.heredoc.bodySpan.end);
	return readFlagValue(gh, GH_BODY_SPEC, "body");
}

/** The entity number that follows `gh <kind> edit`, when present. */
function readNumber(gh: SimpleCommand): string | null {
	const arg = gh.argv[3]?.text;
	return arg && /^\d+$/.test(arg) ? arg : null;
}

/**
 * Parse a gh pr/issue command into its reviewable fields, or null
 * when there is nothing to gate.
 *
 * A command with a body parses. A title-only edit also parses, with
 * a null body, so the title gate runs on the one path whose sole
 * purpose is changing the title. Everything else, a bodyless create
 * or a metadata-only edit, carries no reviewable content here, so
 * leave it ungated.
 */
function parseGhEntity(command: string, kind: "pr" | "issue"): GhEntity | null {
	const gh = findGhEntity(command, kind);
	if (!gh) return null;

	const action = gh.argv[2]?.text === "create" ? "create" : "edit";
	const title = readFlagValue(gh, GH_TITLE_SPEC, "title");
	const body = readBody(command, gh);
	const number = action === "edit" ? readNumber(gh) : null;

	if (!body && !(action === "edit" && title)) return null;

	return { action, title, body, number };
}

// ── PR command parsing ──────────────────────────────────────

/** Parsed gh pr create/edit command with extracted fields. */
export interface PrCommand {
	/** "create" or "edit" */
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
	/** PR number for edit commands */
	readonly prNumber: string | null;
}

/** Detect whether a bash command contains a gh pr create or edit. */
export function isPrCommand(command: string): boolean {
	return isGhCommand(command, "pr");
}

/** Extract PR details from a bash command. Returns null if nothing to gate. */
export function parsePrCommand(command: string): PrCommand | null {
	const entity = parseGhEntity(command, "pr");
	if (!entity) return null;
	return {
		action: entity.action,
		title: entity.title,
		body: entity.body,
		prNumber: entity.number,
	};
}

// ── Issue command parsing ───────────────────────────────────

/** Parsed gh issue create/edit command with extracted fields. */
export interface IssueCommand {
	/** "create" or "edit" */
	readonly action: "create" | "edit";
	readonly title: string | null;
	readonly body: string | null;
	/** Issue number for edit commands */
	readonly issueNumber: string | null;
}

/** Detect whether a bash command contains a gh issue create or edit. */
export function isIssueCommand(command: string): boolean {
	return isGhCommand(command, "issue");
}

/** Extract issue details from a bash command. Returns null if nothing to gate. */
export function parseIssueCommand(command: string): IssueCommand | null {
	const entity = parseGhEntity(command, "issue");
	if (!entity) return null;
	return {
		action: entity.action,
		title: entity.title,
		body: entity.body,
		issueNumber: entity.number,
	};
}
