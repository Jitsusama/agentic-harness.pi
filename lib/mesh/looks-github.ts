/**
 * Asking GitHub about the pull requests the person was pointed at, so a
 * look clears itself once what it pointed at no longer needs them.
 *
 * Joel, 8 November 14:03: "i shouldn't be required to mark a notice as
 * read if I looked at the slack message in slack for example." A look at
 * a pull request merged on GitHub's own page, from another machine, or
 * one he has reviewed there, is done with, though no session here saw
 * it. Nothing tells this machine so (a webhook needs a public endpoint,
 * and his notifications cover only pull requests that notify him), so
 * one session at a time asks, every few minutes, about the waiting looks
 * alone, in one call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../internal/record.ts";
import { writeWhole } from "../internal/write-whole.ts";
import { type Look, type LookResolution, looksIn } from "./looks.ts";

/** How often the looks are asked about, at most, across every session. */
export const ASK_EVERY_MS = 5 * 60_000;

/** The most pull requests one ask names. */
export const MOST_ASKED = 50;

/** The file whose time says when the looks were last asked about. */
const ASKED = ".asked";

/** A pull request on GitHub, as a look's target names it. */
export interface PullRef {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

/** The pull request a GitHub URL names, its tabs included, or none. */
export function pullOf(url: string): PullRef | undefined {
	const found =
		/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(
			url.trim(),
		);
	if (!found?.[1] || !found[2] || !found[3]) return undefined;
	return { owner: found[1], repo: found[2], number: Number(found[3]) };
}

/** The waiting looks at GitHub pull requests, newest first, at most {@link MOST_ASKED}. */
export function askable(
	looks: readonly Look[],
): Array<Look & { pull: PullRef }> {
	return looks
		.filter(
			(look) =>
				look.state === "waiting" &&
				(look.kind === "pr" || look.kind === "diff"),
		)
		.flatMap((look) => {
			const pull = pullOf(look.target);
			return pull ? [{ ...look, pull }] : [];
		})
		.slice(0, MOST_ASKED);
}

/** A string as GraphQL reads one. */
function quoted(value: string): string {
	return JSON.stringify(value);
}

/** One GraphQL query asking each pull request's state and its reviewers. */
export function queryFor(pulls: readonly PullRef[]): string {
	const asked = pulls.map(
		(pull, at) =>
			`p${at}: repository(owner: ${quoted(pull.owner)}, name: ${quoted(pull.repo)}) { pullRequest(number: ${pull.number}) { state reviews(first: 50) { nodes { author { login } } } } }`,
	);
	return `query { viewer { login } ${asked.join(" ")} }`;
}

/** How one look resolved, read from GitHub's answer. */
export interface Resolved {
	readonly id: string;
	readonly how: LookResolution;
}

/** A value as an object whose fields may be read, or none. */
function fields(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/**
 * How each asked look resolved, from GitHub's answer to {@link queryFor}:
 * merged, closed, or reviewed by the person's own account. A pull request
 * still open and unreviewed by them, or one GitHub didn't answer for,
 * resolves no look.
 */
export function resolutionsFrom(
	asked: ReadonlyArray<{ readonly id: string }>,
	answer: unknown,
): Resolved[] {
	const data = fields(fields(answer)?.data);
	if (!data) return [];
	const me = fields(data.viewer)?.login;
	return asked.flatMap((look, at): Resolved[] => {
		const pull = fields(fields(data[`p${at}`])?.pullRequest);
		if (!pull) return [];
		if (pull.state === "MERGED") return [{ id: look.id, how: "merged" }];
		if (pull.state === "CLOSED") return [{ id: look.id, how: "closed" }];
		const reviews = fields(pull.reviews)?.nodes;
		const reviewed =
			typeof me === "string" &&
			Array.isArray(reviews) &&
			reviews.some((review) => fields(fields(review)?.author)?.login === me);
		return reviewed ? [{ id: look.id, how: `reviewed by ${me}` }] : [];
	});
}

/**
 * Take this turn at asking, when nobody has asked within
 * {@link ASK_EVERY_MS}: answers whether this session asks now. The mark
 * is written before asking, so two sessions looking at once rarely both
 * ask, and one that does costs one extra call.
 */
export function takeTurnToAsk(
	dir: string,
	session: string,
	now: number,
): boolean {
	const mark = join(dir, ASKED);
	try {
		const at = fields(JSON.parse(readFileSync(mark, "utf8")))?.at;
		if (typeof at === "number" && now - at < ASK_EVERY_MS) return false;
	} catch {
		// Never asked, or a mark being replaced: this session may ask.
	}
	writeWhole(mark, `${JSON.stringify({ at: now, session })}\n`);
	return true;
}

/** Mark the looks GitHub's answer resolved, by id; answers how many. */
export function markResolved(
	dir: string,
	resolved: readonly Resolved[],
	now: Date = new Date(),
): number {
	const byId = new Map(resolved.map((one) => [one.id, one.how]));
	let marked = 0;
	for (const look of looksIn(dir)) {
		const how = byId.get(look.id);
		if (!how || look.state !== "waiting") continue;
		const done: Look = {
			...look,
			state: "resolved",
			how,
			resolvedAt: now.toISOString(),
		};
		writeWhole(
			join(dir, `${look.id}.json`),
			`${JSON.stringify(done, null, 2)}\n`,
		);
		marked++;
	}
	return marked;
}
