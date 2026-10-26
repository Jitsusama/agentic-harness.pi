/**
 * Verbs that edit the body of a quest document under the quest lock:
 * `journal`, `tick`, `untick`, `section` and `retitle`.
 *
 * They exist because hand edits to these files kept missing. The
 * workflow rewrites a README or plan on its own (a Journey line after
 * a stage change, the sessions list on load) between the moment an
 * edit reads the file and the moment it writes, and the edit then
 * fails on text that has moved. A verb reads and writes inside one
 * lock, and never touches the front matter.
 *
 * Each takes any quest's id or any document's id, loaded or not, since
 * writing a file is no reason to move the session off its own work.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJourneyByPath } from "../../../lib/internal/quest/append-journey.ts";
import {
	itemOf,
	outlineOf,
	replaceSection,
	sectionOf,
	setCheckbox,
	splitAtBody,
} from "../../../lib/internal/quest/body-edits.ts";
import {
	atomicWriteFile,
	withQuestLock,
} from "../../../lib/internal/quest/io.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/mutate.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { refreshProgress, stampQuestUpdated } from "../lifecycle.ts";
import type { QuestState } from "../state.ts";
import { type Address, addressOf } from "./address.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/**
 * Add a dated entry to a quest's Journey: the quest `id` names, or
 * the quest owning the document it names, loaded or not; else the
 * loaded quest's. A Journey lives in the README, so a document's id
 * stands for its quest.
 */
export function journal(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const entry = params.note?.trim();
	if (!entry) return refuse("Pass the entry to add as `note`.");
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	if (!appendJourneyByPath(target.questDir, entry)) {
		return refuse(
			`Could not add to ${displayPath(join(target.questDir, "README.md"))}; check it exists and is readable.`,
		);
	}
	stamp(state, target);
	return ok(`Added to ${target.questId}'s Journey.`);
}

/**
 * Mark the quest written to as updated today. The loaded quest also
 * recounts its progress, which the footer shows; another quest has
 * nothing in memory to refresh.
 */
function stamp(state: QuestState, target: Address): void {
	if (target.loaded) {
		refreshProgress(state);
		stampQuestUpdated(state);
		return;
	}
	// An identity transform: the write stamps `updated` and nothing else.
	mutateQuestFrontMatter(target.questDir, (fm) => fm);
}

/** How much of an item's line an outline shows. */
const ITEM_CHARS = 160;

/**
 * Read a document without reading all of it: one section (`title`),
 * one checkbox item with its notes (`query`), or, with neither, its
 * outline: its sections and their sizes, its open items and the next.
 * Plans grow past 400 KB, mostly as notes under done items, and
 * sessions hunted them with grep and sed some 3,000 times in a week.
 */
export function read(state: QuestState, params: QuestToolParams): QuestResult {
	const target = addressOf(state, params.id, { focused: true });
	if ("refusal" in target) return refuse(target.refusal);
	const shown = displayPath(target.path);
	let text: string;
	try {
		text = readFileSync(target.path, "utf8");
	} catch (err) {
		return refuse(`Cannot read ${shown}: ${(err as Error).message}`);
	}
	const { head, body } = splitAtBody(text);
	const name = target.documentId ?? target.questId;
	const heading = params.title?.trim();
	const item = params.query?.trim();
	if (heading || item) {
		const found = heading ? sectionOf(body, heading) : itemOf(body, item ?? "");
		if (!found.ok) return refuse(found.reason);
		const lines = [
			`${name}, ${heading ? `section ${found.found}` : found.found}:`,
			"",
			found.text || "(nothing under it)",
		];
		return ok(lines.join("\n"), {
			document: name,
			found: found.found,
			text: found.text,
		});
	}
	const outline = outlineOf(body);
	const open = outline.items.filter((one) => !one.done);
	const title = /^#[ \t]+(.+)$/m.exec(body)?.[1].trim();
	const stage = /^stage:\s*(\S+)/m.exec(head)?.[1];
	const lines = [
		`${name}: ${title ?? "(untitled)"}`,
		`  ${[stage, `${Buffer.byteLength(text).toLocaleString("en-CA")} bytes`].filter(Boolean).join(", ")}; ${shown}`,
		"",
		"Sections, by size:",
		...outline.sections.map(
			(one) => `- ${one.heading} (${one.bytes.toLocaleString("en-CA")})`,
		),
	];
	if (outline.items.length > 0) {
		lines.push(
			"",
			`Open, ${open.length} of ${outline.items.length} items:`,
			...open.map(
				(one) => `${"  ".repeat(one.depth)}- [ ] ${cut(one.text, ITEM_CHARS)}`,
			),
		);
		if (open[0]) lines.push("", `Next: ${cut(open[0].text, ITEM_CHARS)}`);
	}
	lines.push(
		"",
		"Read one section with `title`, or one item and its notes with `query` (its number or its first words); `tick` and `section` change them.",
	);
	return ok(lines.join("\n"), {
		document: name,
		sections: outline.sections,
		open: open.map((one) => one.text),
	});
}

function cut(text: string, chars: number): string {
	return text.length <= chars ? text : `${text.slice(0, chars - 3)}...`;
}

/** Mark a checkbox item done (`tick`) or not done (`untick`). */
export function tick(
	state: QuestState,
	params: QuestToolParams,
	done: boolean,
): QuestResult {
	const item = params.query?.trim();
	if (!item) {
		return refuse("Pass the item as `query`: its text, or the start of it.");
	}
	return editBody(state, params, (body) => setCheckbox(body, item, done), {
		changed: (path, line) =>
			`${done ? "Ticked" : "Unticked"} in ${path}: ${line?.trim()}`,
		unchanged: (path, line) =>
			`Already ${done ? "ticked" : "unticked"} in ${path}: ${line?.trim()}`,
	});
}

/**
 * Replace the body of one `##` section, or add it: at the end of a
 * document other than the README, and in a README, whose sections are
 * a closed set, only one of the format's optional sections, in its place.
 */
export function section(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	const heading = params.title?.trim();
	if (!heading) return refuse("Pass the section's heading as `title`.");
	const text = params.body;
	if (text === undefined) {
		return refuse(
			"Pass the section's new text as `body`, without its heading.",
		);
	}
	return editBody(
		state,
		params,
		(body, readme) =>
			replaceSection(body, heading, text, readme ? "readme" : "append"),
		{
			changed: (path, _line, added) =>
				`${added ? "Added" : "Replaced"} the ${heading} section ${added ? "to" : "of"} ${path}.`,
			unchanged: (path) =>
				`The ${heading} section of ${path} already reads that way.`,
		},
	);
}

/**
 * Give the quest or document `id` names a new title: its H1, which is
 * where every listing reads a title from. The old title goes into the
 * quest's Journey, so a rename can be read back and undone by hand.
 *
 * It takes no default target: a title is the one thing a person
 * recognises a record by, so a rename always says what it renames.
 */
export function retitle(
	state: QuestState,
	params: QuestToolParams,
): QuestResult {
	if (!params.id?.trim()) {
		return refuse(
			"Pass the quest or document to retitle as `id`: a rename always names what it renames.",
		);
	}
	const title = params.title?.trim();
	if (!title) return refuse("Pass the new title as `title`.");
	if (/[\r\n]/.test(title)) {
		return refuse("A title is one line; pass it without line breaks.");
	}
	const target = addressOf(state, params.id, { focused: false });
	if ("refusal" in target) return refuse(target.refusal);
	let old: string | undefined;
	const result = editBody(
		state,
		params,
		(body) => {
			const h1 = /^#[ \t]+(.+)$/m.exec(body);
			if (!h1) return { ok: false, reason: "It has no `# ` title line." };
			old = h1[1].trim();
			if (old === title) return { ok: true, body, changed: false };
			const at = h1.index;
			return {
				ok: true,
				body: `${body.slice(0, at)}# ${title}${body.slice(at + h1[0].length)}`,
				changed: true,
			};
		},
		{
			changed: (path) => `Retitled ${path}: "${title}".`,
			unchanged: (path) => `${path} is already titled "${title}".`,
		},
		false,
	);
	if (!result.ok || old === undefined || old === title) return result;
	const what = target.documentId ? `${target.documentId} ` : "";
	appendJourneyByPath(
		target.questDir,
		`Retitled ${what}from "${old}" to "${title}".`,
	);
	if (target.loaded && !target.documentId) state.questTitle = title;
	return result;
}

type BodyEdit = (
	body: string,
	readme: boolean,
) =>
	| {
			ok: true;
			body: string;
			changed: boolean;
			line?: string;
			added?: boolean;
	  }
	| { ok: false; reason: string };

/**
 * Read a document, edit its body and write it back, all under the
 * quest lock, with the front matter kept byte for byte.
 */
function editBody(
	state: QuestState,
	params: QuestToolParams,
	edit: BodyEdit,
	say: {
		changed: (path: string, line?: string, added?: boolean) => string;
		unchanged: (path: string, line?: string) => string;
	},
	focused = true,
): QuestResult {
	const target = addressOf(state, params.id, { focused });
	if ("refusal" in target) return refuse(target.refusal);
	const shown = displayPath(target.path);
	const readme = target.documentId === undefined;
	const outcome = withQuestLock(target.questDir, () => {
		let text: string;
		try {
			text = readFileSync(target.path, "utf8");
		} catch (err) {
			return {
				ok: false as const,
				reason: `Cannot read ${shown}: ${(err as Error).message}`,
			};
		}
		const { head, body } = splitAtBody(text);
		const result = edit(body, readme);
		if (!result.ok || !result.changed) return result;
		atomicWriteFile(target.path, head + result.body);
		return result;
	});
	if (!outcome.ok) return refuse(outcome.reason);
	if (!outcome.changed) return ok(say.unchanged(shown, outcome.line));
	stamp(state, target);
	return ok(say.changed(shown, outcome.line, outcome.added), {
		path: target.path,
	});
}
