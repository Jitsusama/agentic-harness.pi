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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../internal/file-lock.ts";
import type { Anchor } from "./anchor.ts";
import type { ChangeRef } from "./change.ts";
import { changeKey } from "./keys.ts";

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
	/**
	 * The machine whose round raised it, when it was adopted from that
	 * machine's mirror; absent for a finding raised here.
	 */
	node?: string;
}

/** A round another machine ran, as its findings are adopted here. */
export interface AdoptedRound {
	/** The machine it ran on, as its mirror is named. */
	readonly node: string;
	readonly runId: string;
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
	/**
	 * Add the findings another machine's round raised, numbered after
	 * those held and marked with its node, once: a round already adopted
	 * from that node adds nothing, even after a clear. Answers what it
	 * added.
	 */
	adopt(
		change: ChangeRef,
		round: AdoptedRound,
		findings: readonly Omit<Finding, "id" | "node">[],
	): Promise<Finding[]>;
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
	/**
	 * The rounds adopted from other machines, kept apart from the
	 * findings for the same reason as `issued`: a cleared change that
	 * adopted them again would bring back what was put away.
	 */
	adopted?: AdoptedRound[];
}

/** The findings one round raised: a run's, or those written by hand. */
export interface FindingRound {
	/** The run's id, or nothing for findings written by hand. */
	readonly runId?: string;
	readonly findings: readonly Finding[];
}

/**
 * A change's findings by the round that raised them, the newest round
 * first and each round's findings in the order raised. A round is as new
 * as the newest finding in it, since numbers climb as findings land and
 * a run's id need not sort by time (a judge's and a council's differ in
 * kind). Read oldest first, a change reviewed sixteen times showed its
 * first round's findings and cut the newest round's, which then read as
 * findings on code thirteen commits gone (19AMVE, 29 October).
 */
export function byRoundNewestFirst(
	findings: readonly Finding[],
): FindingRound[] {
	const rounds = new Map<string, Finding[]>();
	for (const finding of findings) {
		const key = finding.origin.kind === "hand" ? "" : finding.origin.runId;
		rounds.set(key, [...(rounds.get(key) ?? []), finding]);
	}
	const newest = (round: readonly Finding[]) =>
		Math.max(...round.map((finding) => finding.id));
	return [...rounds.entries()]
		.map(([key, round]) => ({
			...(key === "" ? {} : { runId: key }),
			findings: [...round].sort((a, b) => a.id - b.id),
		}))
		.sort((a, b) => newest(b.findings) - newest(a.findings));
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
					...(Array.isArray(ledger.adopted) ? { adopted: ledger.adopted } : {}),
				};
			}
		} catch {
			// No file, or one nothing can read. Either way this
			// change has no findings to report, which is an answer
			// rather than a failure.
		}
		return { findings: [], issued: 0 };
	}

	/**
	 * Lays the ledger down whole, through a file of its own renamed over
	 * the change's, so a reader never meets half of it: read as nothing,
	 * a half-written ledger would have the next write drop every finding.
	 */
	async function write(change: ChangeRef, ledger: Ledger): Promise<void> {
		const path = join(root, fileFor(change));
		const laying = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(laying, JSON.stringify(ledger, null, 2), "utf8");
		await rename(laying, path);
	}

	/**
	 * Runs one read-modify-write of a change's ledger alone. A council
	 * recording its round and a session adopting a node's round, or two
	 * sessions adopting one, each read the ledger first, and the later
	 * write would lay its copy over the other's findings.
	 */
	async function alone<T>(change: ChangeRef, work: () => Promise<T>) {
		await mkdir(root, { recursive: true });
		return await withFileLock(join(root, fileFor(change)), work);
	}

	return {
		async record(change, raised) {
			return await alone(change, async () => {
				const ledger = await read(change);
				const added = raised.map((finding, index) => ({
					...finding,
					id: ledger.issued + index + 1,
				}));
				await write(change, {
					...ledger,
					findings: [...ledger.findings, ...added],
					issued: ledger.issued + added.length,
				});
				return added;
			});
		},

		async adopt(change, round, raised) {
			return await alone(change, async () => {
				const ledger = await read(change);
				const adopted = ledger.adopted ?? [];
				const already = adopted.some(
					(held) => held.node === round.node && held.runId === round.runId,
				);
				if (already) return [];
				const added = raised.map((finding, index) => ({
					...finding,
					node: round.node,
					id: ledger.issued + index + 1,
				}));
				await write(change, {
					findings: [...ledger.findings, ...added],
					issued: ledger.issued + added.length,
					adopted: [...adopted, { node: round.node, runId: round.runId }],
				});
				return added;
			});
		},

		async list(change) {
			return (await read(change)).findings;
		},

		async clear(change) {
			await alone(change, async () => {
				const ledger = await read(change);
				if (ledger.issued === 0 && (ledger.adopted ?? []).length === 0) {
					await rm(join(root, fileFor(change)), { force: true });
					return;
				}
				await write(change, { ...ledger, findings: [] });
			});
		},
	};
}

/**
 * Whether `file`, named as this store names a change's findings, holds
 * a change in the repo keyed `repo`: another machine's findings are
 * mirrored as its files are, so its change is read from the name.
 */
export function namesRepo(file: string, repo: string): boolean {
	return file.includes(`_${safeCharacters(repo)}_`);
}

/**
 * One file per change.
 *
 * Keyed by the change's key rather than its label, because a
 * label is for people and can hold characters a path cannot, and
 * two systems can spell one label the same way.
 */
function fileFor(change: ChangeRef): string {
	return `${slugged(changeKey(change))}.json`;
}

/** `key` as one safe file name, never one that walks. */
function slugged(key: string): string {
	return safeCharacters(key).replace(/^\.+/, "_");
}

/** `text` with each character a file name can't safely hold as `_`. */
function safeCharacters(text: string): string {
	return text.replace(/[^A-Za-z0-9._-]/g, "_");
}
