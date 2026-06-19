/**
 * Splice-based attribution for gh pr/issue commands. Locates the
 * body of a gh create/edit command and inserts a footer in place,
 * editing only the body span so the working directory, environment
 * assignments and every other flag survive byte-identically.
 *
 * This replaces the parse-and-rebuild path that dropped the leading
 * cd, GH_HOST and -R when it reconstructed the command.
 */

import {
	applyEdits,
	type Edit,
	type FlagSpec,
	findFlag,
	type SimpleCommand,
	tokenize,
} from "../../command/index.js";
import { stripHeredocBodies, stripShellData } from "../../shell/parse.js";
import { isGhCommand } from "./cli.js";

/** The outcome of attempting to attribute a gh command. */
export type GhFooterInsertion =
	| { kind: "rewritten"; command: string }
	| { kind: "blocked"; reason: string }
	| { kind: "skip" };

/** Flags that carry a gh pr/issue body inline. */
const GH_BODY_SPEC: FlagSpec = {
	flags: [{ name: "body", long: "body", short: "b", takesValue: true }],
};

/** Where a footer should be inserted, with the body it joins. */
interface BodyInsertion {
	readonly at: number;
	readonly bodyText: string;
}

/**
 * Insert a footer into the body of a gh pr or gh issue create/edit
 * command. Skips when the command is not a gh entity command, has
 * no body, or is already attributed; blocks when the command is a
 * gh entity command in a shape outside the supported grammar.
 */
export function insertGhBodyFooter(
	command: string,
	entity: "pr" | "issue",
	footer: string,
	alreadyAttributed: (bodyText: string) => boolean,
): GhFooterInsertion {
	const stripped = stripShellData(stripHeredocBodies(command));
	if (!isGhCommand(stripped, entity)) return { kind: "skip" };

	const line = tokenize(command);
	if (!line.supported) {
		return {
			kind: "blocked",
			reason: line.unsupportedReason ?? "unsupported command shape",
		};
	}

	const ghCommand = findGhCommand(line.commands, entity);
	if (!ghCommand) return { kind: "skip" };

	const insertion = locateBodyInsertion(command, ghCommand);
	if (!insertion) return { kind: "skip" };
	if (alreadyAttributed(insertion.bodyText)) return { kind: "skip" };

	const edit: Edit = {
		span: { start: insertion.at, end: insertion.at },
		text: footer,
	};
	return { kind: "rewritten", command: applyEdits(command, [edit]) };
}

/** Find a gh create/edit command for the entity among the commands. */
function findGhCommand(
	commands: SimpleCommand[],
	entity: "pr" | "issue",
): SimpleCommand | undefined {
	return commands.find(
		(command) =>
			command.argv[0]?.text === "gh" &&
			command.argv[1]?.text === entity &&
			(command.argv[2]?.text === "create" || command.argv[2]?.text === "edit"),
	);
}

/**
 * Locate where a footer joins the body: the end of a heredoc body,
 * or just inside the closing quote of an inline --body value.
 */
function locateBodyInsertion(
	source: string,
	command: SimpleCommand,
): BodyInsertion | undefined {
	if (command.heredoc) {
		const { bodySpan } = command.heredoc;
		return {
			at: bodySpan.end,
			bodyText: source.slice(bodySpan.start, bodySpan.end),
		};
	}

	const body = findFlag(command, GH_BODY_SPEC, "body");
	if (!body?.valueSpan) return undefined;

	const { start, end } = body.valueSpan;
	const quoted = source[end - 1] === '"' || source[end - 1] === "'";
	return quoted
		? { at: end - 1, bodyText: source.slice(start + 1, end - 1) }
		: { at: end, bodyText: source.slice(start, end) };
}
