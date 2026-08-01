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
import { lensForField, reversibleFields } from "./fields.js";
import { parseQuestFrontMatter, serializeReadable } from "./frontmatter.js";
import { atomicWriteFile, withQuestLock } from "./io.js";
import {
	type JournalChange,
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

function diffTracked(
	id: string,
	before: QuestFrontMatter,
	after: QuestFrontMatter,
): JournalChange[] {
	const changes: JournalChange[] = [];
	// The fields worth journalling are exactly the ones undo can put
	// back, so both read the one lens table rather than keeping a list
	// here that has to be remembered to match.
	for (const field of reversibleFields()) {
		const lens = lensForField(field);
		if (!lens) continue;
		const old = lens.read(before);
		const next = lens.read(after);
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
		// Write-time validation: refuse a mutation that would produce a
		// record the strict parser cannot read back, so an out-of-vocab
		// value is blocked instead of written to invisible drift. Shared
		// with every other quest writer, which is the point of it living
		// beside the parser rather than here.
		const serialized = serializeReadable(stamped, parsed.body);
		if (!serialized.ok) {
			return { ok: false as const, guidance: serialized.reason };
		}
		const outText = serialized.text;

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
