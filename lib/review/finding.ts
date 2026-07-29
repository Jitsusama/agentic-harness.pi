/**
 * A produced finding, held by the substrate.
 *
 * Something reviewed a change and has an observation about it.
 * That observation outlives the thing that produced it: a council
 * run ends, the session carries on, and the findings have to still
 * be there to be read, curated and turned into remarks. So the
 * substrate holds them, not whichever machinery raised them.
 *
 * A finding points at a place through the same `Anchor` a remark
 * uses. That is deliberate rather than convenient: it means a
 * finding carries a witness commit, so one raised against an
 * earlier commit can be told it has gone stale instead of being
 * posted at a line that has since moved.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Anchor } from "./anchor.js";
import type { ChangeRef } from "./change.js";
import { changeKey } from "./keys.js";

/**
 * Conventional Comments labels, which say what kind of remark
 * this is before it says anything else.
 */
export type ConventionalLabel =
	| "praise"
	| "nitpick"
	| "suggestion"
	| "issue"
	| "todo"
	| "question"
	| "thought"
	| "chore"
	| "note";

/** How much it matters, when whatever raised it says. */
export type FindingSeverity = "critical" | "medium" | "minor";

/**
 * Where a finding came from.
 *
 * No forge appears here, and none should: this says which pass of
 * which run raised the thing, which is a fact about the reviewing
 * rather than about what hosts the change. A finding somebody
 * typed is `hand`, and it is deliberately not called `user`,
 * since the agent writing one by hand is the same act.
 */
export type FindingOrigin =
	| { kind: "hand" }
	| { kind: "reviewer"; runId: string; reviewerId: string }
	| { kind: "judge"; runId: string; reviewerId: string };

/** One observation about a change. */
export interface Finding {
	/**
	 * Stable within a change, climbing and never reused, because
	 * people refer to findings by number out loud and a number
	 * that gets recycled makes a conversation wrong later.
	 */
	id: number;
	/** Where it points, witness and all. */
	anchor: Anchor;
	label: ConventionalLabel;
	/** The one-line claim. */
	subject: string;
	/** The argument for it. */
	discussion: string;
	origin: FindingOrigin;
	severity?: FindingSeverity;
	/** How sure the producer was, where it says. */
	confidence?: number;
	/**
	 * Reviewer ids that raised the same thing, set when a pass
	 * consolidates several into one. Agreement is evidence, so it
	 * is worth keeping rather than collapsing.
	 */
	raisedBy?: string[];
}

/** Findings held per change, outliving whatever produced them. */
export interface FindingStore {
	/** Add findings to a change, numbering them as they land. */
	record(
		change: ChangeRef,
		findings: Omit<Finding, "id">[],
	): Promise<Finding[]>;
	/** Every finding on a change, in the order they were raised. */
	list(change: ChangeRef): Promise<Finding[]>;
	/** Forget a change's findings, without rewinding its numbering. */
	clear(change: ChangeRef): Promise<void>;
}

/** What one change's file holds. */
interface Ledger {
	findings: Finding[];
	/**
	 * Highest number ever handed out, kept apart from the findings
	 * so clearing them does not rewind it. A cleared change that
	 * starts again at one would give two different findings the
	 * same name in one conversation.
	 */
	issued: number;
}

/** Findings on disk, one file per change. */
export function createFindingStore(root: string): FindingStore {
	async function read(change: ChangeRef): Promise<Ledger> {
		try {
			const raw = await readFile(join(root, fileFor(change)), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"findings" in parsed &&
				Array.isArray(parsed.findings)
			) {
				const ledger = parsed as Ledger;
				return {
					findings: ledger.findings,
					issued: ledger.issued ?? ledger.findings.length,
				};
			}
		} catch {
			// No file, or one nothing can read. Either way this
			// change has no findings to report, which is an answer
			// rather than a failure.
		}
		return { findings: [], issued: 0 };
	}

	async function write(change: ChangeRef, ledger: Ledger): Promise<void> {
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, fileFor(change)),
			JSON.stringify(ledger, null, 2),
			"utf8",
		);
	}

	return {
		async record(change, raised) {
			const ledger = await read(change);
			const added = raised.map((finding, index) => ({
				...finding,
				id: ledger.issued + index + 1,
			}));
			await write(change, {
				findings: [...ledger.findings, ...added],
				issued: ledger.issued + added.length,
			});
			return added;
		},

		async list(change) {
			return (await read(change)).findings;
		},

		async clear(change) {
			const ledger = await read(change);
			if (ledger.issued === 0) {
				await rm(join(root, fileFor(change)), { force: true });
				return;
			}
			await write(change, { findings: [], issued: ledger.issued });
		},
	};
}

/**
 * One file per change.
 *
 * Keyed by the change's key rather than its label, because a
 * label is for people and can hold characters a path cannot, and
 * two systems can spell one label the same way.
 */
function fileFor(change: ChangeRef): string {
	const safe = changeKey(change)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+/, "_");
	return `${safe}.json`;
}
