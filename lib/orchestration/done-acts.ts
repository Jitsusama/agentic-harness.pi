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
 *
 * Reading an ask from words is loose on purpose where looseness can
 * only let a question through: "he" in a sentence about a peer reads
 * as about Joel, but that refuses only when the record it names says
 * the act is done.
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
 * says so, at or after `since` (RFC 3339). With no `since`, a review
 * counts from the newest commit, and with neither the verdict is
 * unknown, so a review of work since replaced never counts. Mycelium
 * has no such probe yet; it reads as unknown there.
 */
export interface PrReviewed {
	readonly probe: "pr-reviewed";
	readonly repo: string;
	readonly number: number;
	readonly approved?: boolean;
	readonly since?: string;
	readonly host?: string;
}

/**
 * A message the person posted in a Slack channel, or in a thread of it,
 * at or after `since` (RFC 3339): when the draft was made. A `verdict`
 * another program wrote is believed for {@link VERDICT_KEPT_MS} after
 * its `at`, as mycelium believes it.
 */
export interface MessagePosted {
	readonly probe: "message-posted";
	readonly channel: string;
	readonly thread?: string;
	readonly since: string;
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
	/** When its newest commit was made. */
	readonly headAt?: number;
	/** The person's own reviews, oldest first. */
	readonly reviews: ReadonlyArray<{
		readonly approved: boolean;
		readonly at: number;
	}>;
}

/** The record readers: each answers undefined when it can't read now. */
export interface DoneProbes {
	pull(repo: string, number: number): Promise<PullRecord | undefined>;
	/**
	 * When the person posted there since `since`, in ms, oldest first:
	 * in `thread` when one is given, else at the channel's top level.
	 */
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

/** An RFC 3339 time in ms, or undefined when it can't be read. */
function timeOf(stamp: unknown): number | undefined {
	if (typeof stamp !== "string") return undefined;
	const at = Date.parse(stamp);
	return Number.isNaN(at) ? undefined : at;
}

/** Whether a written verdict is still believed at `now`, and what it says. */
function believed(when: MessagePosted, now: number): Judged | undefined {
	if (!when.verdict) return undefined;
	const at = timeOf(when.verdict.at);
	if (at === undefined || now - at < 0 || now - at > VERDICT_KEPT_MS) {
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
	const since = when.since === undefined ? record.headAt : timeOf(when.since);
	if (since === undefined) return UNKNOWN;
	const review = record.reviews.find(
		(one) => one.at >= since && (!when.approved || one.approved),
	);
	if (!review) return { verdict: "not-done" };
	const did = when.approved ? "approved" : "reviewed";
	return {
		verdict: "done",
		at: review.at,
		said: `he ${did} it at ${clockOf(review.at)}, after its newest work (${clockOf(since)})`,
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

/** What the posts in a channel or thread say of `when`. */
async function postsJudged(
	when: MessagePosted,
	probes: DoneProbes,
	now: number,
): Promise<Judged> {
	const written = believed(when, now);
	if (written) return written;
	const since = timeOf(when.since);
	if (since === undefined) return UNKNOWN;
	const posted = await within(
		probes.posts(when.channel, when.thread, since),
		PROBE_WITHIN_MS,
	);
	if (!posted) return UNKNOWN;
	const first = posted.find((at) => at >= since);
	return first === undefined
		? { verdict: "not-done" }
		: {
				verdict: "done",
				at: first,
				said: `he posted there at ${clockOf(first)}, after the draft (${clockOf(since)})`,
			};
}

/**
 * Whether the act `when` names is done, asked of `probes` and held to
 * {@link PROBE_WITHIN_MS}. A probe it doesn't know, a time it can't
 * read, a record that can't be read, or one too slow, is unknown.
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
	if (act.probe === "message-posted") return postsJudged(act, probes, now);
	return UNKNOWN;
}

/** A GraphQL string. */
const quoted = (value: string): string => JSON.stringify(value);

/** The person's sent reviews, from GitHub's review nodes, where `me` is he. */
function reviewsOf(
	nodes: readonly unknown[],
	me: string,
): PullRecord["reviews"] {
	return nodes.flatMap((node) => {
		const review = node as {
			author?: { login?: unknown };
			state?: unknown;
			submittedAt?: unknown;
		};
		const at = timeOf(review.submittedAt);
		// A pending review is a draft he hasn't sent.
		if (
			review.author?.login !== me ||
			review.state === "PENDING" ||
			at === undefined
		)
			return [];
		return [{ approved: review.state === "APPROVED", at }];
	});
}

/** One pull request's merge, newest commit and the person's reviews, read from GitHub's answer. */
export function pullRecordFrom(answer: unknown): PullRecord | undefined {
	const data = (answer as { data?: Record<string, unknown> } | undefined)?.data;
	const me = (data?.viewer as { login?: unknown } | undefined)?.login;
	const pull = (
		data?.repository as { pullRequest?: Record<string, unknown> } | undefined
	)?.pullRequest;
	if (typeof me !== "string" || !pull) return undefined;
	const merged = timeOf(pull.mergedAt);
	const head = (
		pull.commits as
			| { nodes?: { commit?: { committedDate?: unknown } }[] }
			| undefined
	)?.nodes?.[0]?.commit?.committedDate;
	const headAt = timeOf(head);
	const nodes =
		(pull.reviews as { nodes?: unknown[] } | undefined)?.nodes ?? [];
	return {
		...(merged === undefined ? {} : { mergedAt: merged }),
		...(headAt === undefined ? {} : { headAt }),
		reviews: reviewsOf(nodes, me),
	};
}

/** The GraphQL query for one pull request's merge, newest commit and reviews. */
export function pullQuery(repo: string, number: number): string {
	const [owner = "", name = ""] = repo.split("/");
	return `query { viewer { login } repository(owner: ${quoted(owner)}, name: ${quoted(name)}) { pullRequest(number: ${number}) { mergedAt commits(last: 1) { nodes { commit { committedDate } } } reviews(first: 100) { nodes { author { login } state submittedAt } } } } }`;
}

/** A Slack message as the judge reads it. */
export interface SlackPost {
	readonly ts: string;
	readonly user?: string;
	/** The thread it was posted in, which is its own `ts` on a thread's parent. */
	readonly threadTs?: string;
	readonly permalink?: string;
}

/** Reads posts in a channel or thread since `oldest`, a Slack ts. */
export type SlackRead = (
	channel: string,
	thread: string | undefined,
	oldest: string,
) => Promise<ReadonlyArray<SlackPost> | undefined>;

/** Whether a post is a reply in a thread, rather than at the top level. */
function isReply(post: SlackPost): boolean {
	return (
		(post.threadTs !== undefined && post.threadTs !== post.ts) ||
		(post.permalink?.includes("thread_ts=") ?? false)
	);
}

/**
 * The live probes: GitHub through `gh` on `exec`, and Slack through
 * what `slack` gives, which reads as the person, whose id is `me`; it
 * is asked only when a post is judged, so a send asking nothing of
 * Slack never reads its token. Outside a thread only his top-level
 * posts count, since a reply in some thread posts no draft. Each
 * answers undefined on any failure, so the judge reads it as unknown.
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
				.filter(
					(one) =>
						one.user === reader.me && (thread !== undefined || !isReply(one)),
				)
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
 * never "posted". "Send" is the mesh's own word, so it asks nothing of
 * Slack.
 */
const ACTS: ReadonlyArray<readonly [Act, RegExp]> = [
	["merge", /\bmerg(e|es|ing)\b/i],
	["approve", /\bapprov(e|es|ing|al)\b/i],
	["review", /\breview(s|ing)?\b(?!\s+(cell|council|round|tool|guide))/i],
	[
		"post",
		/\b(post|posting|publish|publishing)\b(\s+[\w'-]+){0,4}?\s+(draft|message|reply|announcement|update|note|it|that|this)\b/i,
	],
];

/** A review or approval asked for again, which an earlier one can't answer. */
const AGAIN = /\b(again|re-?review|re-?approve|another look)\b/i;

/** A sentence that speaks of Slack, where a `#name` is a channel. */
const SLACKISH = /\b(slack|channel)\b/i;

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

/** A link, and where it ends: before the punctuation that ends a sentence. */
const LINK = /https?:\/\/\S+?(?=[.?!,;:]*(?:\s|$))/g;

/** A draft's time, as an ask says it: "drafted at 18:40". */
const DRAFTED = /\bdrafted at (\d{1,2}):(\d{2})\b/i;

/** How far back his posts count, when nothing says when the draft was made. */
export const DRAFT_WINDOW_MS = 12 * 60 * 60_000;

/** The most records one question has read; past it, none are. */
export const PROBES_AT_MOST = 6;

/** The text's sentences, each with its links whole. */
function sentencesOf(text: string): string[] {
	const links: string[] = [];
	const held = text.replace(
		LINK,
		(link) => `\u0000${links.push(link) - 1}\u0000`,
	);
	return held
		.split(/(?<=[.?!])\s+|\n+/)
		.map((one) =>
			one.replace(
				/\u0000(\d+)\u0000/g,
				(_, index) => links[Number(index)] ?? "",
			),
		);
}

/** The acts a sentence asks of the person, if it names him. */
function actsIn(sentence: string): Act[] {
	const words = sentence.replace(/https?:\/\/\S+/g, "URL");
	if (!HIM.test(words)) return [];
	const again = AGAIN.test(words);
	return ACTS.filter(
		([act, pattern]) =>
			pattern.test(words) &&
			!(again && (act === "review" || act === "approve")),
	).map(([act]) => act);
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

/** What each act asked in `sentence` reads at a pull request it links. */
function pullsIn(sentence: string, acts: readonly Act[]): Asked[] {
	return [...sentence.matchAll(PULL)].flatMap((found): Asked[] => {
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
}

/** Where a post asked in `sentence` would be, as Slack links and channel names. */
function postsIn(sentence: string, text: string, now: number): Asked[] {
	const iso = (ms: number) => new Date(ms).toISOString();
	const linked = [...sentence.matchAll(SLACK)].map((found): Asked => {
		const message = found[2] ? `${found[2]}.${found[3]}` : undefined;
		// A message's link asks for a reply in its thread.
		const thread =
			/[?&]thread_ts=(\d+\.\d+)/.exec(found[4] ?? "")?.[1] ?? message;
		return {
			link: found[0],
			when: {
				probe: "message-posted",
				channel: found[1] ?? "",
				...(thread ? { thread } : {}),
				since: iso(draftedSince(text, message, now)),
			},
		};
	});
	const words = sentence.replace(/https?:\/\/\S+/g, "URL");
	const named = SLACKISH.test(words)
		? [...words.matchAll(CHANNEL_NAME)].map(
				(found): Asked => ({
					link: found[0],
					when: {
						probe: "message-posted",
						channel: found[0],
						since: iso(draftedSince(text, undefined, now)),
					},
				}),
			)
		: [];
	return [...linked, ...named];
}

/**
 * The acts `text` asks of the person, each paired with the places
 * named in its own sentence, once each. Past {@link PROBES_AT_MOST},
 * none, so a text can't make a send run a crowd of probes.
 */
export function doneWhensIn(text: string, now: number): Asked[] {
	const asked = sentencesOf(text).flatMap((sentence) => {
		const acts = actsIn(sentence);
		if (acts.length === 0) return [];
		return [
			...pullsIn(sentence, acts),
			...(acts.includes("post") ? postsIn(sentence, text, now) : []),
		];
	});
	const once = new Map(asked.map((one) => [JSON.stringify(one.when), one]));
	return once.size > PROBES_AT_MOST ? [] : [...once.values()];
}

/** Probes that read each pull request once, however many acts ask it. */
function readOnce(probes: DoneProbes): DoneProbes {
	const pulls = new Map<string, Promise<PullRecord | undefined>>();
	return {
		pull(repo, number) {
			const key = `${repo}#${number}`;
			const read = pulls.get(key) ?? probes.pull(repo, number);
			pulls.set(key, read);
			return read;
		},
		posts: (channel, thread, since) => probes.posts(channel, thread, since),
	};
}

/**
 * Why a question that asks the person's hands can't go: every act it
 * asks, at the place named beside it (a pull request's link, a Slack
 * link, or a channel's name in a sentence about Slack), shows done in
 * that record. Undefined when it may go: no place named, any act still
 * to do, or any record unread, since an unread record proves nothing.
 * Refusing an ask that names no place refused 30 of 432 questions to an
 * orchestrator, every one sound, so it isn't asked.
 */
export async function doneAlreadyRefusal(
	text: string,
	probes: DoneProbes,
	now: number,
): Promise<string | undefined> {
	const asked = doneWhensIn(text, now);
	if (asked.length === 0) return undefined;
	const reading = readOnce(probes);
	const judged = await Promise.all(
		asked.map((one) => judgeDone(one.when, reading, now)),
	);
	if (judged.some((one) => one.verdict !== "done" || one.at === undefined))
		return undefined;
	const said = judged.map(
		(one, index) => `${one.said} (${asked[index]?.link})`,
	);
	const latest = Math.max(...judged.map((one) => one.at ?? 0));
	return `already done at ${clockOf(latest)}: ${said.join("; ")}. Take the ask back and tell whoever waits on it that it's done. If he must do it again, say so ("again"); if what he did there was something else, say when the draft was made ("drafted at HH:MM"), and ask again.`;
}
