/**
 * Which tool calls read a quest document the costly way: a shell
 * search or print of its file, or a `read` of the whole of it.
 *
 * A plan grows past 400 KB, and what a session reads stays in its
 * context for every turn after, so a whole read or a shell listing of
 * its headings is paid for again and again. `quest show` answers the
 * same questions from the document's parsed outline: its sections and
 * their sizes, one section by title, one item with its notes. On
 * 2026-10-26, 18 of the day's 33 sessions searched a quest document
 * from the shell, 105 times in all, and 7 read one whole.
 *
 * Only reading is judged here. A shell command that edits a document
 * in place is the record gate's to judge, and a `read` with an offset
 * or a limit is already a slice.
 */

import * as path from "node:path";
import { stripHeredocBodies } from "../../shell/index.ts";

/** The document a call reads, by id, and how it reads it. */
export interface DocumentRead {
	readonly id: string;
	readonly how: "shell" | "whole";
}

const DOCUMENT_DIRS = "(?:plans|research|briefs|reports)";
const DOCUMENT_ID = "((?:PLAN|RSCH|BRIF|RPRT)-\\d{8}-[0-9A-Z]{6})";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A document's file under the quests folder: the usual one, wherever
 * it sits, or `questsRoot` as a command spells it, whole, from `~` or
 * from `$HOME`.
 */
function documentFile(home: string, questsRoot?: string): RegExp {
	const roots = ["quest-workflow/quests"];
	if (questsRoot) {
		roots.push(escaped(questsRoot));
		if (questsRoot.startsWith(`${home}/`)) {
			const rest = escaped(questsRoot.slice(home.length));
			roots.push(`~${rest}`, `\\$HOME${rest}`, `\\$\\{HOME\\}${rest}`);
		}
	}
	return new RegExp(
		`(?:${roots.join("|")})/[^\\s'"/]+/${DOCUMENT_DIRS}/${DOCUMENT_ID}\\.md`,
	);
}

/** A program that prints or searches what it is given. */
const READER = /(?:^|[\s;&|(`$])(?:grep|rg|sed|awk|cat|head|tail|less|bat)\s/;

/** An edit in place, which the record gate judges rather than this. */
const IN_PLACE = /(?:^|[\s;&|(])(?:sed|perl)\s+(?:-\w*\s+)*-\w*i/;

/**
 * The quest document a tool call reads the costly way, or nothing.
 * `input` is the call's arguments; `cwd` and `home` resolve a `read`
 * path the way the read tool does, and `questsRoot` names a quests
 * folder kept somewhere other than the usual place.
 */
export function documentRead(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
	cwd: string,
	home: string,
	questsRoot?: string,
): DocumentRead | undefined {
	const file = documentFile(home, questsRoot);
	if (toolName === "read") {
		if (input.offset != null || input.limit != null) return undefined;
		const raw = String(input.path ?? "");
		const expanded =
			raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : raw;
		const id = path.resolve(cwd, expanded).match(file)?.[1];
		return id ? { id, how: "whole" } : undefined;
	}
	if (toolName !== "bash") return undefined;
	const command = stripHeredocBodies(String(input.command ?? ""));
	if (!READER.test(command) || IN_PLACE.test(command)) return undefined;
	const id = command.match(file)?.[1];
	return id ? { id, how: "shell" } : undefined;
}

/** Why the call is sent to `quest show`, naming the document. */
export function documentReadReason(read: DocumentRead): string {
	const what =
		read.how === "whole"
			? `This reads all of ${read.id}`
			: `This reads ${read.id} from the shell`;
	return `Quest workflow: ${what}, and every turn after pays for what it brings into the context. Read it through the quest tool instead: \`quest show\` with id ${read.id} gives its outline (sections, their sizes, open items), with \`title\` one section, and with \`query\` one item and its notes.`;
}
