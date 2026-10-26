/**
 * A local range of commits as something models can be asked about.
 *
 * A council, its findings and its rounds are all held against a change,
 * and a range nobody has proposed had none, so every round on one was
 * refused. Sessions either opened a pull request they did not want or gave
 * up on the review. A range is named the way a person names it, base..head,
 * and that name is as stable as a pull request's number: findings stay
 * with it while the branch moves, as they stay with a pull request while
 * its head moves.
 *
 * The provider named on the change is this module's own, never the repo's
 * host, so nothing can hand the name to a host as if it were one of its
 * changes and get somebody else's pull request back.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	BoundTarget,
	ChangeRef,
	Proposal,
} from "../../lib/core/review/index.ts";
import { count } from "../../lib/ui/count.ts";

/** The provider a range's change names, which no host answers to. */
export const RANGE_PROVIDER = "local-range";

/** Room for the log of a long range; git's own default is 1 MiB. */
const LOG_BYTES = 16 * 1024 * 1024;

const run = promisify(execFile);

/** The change a range is held as, or undefined for anything else. */
export function rangeChange(bound: BoundTarget): ChangeRef | undefined {
	const target = bound.target;
	if (target.kind !== "range") return undefined;
	const name = `${target.base}..${target.head}`;
	return {
		provider: RANGE_PROVIDER,
		repo: bound.repo,
		id: name,
		label: `${name} in ${bound.repo.key}`,
	};
}

/** One commit of a range, as its log tells it. */
interface Commit {
	author: string;
	subject: string;
	body: string;
}

/**
 * The range told as a proposal, or undefined for anything else: its
 * commits' messages are its description, and its head is pinned to the
 * commit it names now, so a round reads exactly what was asked about even
 * if the branch moves while it runs. Read from the checkout the core
 * diffs the range in, so the description and the diff cannot disagree
 * about which repository they came from.
 */
export async function rangeProposal(
	bound: BoundTarget,
): Promise<Proposal | undefined> {
	const range = bound.target;
	const change = rangeChange(bound);
	if (range.kind !== "range" || change === undefined) return undefined;
	const root = bound.repo.localPath ?? range.repo.localPath;
	if (root === undefined) {
		throw new Error(
			`${bound.repo.key} has no local checkout to read ${change.id} from. Pass the checkout as repo.`,
		);
	}
	const git = async (...args: string[]) =>
		(await run("git", ["-C", root, ...args], { maxBuffer: LOG_BYTES })).stdout;
	const headCommit = (
		await git("rev-parse", "--verify", `${range.head}^{commit}`)
	).trim();
	const log = await git(
		"log",
		"--reverse",
		"--format=%an%x00%s%x00%b%x1e",
		`${range.base}..${headCommit}`,
	);
	const commits = log
		.split("\x1e")
		.map((record) => record.trim())
		.filter((record) => record.length > 0)
		.map((record): Commit => {
			const [author = "", subject = "", body = ""] = record.split("\x00");
			return { author, subject, body: body.trim() };
		});
	const last = commits.at(-1);
	if (last === undefined) {
		throw new Error(
			`${range.base}..${range.head} holds no commits in ${root}, so there is nothing to put to a reviewer.`,
		);
	}
	return {
		ref: change,
		title:
			commits.length === 1
				? last.subject
				: `${count(commits.length, "commit")} from ${range.base} to ${range.head}`,
		body: commits
			.map((one) => (one.body ? `${one.subject}\n\n${one.body}` : one.subject))
			.join("\n\n"),
		state: "open",
		draft: false,
		author: { id: last.author },
		base: range.base,
		head: range.head,
		headCommit,
	};
}
