/**
 * Whether an act of the person's hands is already done, judged from the
 * act's own record just before anyone asks him for it.
 *
 * On 16 November at 19:24 the orchestrator asked Joel to post a Slack
 * draft he had posted at 19:18; a session had said the one thing left
 * was his, and the ask went on unchecked. He answered "i believe i sent
 * that message out" (misses row 34). So an ask names its act the way
 * mycelium's served records do (`doneWhen`, PROTOCOL.md's probes), and
 * this judge asks the record: done, not done, or unknown. Only done
 * refuses, since a record that can't be read proves nothing; each probe
 * is held to {@link PROBE_WITHIN_MS}, so a slow GitHub or Slack never
 * holds a send.
 *
 * One judge serves every door that asks for his hands: mesh_send's
 * questions to an orchestrator (read from their words by
 * {@link doneAlreadyRefusal}) and the asks show_person and mesh_wait
 * carry, which name their `doneWhen` outright and call
 * {@link judgeDone}.
 */

import type { Exec } from "../core/exec/exec.ts";

/** What a probe says of an act. */
export type DoneVerdict = "done" | "not-done" | "unknown";

/** A pull request merged, as mycelium's `pr-merged` probe names it. */
export interface PrMerged {
	readonly probe: "pr-merged";
	/** `owner/name`. */
	readonly repo: string;
	readonly number: number;
	/** Only `github`, the default, is asked. */
	readonly host?: string;
}

/**
 * A pull request reviewed by the person, or approved when `approved`
 * says so. Mycelium has no such probe yet; it reads as unknown there.
 */
export interface PrReviewed {
	readonly probe: "pr-reviewed";
	readonly repo: string;
	readonly number: number;
	readonly approved?: boolean;
	readonly host?: string;
}

/**
 * A message the person posted in a Slack channel, or in a thread of it,
 * after `since`. A `verdict` another program wrote is believed for
 * {@link VERDICT_KEPT_MS} after its `at`, as mycelium believes it.
 */
export interface MessagePosted {
	readonly probe: "message-posted";
	readonly channel: string;
	readonly thread?: string;
	/** Since when his post counts, in ms: when the draft was made. */
	readonly since: number;
	readonly verdict?: { readonly done: boolean; readonly at: string };
}

/** An act a probe here can judge; any other `probe` reads as unknown. */
export type DoneWhen = PrMerged | PrReviewed | MessagePosted;

/** The longest one probe may take before it is taken as unknown. */
export const PROBE_WITHIN_MS = 5_000;

/** How long a written verdict is believed: fifteen minutes, as mycelium. */
export const VERDICT_KEPT_MS = 15 * 60_000;

/** What a pull request's record says, times in ms. */
export interface PullRecord {
	readonly mergedAt?: number;
	/** The person's own reviews, oldest first. */
	readonly reviews: ReadonlyArray<{
		readonly approved: boolean;
		readonly at: number;
	}>;
}

/** The record readers: each answers undefined when it can't read now. */
export interface DoneProbes {
	pull(repo: string, number: number): Promise<PullRecord | undefined>;
	/** When the person posted there since `since`, in ms, oldest first. */
	posts(
		channel: string,
		thread: string | undefined,
		since: number,
	): Promise<readonly number[] | undefined>;
}

/** A judgement: the verdict, when it was done, and what to say of it. */
export interface Judged {
	readonly verdict: DoneVerdict;
	readonly at?: number;
	readonly said?: string;
}

const UNKNOWN: Judged = { verdict: "unknown" };

/** A promise held to `ms`, read as undefined past it or on any error. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([work.catch(() => undefined), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** A time of day, as the person reads it. */
export function clockOf(ms: number): string {
	const at = new Date(ms);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Whether a written verdict is still believed at `now`, and what it says. */
function believed(when: MessagePosted, now: number): Judged | undefined {
	if (!when.verdict) return undefined;
	const at = Date.parse(when.verdict.at);
	if (Number.isNaN(at) || now - at < 0 || now - at > VERDICT_KEPT_MS) {
		return undefined;
	}
	return when.verdict.done
		? {
				verdict: "done",
				at,
				said: `a reader of the channel saw his post by ${clockOf(at)}`,
			}
		: { verdict: "not-done" };
}

/** What the pull request's record says of `when`. */
function pullJudged(when: PrMerged | PrReviewed, record: PullRecord): Judged {
	if (when.probe === "pr-merged") {
		return record.mergedAt === undefined
			? { verdict: "not-done" }
			: {
					verdict: "done",
					at: record.mergedAt,
					said: `it merged at ${clockOf(record.mergedAt)}`,
				};
	}
	const review = record.reviews.find((one) => !when.approved || one.approved);
	if (!review) return { verdict: "not-done" };
	const did = when.approved ? "approved" : "reviewed";
	return {
		verdict: "done",
		at: review.at,
		said: `he ${did} it at ${clockOf(review.at)}`,
	};
}

/** Whether `repo` is `owner/name`, each part as GitHub allows. */
function isRepo(repo: unknown): repo is string {
	return (
		typeof repo === "string" &&
		/^[\w.-]+\/[\w.-]+$/.test(repo) &&
		!repo.startsWith("-")
	);
}

/**
 * Whether the act `when` names is done, asked of `probes` and held to
 * {@link PROBE_WITHIN_MS}. A probe it doesn't know, a record that can't
 * be read, or one too slow, is unknown.
 */
export async function judgeDone(
	when:
		| DoneWhen
		| (Readonly<Record<string, unknown>> & { readonly probe: string }),
	probes: DoneProbes,
	now: number,
): Promise<Judged> {
	const act = when as DoneWhen;
	if (act.probe === "pr-merged" || act.probe === "pr-reviewed") {
		if ((act.host ?? "github") !== "github" || !isRepo(act.repo))
			return UNKNOWN;
		if (!Number.isInteger(act.number) || act.number <= 0) return UNKNOWN;
		const record = await within(
			probes.pull(act.repo, act.number),
			PROBE_WITHIN_MS,
		);
		return record ? pullJudged(act, record) : UNKNOWN;
	}
	if (act.probe === "message-posted") {
		const written = believed(act, now);
		if (written) return written;
		const posted = await within(
			probes.posts(act.channel, act.thread, act.since),
			PROBE_WITHIN_MS,
		);
		if (!posted) return UNKNOWN;
		const first = posted.find((at) => at >= act.since);
		return first === undefined
			? { verdict: "not-done" }
			: {
					verdict: "done",
					at: first,
					said: `he posted there at ${clockOf(first)}, after the draft (${clockOf(act.since)})`,
				};
	}
	return UNKNOWN;
}

/** A GraphQL string. */
const quoted = (value: string): string => JSON.stringify(value);

/** One pull request's merge and the person's reviews, read from GitHub's answer. */
export function pullRecordFrom(answer: unknown): PullRecord | undefined {
	const data = (answer as { data?: Record<string, unknown> } | undefined)?.data;
	const me = (data?.viewer as { login?: unknown } | undefined)?.login;
	const pull = (
		data?.repository as { pullRequest?: Record<string, unknown> } | undefined
	)?.pullRequest;
	if (typeof me !== "string" || !pull) return undefined;
	const merged =
		typeof pull.mergedAt === "string" ? Date.parse(pull.mergedAt) : Number.NaN;
	const nodes =
		(pull.reviews as { nodes?: unknown[] } | undefined)?.nodes ?? [];
	const reviews = nodes.flatMap((node) => {
		const review = node as {
			author?: { login?: unknown };
			state?: unknown;
			submittedAt?: unknown;
		};
		const at =
			typeof review.submittedAt === "string"
				? Date.parse(review.submittedAt)
				: Number.NaN;
		// A pending review is a draft he hasn't sent.
		if (
			review.author?.login !== me ||
			review.state === "PENDING" ||
			Number.isNaN(at)
		)
			return [];
		return [{ approved: review.state === "APPROVED", at }];
	});
	return { ...(Number.isNaN(merged) ? {} : { mergedAt: merged }), reviews };
}

/** The GraphQL query for one pull request's merge and reviews. */
export function pullQuery(repo: string, number: number): string {
	const [owner = "", name = ""] = repo.split("/");
	return `query { viewer { login } repository(owner: ${quoted(owner)}, name: ${quoted(name)}) { pullRequest(number: ${number}) { mergedAt reviews(first: 100) { nodes { author { login } state submittedAt } } } } }`;
}

/** Reads his posts in a channel or thread: newest-first Slack messages. */
export type SlackRead = (
	channel: string,
	thread: string | undefined,
	oldest: string,
) => Promise<
	ReadonlyArray<{ readonly ts: string; readonly user?: string }> | undefined
>;

/**
 * The live probes: GitHub through `gh` on `exec`, and Slack through
 * what `slack` gives, which reads as the person, whose id is `me`; it
 * is asked only when a post is judged, so a send asking nothing of
 * Slack never reads its token. Each answers undefined on any failure,
 * so the judge reads it as unknown.
 */
export function liveProbes(
	exec: Exec,
	slack?: () => Promise<
		{ readonly me: string; readonly read: SlackRead } | undefined
	>,
): DoneProbes {
	return {
		async pull(repo, number) {
			const result = await exec("gh", [
				"api",
				"graphql",
				"-f",
				`query=${pullQuery(repo, number)}`,
			]);
			if (result.code !== 0) return undefined;
			try {
				return pullRecordFrom(JSON.parse(result.stdout));
			} catch {
				return undefined;
			}
		},
		async posts(channel, thread, since) {
			const reader = await slack?.();
			if (!reader) return undefined;
			const messages = await reader.read(
				channel,
				thread,
				(since / 1000).toFixed(6),
			);
			if (!messages) return undefined;
			return messages
				.filter((one) => one.user === reader.me)
				.map((one) => Math.round(Number(one.ts) * 1000))
				.filter((at) => at >= since)
				.sort((a, b) => a - b);
		},
	};
}

/** An act of the person's hands a question can ask for. */
export type Act = "post" | "review" | "approve" | "merge";

/** The person, however an ask names him. */
const HIM = /\b(joel|the person|he|him|his)\b/i;

/**
 * Each act, worded as wanted rather than told of: "post", "posting",
 * never "posted". Posting needs what is posted, so "send it to the
 * orchestrator" asks nothing of Slack.
 */
const ACTS: ReadonlyArray<readonly [Act, RegExp]> = [
	["merge", /\bmerg(e|es|ing)\b/i],
	["approve", /\bapprov(e|es|ing|al)\b/i],
	["review", /\breview(s|ing)?\b(?!\s+(cell|council|round|tool|guide))/i],
	[
		"post",
		/\b(post|posting|send|sending|publish|publishing)\b(\s+[\w'-]+){0,4}?\s+(draft|message|reply|announcement|update|note|it|that|this)\b/i,
	],
];

/** A pull request's link, its tabs included. */
const PULL =
	/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)[^\s)\]>"']*/g;

/** A Slack link to a channel, a message in it, or a thread. */
const SLACK =
	/https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?([^\s)\]>"']*)/g;

/**
 * A Slack channel by its name, as sessions write one: "#delta-dev". A
 * mesh group ("#quest/wcjqsg") goes on with a slash, so it isn't one.
 */
const CHANNEL_NAME = /(?<![\w&/])#([a-z0-9][a-z0-9_-]{1,79})(?![\w/-])/g;

/** A draft's time, as an ask says it: "drafted at 18:40". */
const DRAFTED = /\bdrafted at (\d{1,2}):(\d{2})\b/i;

/** How far back his posts count, when nothing says when the draft was made. */
export const DRAFT_WINDOW_MS = 12 * 60 * 60_000;

/** The acts a text asks of the person, if it asks any. */
export function actsAsked(text: string, toHim: boolean): Act[] {
	const asking = text
		.replace(/https?:\/\/\S+/g, "URL")
		.split(/(?<=[.?!])\s+|\n+/)
		.filter((one) => toHim || HIM.test(one));
	return ACTS.filter(([, words]) => asking.some((one) => words.test(one))).map(
		([act]) => act,
	);
}

/** When the draft was made: the time the text gives, the linked message's, or a window back. */
function draftedSince(
	text: string,
	message: string | undefined,
	now: number,
): number {
	const said = DRAFTED.exec(text);
	if (said) {
		const at = new Date(now);
		at.setHours(Number(said[1]), Number(said[2]), 0, 0);
		// A time later than now was yesterday's.
		return at.getTime() > now ? at.getTime() - 86_400_000 : at.getTime();
	}
	if (message) return Math.round(Number(message) * 1000);
	return now - DRAFT_WINDOW_MS;
}

/** A link and the act it can show done. */
export interface Asked {
	readonly link: string;
	readonly when: DoneWhen;
}

/** The acts `acts` names at each place `text` links to, as probes judge them. */
export function doneWhensIn(
	text: string,
	acts: readonly Act[],
	now: number,
): Asked[] {
	const pulls = [...text.matchAll(PULL)].flatMap((found): Asked[] => {
		const repo = `${found[1]}/${found[2]}`;
		const number = Number(found[3]);
		const link = found[0];
		return acts.flatMap((act): Asked[] => {
			if (act === "merge")
				return [{ link, when: { probe: "pr-merged", repo, number } }];
			if (act === "post") return [];
			return [
				{
					link,
					when: {
						probe: "pr-reviewed",
						repo,
						number,
						approved: act === "approve",
					},
				},
			];
		});
	});
	const named = acts.includes("post")
		? [...text.replace(/https?:\/\/\S+/g, "URL").matchAll(CHANNEL_NAME)].map(
				(found): Asked => ({
					link: found[0],
					when: {
						probe: "message-posted",
						channel: found[0],
						since: draftedSince(text, undefined, now),
					},
				}),
			)
		: [];
	const posts = acts.includes("post")
		? [...text.matchAll(SLACK)].map((found): Asked => {
				const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(found[4] ?? "")?.[1];
				const message = found[2] ? `${found[2]}.${found[3]}` : undefined;
				return {
					link: found[0],
					when: {
						probe: "message-posted",
						channel: found[1] ?? "",
						...(thread ? { thread } : {}),
						since: draftedSince(text, message, now),
					},
				};
			})
		: [];
	return [...pulls, ...posts, ...named];
}

/**
 * Why a question that asks the person's hands can't go: the record
 * where it says the act is done (a pull request's link, a Slack link or
 * a channel's name) shows it done. Undefined when it may go: no place
 * named, or no record saying done, since an unread record proves
 * nothing. Refusing an ask that names no place refused 30 of 432
 * questions to an orchestrator, every one sound, so it isn't asked. `toHim` says the text is put to him, so
 * its sentences need not name him.
 */
export async function doneAlreadyRefusal(
	text: string,
	probes: DoneProbes,
	now: number,
	toHim = false,
): Promise<string | undefined> {
	const acts = actsAsked(text, toHim);
	if (acts.length === 0) return undefined;
	const asked = doneWhensIn(text, acts, now);
	const judged = await Promise.all(
		asked.map((one) => judgeDone(one.when, probes, now)),
	);
	const at = judged.findIndex((one) => one.verdict === "done");
	const done = judged[at];
	if (!done || done.at === undefined) return undefined;
	return `already done at ${clockOf(done.at)}: ${done.said} (${asked[at]?.link}). Take the ask back and tell whoever waits on it that it's done. If what he did there was something else, say when the draft was made ("drafted at HH:MM") and ask again.`;
}
