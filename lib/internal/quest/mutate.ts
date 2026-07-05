/**
 * The single validated, journalled mutation entry point for a
 * quest README.
 *
 * Every field change on a quest should flow through here. The
 * layer reads the README under the per-quest lock, applies a pure
 * transform, and refuses to write a result the strict parser
 * cannot read back, so an out-of-vocabulary value is blocked at
 * write time instead of landing on disk as an invisible record.
 * It reports the per-field diff and, when an operation name is
 * given, appends that diff to the structural journal so the change
 * is reversible.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuestFrontMatter } from "../../quest/types.js";
import { nowYmd } from "./dates.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "./frontmatter.js";
import { atomicWriteFile, withQuestLock } from "./io.js";
import {
	type JournalChange,
	type MutableField,
	recordStructuralOp,
} from "./structural-journal.js";

/** Outcome of a mutation attempt. */
export type MutateResult =
	| { ok: true; fm: QuestFrontMatter; changes: JournalChange[] }
	| { ok: false; guidance: string };

interface MutateOptions {
	/** Journal the diff under this operation name. Omit to skip. */
	op?: string;
	/** Journal location; defaults to the quest directory's parent. */
	questsRoot?: string;
	/** Stamp `updated` with today's date. Defaults to true. */
	stampUpdated?: boolean;
}

/** Quest front-matter fields the journal tracks and undo reverses. */
const TRACKED_FIELDS: MutableField[] = [
	"parent",
	"status",
	"priority",
	"rank",
	"kind",
];

function fieldValue(fm: QuestFrontMatter, field: MutableField): string | null {
	switch (field) {
		case "parent":
			return fm.parent ?? null;
		case "status":
			return fm.status;
		case "priority":
			return fm.priority;
		case "rank":
			return String(fm.rank);
		case "kind":
			return fm.kind;
		default:
			return null;
	}
}

function diffTracked(
	id: string,
	before: QuestFrontMatter,
	after: QuestFrontMatter,
): JournalChange[] {
	const changes: JournalChange[] = [];
	for (const field of TRACKED_FIELDS) {
		const old = fieldValue(before, field);
		const next = fieldValue(after, field);
		if (old !== next) changes.push({ id, field, old, new: next });
	}
	return changes;
}

/**
 * Apply a validated, locked write to a quest README, reporting the
 * per-field diff and optionally journalling it.
 */
export function mutateQuestFrontMatter(
	questDir: string,
	transform: (fm: QuestFrontMatter) => QuestFrontMatter | undefined,
	opts: MutateOptions = {},
): MutateResult {
	const path = join(questDir, "README.md");
	return withQuestLock(questDir, () => {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			return {
				ok: false as const,
				guidance: `Cannot read ${path}: ${(err as Error).message}`,
			};
		}
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) {
			return {
				ok: false as const,
				guidance: `Quest README ${path} has invalid frontmatter.`,
			};
		}

		const next = transform(parsed.frontMatter);
		if (!next) {
			return { ok: true as const, fm: parsed.frontMatter, changes: [] };
		}
		const stamped: QuestFrontMatter =
			opts.stampUpdated === false ? next : { ...next, updated: nowYmd() };
		const outText = `${serializeQuestFrontMatter(stamped)}\n${parsed.body}`;

		// Write-time validation: refuse a mutation that would produce a
		// record the strict parser cannot read back, so an out-of-vocab
		// value is blocked instead of written to invisible drift.
		if (!parseQuestFrontMatter(outText)) {
			return {
				ok: false as const,
				guidance: `Refusing the write: it would give ${parsed.frontMatter.id} frontmatter the parser cannot read back.`,
			};
		}

		const changes = diffTracked(
			parsed.frontMatter.id,
			parsed.frontMatter,
			stamped,
		);
		atomicWriteFile(path, outText);
		if (opts.op && changes.length > 0) {
			recordStructuralOp(
				opts.questsRoot ?? dirname(questDir),
				opts.op,
				changes,
			);
		}
		return { ok: true as const, fm: stamped, changes };
	});
}
