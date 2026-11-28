/**
 * Another machine's findings on a hosted change, adopted as they are read.
 *
 * A council run on another machine reviews a local range there, and the
 * ready gate counts it from the ledger mirrored under runs-from. Its
 * findings and kept answers are mirrored too, under findings-from and
 * answers-from, but keyed under the node's local range and in another
 * folder, so `review_see findings` on the hosted change said nothing was
 * raised and nobody could decide them or record a fix.
 *
 * So reading a hosted change's findings first adopts them: each mirrored
 * round that counts for the change exactly as the gate counts it (a
 * finished, pinned round in the same repo that read one of its commits)
 * has its findings copied into this machine's store under the hosted
 * change, keeping their round and naming their node, and its answers
 * copied under `answers` when they are not there yet. A round is adopted
 * once, keyed by its node and id, and only once its findings have
 * arrived, so a findings mirror that lags its ledger adopts them later
 * rather than never. Deciding, the fix queue and the gate then work on
 * them as on a round run here; they are agent text like any round's.
 *
 * The mirrors are read as the gate reads runs-from: a node is a folder or
 * a link to one, a node that can't be read is named rather than thrown
 * on, and nothing under them is ever written.
 */

import { randomUUID } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Exec } from "../../lib/core/exec/index.ts";
import { namesRepo } from "../../lib/core/review/finding.ts";
import {
	type BoundTarget,
	type ChangeRef,
	createFindingStore,
	createRunStore,
	type Finding,
} from "../../lib/core/review/index.ts";
import { errnoOf, isGone } from "../../lib/internal/files/errno.ts";
import { tidyTree } from "../../lib/internal/files/remove-tree.ts";
import {
	answerDir,
	findingDir,
	mirroredAnswersDir,
	mirroredFindingsDir,
} from "./engine.ts";
import { countedCommits, mirroredLedgers } from "./reviewed-first.ts";
import { roundAnswers } from "./reviewer.ts";

/** What adopting found, as sentences, for a reader to act on. */
export interface Adoption {
	/** How many findings were adopted, by the node they came from. */
	readonly adopted: ReadonlyMap<string, number>;
	/** Why a mirror couldn't be read, or the change's commits couldn't. */
	readonly trouble: readonly string[];
}

/**
 * Adopt the findings of every mirrored round that counts for the hosted
 * `change`, reading its commits from `checkout` as the gate does. Never
 * throws: what couldn't be read is said in `trouble`, and the findings
 * already held stand.
 */
export async function adoptMirroredFindings(
	exec: Exec,
	bound: BoundTarget,
	change: ChangeRef,
	checkout: string,
): Promise<Adoption> {
	const adopted = new Map<string, number>();
	const { ledgers, trouble: unread } = await mirroredLedgers();
	const trouble = [...unread];
	// No mirror is the ordinary case, and asking the backend for the
	// change's commits would cost a call for nothing.
	if (ledgers.length === 0) return { adopted, trouble };
	const commits = await commitsOf(exec, bound, change, checkout);
	if (typeof commits === "string") {
		return { adopted, trouble: [...trouble, commits] };
	}
	const store = createFindingStore(findingDir());
	for (const ledger of ledgers) {
		const node = basename(ledger);
		const rounds = await createRunStore(ledger).witnessing(
			bound.repo.key,
			commits,
		);
		if (rounds.length === 0) continue;
		const mirrored = await mirroredFindingsOf(node, bound.repo.key);
		if (typeof mirrored === "string") {
			trouble.push(mirrored);
			continue;
		}
		for (const round of rounds) {
			const raised = mirrored.filter(
				(finding) =>
					finding.origin.kind !== "hand" && finding.origin.runId === round.id,
			);
			if (raised.length === 0) continue;
			const added = await store.adopt(
				change,
				{ node, runId: round.id },
				raised.map(withoutNumber),
			);
			if (added.length > 0) {
				adopted.set(node, (adopted.get(node) ?? 0) + added.length);
			}
			const copied = await copyAnswers(node, round.id);
			if (copied !== undefined) trouble.push(copied);
		}
	}
	return { adopted, trouble };
}

/**
 * The commits the gate counts for `change`, from its base and head as
 * its backend reports them; or why they couldn't be read.
 */
async function commitsOf(
	exec: Exec,
	bound: BoundTarget,
	change: ChangeRef,
	checkout: string,
): Promise<ReadonlySet<string> | string> {
	const changes = bound.provider.changes;
	if (changes === undefined) {
		return `Findings mirrored from other machines weren't adopted: ${bound.provider.id} can't say what ${change.label}'s commits are.`;
	}
	try {
		const hosted = await changes.fetch(change);
		return await countedCommits(exec, {
			repo: bound.repo.key,
			checkout: change.repo.localPath ?? checkout,
			base: hosted.base,
			head: hosted.head,
			...(hosted.headCommit ? { headCommit: hosted.headCommit } : {}),
		});
	} catch (error) {
		return `Findings mirrored from other machines weren't adopted: ${change.label} couldn't be read (${messageOf(error)}).`;
	}
}

/**
 * Every finding mirrored from `node` in a file of the repo keyed `repo`,
 * or why the node's folder couldn't be read. A node with no findings
 * mirrored yet, a stray file where its folder would be, a file that
 * won't parse or one gone since the listing all hold none.
 */
async function mirroredFindingsOf(
	node: string,
	repo: string,
): Promise<Finding[] | string> {
	const folder = join(mirroredFindingsDir(), node);
	let names: string[];
	try {
		names = await readdir(folder);
	} catch (error) {
		// Not mirrored yet, or a stray file in a node's place: no findings
		// to adopt, and the round is adopted once they arrive.
		if (isGone(error)) return [];
		return `The findings mirrored from ${node} couldn't be read (${messageOf(error)}), so none of its rounds were adopted.`;
	}
	const found: Finding[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json") || !namesRepo(name, repo)) continue;
		found.push(...(await findingsIn(join(folder, name))));
	}
	return found;
}

/** The findings a mirrored findings file holds, or none when it won't read. */
async function findingsIn(path: string): Promise<Finding[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		// Gone since the listing, or torn mid-copy: the next read, once the
		// mirror has written it whole, adopts what it holds.
		return [];
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("findings" in parsed) ||
		!Array.isArray(parsed.findings)
	) {
		return [];
	}
	return parsed.findings.filter(isFinding);
}

/** Whether `value` reads as a finding a round raised. */
function isFinding(value: unknown): value is Finding {
	if (typeof value !== "object" || value === null) return false;
	const origin = "origin" in value ? value.origin : undefined;
	return (
		"id" in value &&
		typeof value.id === "number" &&
		"subject" in value &&
		typeof value.subject === "string" &&
		"anchor" in value &&
		typeof value.anchor === "object" &&
		value.anchor !== null &&
		typeof origin === "object" &&
		origin !== null &&
		"runId" in origin &&
		typeof origin.runId === "string"
	);
}

/** A finding as it lands here, its number and any node it named left to the store. */
function withoutNumber(finding: Finding): Omit<Finding, "id" | "node"> {
	const { id: _id, node: _node, ...rest } = finding;
	return rest;
}

/**
 * Copy round `runId`'s answers mirrored from `node` under this machine's
 * answers, unless that round's answers are there already, so a finding's
 * provenance resolves here. Only folders and plain files are copied: a
 * link inside the mirror could point anywhere. Written beside and renamed
 * into place, so a reader sees all of them or none. Answers why it
 * couldn't, or nothing.
 */
async function copyAnswers(
	node: string,
	runId: string,
): Promise<string | undefined> {
	const target = roundAnswers(answerDir(), runId);
	if (await exists(target)) return undefined;
	let source: string;
	try {
		source = await realpath(
			roundAnswers(join(mirroredAnswersDir(), node), runId),
		);
	} catch (error) {
		// No answers mirrored for the round: its findings stand without.
		if (errnoOf(error) === "ENOENT") return undefined;
		return `The answers of round ${runId} mirrored from ${node} couldn't be read (${messageOf(error)}).`;
	}
	const pending = join(
		dirname(target),
		`.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await mkdir(dirname(target), { recursive: true });
		await cp(source, pending, {
			recursive: true,
			filter: async (from) => plainOrFolder(from),
		});
		await rename(pending, target);
		return undefined;
	} catch (error) {
		// A pending copy left behind is a hidden folder beside the answers,
		// read by nothing; the copy is tried again at the next read.
		tidyTree(pending);
		// Another session copied them first: they are there, as wanted.
		if (await exists(target)) return undefined;
		return `The answers of round ${runId} mirrored from ${node} couldn't be copied (${messageOf(error)}).`;
	}
}

/** Whether `path` is a plain file or a folder, not a link or a device. */
async function plainOrFolder(path: string): Promise<boolean> {
	try {
		const found = await lstat(path);
		return found.isFile() || found.isDirectory();
	} catch {
		// Gone since the listing: nothing to copy.
		return false;
	}
}

/** Whether anything is at `path`. */
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		// Not there, or not reachable: either way not answers to keep.
		return false;
	}
}

/** An error's message, or the thing thrown as text. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What adopting did, as lines to put above what was read. */
export function adoptionLines(adoption: Adoption): string[] {
	const adopted = [...adoption.adopted.entries()].map(
		([node, many]) =>
			`Adopted ${many === 1 ? "1 finding" : `${many} findings`} from ${node}'s mirrored rounds.`,
	);
	return [...adopted, ...adoption.trouble];
}
