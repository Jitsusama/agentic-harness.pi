/**
 * The compaction host: the one answer to pi's `session_before_compact`,
 * with the summary itself asked of a chain of providers.
 *
 * The host owns everything around the summary. It writes one ahead of
 * the compaction when the trigger asks (`prepare`), so nobody waits for
 * it, and applies it once the compaction comes, keeping verbatim
 * everything after the point it covers (`keptBoundary`). A compaction
 * asked for while one is being written waits for that one rather than
 * writing a second. It holds each write to a clock, asks other
 * extensions for their focus and appendix, appends the file lists, and
 * records which provider wrote the summary and every one that declined
 * or failed before it.
 *
 * The chain is walked in order. On the spot, the first provider whose
 * `assess` passes writes, and a failure moves on to the next. Ahead,
 * the first that passes writes, and a failure leaves the compaction to
 * the walk on the spot. When every provider declines or fails, pi's own
 * summariser runs as it would with no extension, and the reason is
 * recorded, so the worst case is pi's behaviour.
 *
 * A focus somebody typed skips providers that cannot follow one, and
 * discards a summary written ahead without it. A contributed focus
 * skips nobody; a summary written without following it says so.
 */

import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveChain } from "../../lib/compaction/chain.ts";
import {
	COMPACTION_READY,
	COMPACTION_REGISTER_PROVIDER,
	COMPACTION_REQUEST,
	type CompactionFocus,
	type CompactionHostApi,
	type CompactionPreparation,
	type CompactionProvider,
	type CompactionReason,
	type CompactionRequest,
	type CompactionTiming,
	type CompactionWritten,
	isCompactionProvider,
	keptBoundary,
	newContributions,
	SUMMARY_CONTRIBUTIONS,
	type SummaryContributions,
	withFileLists,
} from "../../lib/compaction/index.ts";

/** Custom entry recording a compaction the chain handed back to pi. */
export const SUMMARY_FALLBACK_ENTRY = "compaction-summary-fallback";

/** Custom entry recording a summary written ahead that went unused, and why. */
export const AHEAD_UNUSED_ENTRY = "compaction-summary-ahead-unused";

/**
 * How long one summary may take to write. A summary written ahead runs
 * where nobody sees it, so a model that stops answering would leave it
 * writing for good, and any compaction that came to wait on it too.
 * This sits a little past what the cap takes at about 80 tokens a
 * second, so only a stalled call reaches it. Each write has its own.
 */
export const SUMMARY_WALL_MS = 12 * 60_000;

/** pi's own cap on a summary: this share of the reserve. */
const SUMMARY_SHARE_OF_RESERVE = 0.8;

/**
 * The reserve a summary written ahead is capped against. pi hands an
 * extension its settings only with a compaction, so ahead of one this
 * is the reserve the failure notice recommends and the harness runs
 * at: a 51,200-token cap.
 */
const ASSUMED_RESERVE_TOKENS = 64_000;

/** The reason recorded against a configured id nothing registered. */
const UNKNOWN_PROVIDER = "no provider is registered with this id";

/** One provider that did not write the summary, and why. */
export interface CompactionAttempt {
	readonly provider: string;
	readonly timing: CompactionTiming;
	readonly outcome: "declined" | "failed";
	readonly reason: string;
}

/** A write and how long it took. */
interface Timed {
	readonly written: CompactionWritten;
	readonly ms: number;
}

/** A summary being written, or written, ahead of the compaction. */
interface Ahead {
	readonly provider: CompactionProvider;
	readonly request: CompactionRequest;
	readonly controller: AbortController;
	readonly done: Promise<Timed>;
	readonly attempts: readonly CompactionAttempt[];
	result?: Timed;
}

/** Where a summary written ahead of the compaction stands. */
export type AheadState = "none" | "writing" | "ready" | "failed";

/** What the trigger can ask of the host. */
export interface CompactionHost {
	/**
	 * Start writing the summary of the conversation as it stands, in the
	 * background. Refused, with the reason, when no provider can write
	 * one ahead; a summary already under way is left to finish.
	 */
	prepare(
		ctx: ExtensionContext,
		contextTokens: number,
	): { ok: true } | { ok: false; reason: string };
	state(): AheadState;
	/** The reason a summary written ahead failed, once, clearing it. */
	takeFailure(): string | undefined;
	/** Called when a summary written ahead is ready to apply. */
	whenReady(listener: (ctx: ExtensionContext) => void): void;
	/**
	 * What the first provider that would write a summary now says it
	 * costs, ahead where one can, or nothing when none would.
	 */
	summaryDollars(
		ctx: ExtensionContext,
		contextTokens: number,
	): number | undefined;
}

export interface CompactionHostOptions {
	/** The providers that ship with the host. */
	readonly providers: readonly CompactionProvider[];
	/** Output the next summary is expected to take, thinking included. */
	readonly expectedOutputTokens: () => number;
}

/** A provider the chain will ask, with what it said it costs. */
interface Candidate {
	readonly provider: CompactionProvider;
	readonly dollars: number;
}

/**
 * Answer compaction with the provider chain, write summaries ahead when
 * asked, and take registrations over the event bus.
 */
export function registerCompactionHost(
	pi: ExtensionAPI,
	options: CompactionHostOptions,
): CompactionHost {
	const registry = new Map<string, CompactionProvider>();
	for (const provider of options.providers) registry.set(provider.id, provider);
	const chain = () => resolveChain(registry.values(), process.env);

	const api: CompactionHostApi = {
		registerProvider(provider) {
			registry.set(provider.id, provider);
		},
		listProviders() {
			return chain().providers.map((provider) => provider.id);
		},
	};
	pi.events.on(COMPACTION_REGISTER_PROVIDER, (data: unknown) => {
		if (isCompactionProvider(data)) registry.set(data.id, data);
	});
	// A provider that loaded after this extension missed the
	// announcement, and the bus does not replay; asking is how it
	// catches up, so load order decides nothing.
	pi.events.on(COMPACTION_REQUEST, () => pi.events.emit(COMPACTION_READY, api));
	pi.events.emit(COMPACTION_READY, api);

	let ahead: Ahead | null = null;
	const readyListeners: Array<(ctx: ExtensionContext) => void> = [];

	const drop = () => {
		ahead?.controller.abort();
		ahead = null;
	};
	pi.on("session_start", async () => drop());
	pi.on("session_shutdown", async () => drop());
	pi.on("session_compact", async () => drop());

	/**
	 * The providers that would write this request, in chain order, each
	 * asked only once the one before it has been passed over. Declines
	 * are recorded as they happen.
	 */
	function* candidates(
		request: CompactionRequest,
		attempts: CompactionAttempt[],
	): Generator<Candidate> {
		const { providers, unknown } = chain();
		const declined = (provider: string, reason: string) =>
			attempts.push({
				provider,
				timing: request.timing,
				outcome: "declined",
				reason,
			});
		for (const id of unknown) declined(id, UNKNOWN_PROVIDER);
		const typed = request.focus.requested?.trim();
		for (const provider of providers) {
			if (typed && !provider.followsFocus) {
				declined(provider.id, "it cannot follow a typed focus");
				continue;
			}
			const assessment = assessed(provider, request);
			if (!assessment.ok) {
				declined(provider.id, assessment.reason);
				continue;
			}
			yield { provider, dollars: assessment.dollars };
		}
	}

	const request = (
		ctx: ExtensionContext,
		timing: CompactionTiming,
		reason: CompactionReason,
		details: {
			focus: CompactionFocus;
			contextTokens: number;
			reserveTokens: number;
			preparation?: CompactionPreparation;
		},
	): CompactionRequest | undefined => {
		const coveredLeafId = ctx.sessionManager.getLeafId();
		if (coveredLeafId === null) return undefined;
		const branch = ctx.sessionManager.getBranch();
		return {
			timing,
			reason,
			ctx,
			branch,
			coveredLeafId,
			preparation: details.preparation,
			hasPreviousSummary: details.preparation
				? details.preparation.previousSummary !== undefined
				: branch.some((entry) => entry.type === "compaction"),
			focus: details.focus,
			contextTokens: details.contextTokens,
			expectedOutputTokens: options.expectedOutputTokens(),
			maxSummaryTokens: Math.floor(
				SUMMARY_SHARE_OF_RESERVE * details.reserveTokens,
			),
		};
	};

	pi.on("session_before_compact", async (event, ctx) => {
		const started = Date.now();
		// Asked for before anything can decline, so a contributor always
		// holds this compaction's request and never a stale one; listeners
		// fill it in synchronously, as pi.events calls them.
		const contributions = newContributions(event.preparation);
		pi.events.emit(SUMMARY_CONTRIBUTIONS, contributions);
		const attempts: CompactionAttempt[] = [];

		const taken = ahead;
		ahead = null;
		if (taken) {
			attempts.push(...taken.attempts);
			const used = await applicable(taken, event, ctx);
			if (event.signal.aborted) {
				taken.controller.abort();
				return;
			}
			if (used.ok) {
				contributions.handled = true;
				return {
					compaction: checkpoint(event, contributions, {
						provider: taken.provider,
						request: taken.request,
						written: used.written,
						firstKeptEntryId: used.firstKeptEntryId,
						summaryMs: used.ms,
						waitedMs: Date.now() - started,
						attempts,
					}),
				};
			}
			attempts.push({
				provider: taken.provider.id,
				timing: "ahead",
				outcome: "failed",
				reason: used.reason,
			});
			// A failure while writing was recorded when it happened.
			if (used.unused)
				pi.appendEntry(AHEAD_UNUSED_ENTRY, { reason: used.reason });
		}

		const { preparation } = event;
		const onTheSpot = request(ctx, "on the spot", event.reason, {
			focus: {
				requested: event.customInstructions,
				contributed: contributions.instructions,
			},
			contextTokens: preparation.tokensBefore,
			reserveTokens: preparation.settings.reserveTokens,
			preparation,
		});
		if (onTheSpot) {
			for (const { provider } of candidates(onTheSpot, attempts)) {
				const timed = await writeWithin(provider, onTheSpot, event.signal);
				if (event.signal.aborted) return;
				if (timed.written.ok) {
					contributions.handled = true;
					return {
						compaction: checkpoint(event, contributions, {
							provider,
							request: onTheSpot,
							written: timed.written,
							firstKeptEntryId: preparation.firstKeptEntryId,
							summaryMs: timed.ms,
							waitedMs: Date.now() - started,
							attempts,
						}),
					};
				}
				attempts.push({
					provider: provider.id,
					timing: "on the spot",
					outcome: "failed",
					reason: timed.written.reason,
				});
			}
		}
		if (event.signal.aborted) return;
		const reason =
			attempts.at(-1)?.reason ?? "no compaction provider is registered";
		pi.appendEntry(SUMMARY_FALLBACK_ENTRY, { reason, attempts });
		if (ctx.hasUI) {
			ctx.ui.notify(`Compacting with pi's summariser: ${reason}.`, "info");
		}
	});

	const state = (): AheadState => {
		if (!ahead) return "none";
		if (!ahead.result) return "writing";
		return ahead.result.written.ok ? "ready" : "failed";
	};

	return {
		state,
		takeFailure() {
			if (!ahead?.result || ahead.result.written.ok) return undefined;
			const { reason } = ahead.result.written;
			ahead = null;
			return reason;
		},
		whenReady(listener) {
			readyListeners.push(listener);
		},
		summaryDollars(ctx, contextTokens) {
			for (const timing of ["ahead", "on the spot"] as const) {
				const priced = request(ctx, timing, reasonFor(timing), {
					focus: { contributed: [] },
					contextTokens,
					reserveTokens: ASSUMED_RESERVE_TOKENS,
				});
				if (!priced) return undefined;
				const first = candidates(priced, []).next();
				if (!first.done) return first.value.dollars;
			}
			return undefined;
		},
		prepare(ctx, contextTokens) {
			if (ahead && state() !== "failed") return { ok: true };
			// Its own request, since there is no compaction yet to key it
			// to: contributors hand in the focus now, and the appendix when
			// the compaction asks again.
			const contributions = newContributions({});
			pi.events.emit(SUMMARY_CONTRIBUTIONS, contributions);
			const writing = request(ctx, "ahead", "policy", {
				focus: { contributed: contributions.instructions },
				contextTokens,
				reserveTokens: ASSUMED_RESERVE_TOKENS,
			});
			if (!writing) {
				return { ok: false, reason: "the session has nothing to summarise" };
			}
			const attempts: CompactionAttempt[] = [];
			const first = candidates(writing, attempts).next();
			if (first.done) {
				return {
					ok: false,
					reason: attempts[0]?.reason ?? "no compaction provider is registered",
				};
			}
			const { provider } = first.value;
			const controller = new AbortController();
			const entry: Ahead = {
				provider,
				request: writing,
				controller,
				attempts,
				done: writeWithin(provider, writing, controller.signal).then(
					(timed) => {
						if (ahead !== entry || controller.signal.aborted) return timed;
						entry.result = timed;
						if (!timed.written.ok) {
							pi.appendEntry(AHEAD_UNUSED_ENTRY, {
								reason: timed.written.reason,
							});
						} else {
							for (const listener of readyListeners) tell(listener, ctx);
						}
						return timed;
					},
				),
			};
			ahead = entry;
			return { ok: true };
		},
	};
}

function reasonFor(timing: CompactionTiming): CompactionReason {
	return timing === "ahead" ? "policy" : "threshold";
}

/** A provider's assessment, with a throw taken as a decline. */
function assessed(provider: CompactionProvider, request: CompactionRequest) {
	try {
		return provider.assess(request);
	} catch (error) {
		return { ok: false as const, reason: describe(error) };
	}
}

/**
 * Ask a provider for its summary within the summary's clock. Resolves
 * with a failure rather than rejecting, whatever the provider does.
 */
async function writeWithin(
	provider: CompactionProvider,
	request: CompactionRequest,
	signal: AbortSignal,
): Promise<Timed> {
	const started = Date.now();
	const outOfTime = new AbortController();
	const clock = setTimeout(() => outOfTime.abort(), SUMMARY_WALL_MS);
	let written: CompactionWritten;
	try {
		written = await provider.write(
			request,
			AbortSignal.any([signal, outOfTime.signal]),
		);
	} catch (error) {
		written = { ok: false, reason: describe(error) };
	} finally {
		clearTimeout(clock);
	}
	if (!written.ok && outOfTime.signal.aborted) {
		written = {
			ok: false,
			reason: `the summary was not written within ${SUMMARY_WALL_MS / 60_000} minutes`,
		};
	}
	return { written, ms: Date.now() - started };
}

type Applicable =
	| {
			ok: true;
			written: Extract<CompactionWritten, { ok: true }>;
			firstKeptEntryId: string;
			ms: number;
	  }
	| { ok: false; reason: string; unused: boolean };

/** Whether a summary written ahead can become this compaction. */
async function applicable(
	taken: Ahead,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<Applicable> {
	if (event.customInstructions?.trim()) {
		taken.controller.abort();
		return {
			ok: false,
			reason: "the compaction asked for a focus it was written without",
			unused: true,
		};
	}
	const timed = taken.result ?? (await untilAborted(taken.done, event.signal));
	if (!timed.written.ok) {
		return { ok: false, reason: timed.written.reason, unused: false };
	}
	const boundary = keptBoundary(
		ctx.sessionManager.getBranch().map((entry) => entry.id),
		taken.request.coveredLeafId,
		event.preparation.firstKeptEntryId,
	);
	if (!boundary.ok) return { ok: false, reason: boundary.reason, unused: true };
	return {
		ok: true,
		written: timed.written,
		firstKeptEntryId: boundary.firstKeptEntryId,
		ms: timed.ms,
	};
}

/**
 * The compaction pi records: the summary, the file lists, and whatever
 * contributors appended, with who wrote it, how, how long anybody
 * waited, and every provider that did not.
 */
function checkpoint(
	event: SessionBeforeCompactEvent,
	contributions: SummaryContributions,
	how: {
		provider: CompactionProvider;
		request: CompactionRequest;
		written: Extract<CompactionWritten, { ok: true }>;
		firstKeptEntryId: string;
		summaryMs: number;
		waitedMs: number;
		attempts: readonly CompactionAttempt[];
	},
): CompactionResult {
	const { summary, readFiles, modifiedFiles } = withFileLists(
		how.written.text,
		event.preparation.fileOps,
	);
	const unfollowed =
		!how.provider.followsFocus && how.request.focus.contributed.length > 0;
	return {
		summary: `${summary}${contributions.appendix.join("")}`,
		firstKeptEntryId: how.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		...(how.written.usage ? { usage: how.written.usage } : {}),
		details: {
			readFiles,
			modifiedFiles,
			summariser: how.provider.id,
			written: how.request.timing,
			summaryMs: how.summaryMs,
			waitedMs: how.waitedMs,
			attempts: how.attempts,
			...(unfollowed ? { focusFollowed: false } : {}),
			...(how.written.details ? { provider: how.written.details } : {}),
		},
	};
}

/**
 * Tell one listener a summary is ready. What it does with the news is
 * its own business, so a listener that throws neither keeps the rest
 * from hearing it nor rejects the write, which nobody awaits.
 */
function tell(
	listener: (ctx: ExtensionContext) => void,
	ctx: ExtensionContext,
): void {
	try {
		listener(ctx);
	} catch {
		// Deliberately dropped: the summary is ready either way, and
		// there is nobody to hand a listener's failure to.
	}
}

/** The summary being written, or a failure once the compaction is cancelled. */
function untilAborted(
	done: Promise<Timed>,
	signal: AbortSignal,
): Promise<Timed> {
	const cancelled: Timed = {
		written: { ok: false, reason: "cancelled" },
		ms: 0,
	};
	if (signal.aborted) return Promise.resolve(cancelled);
	return new Promise((resolve) => {
		const onAbort = () => resolve(cancelled);
		signal.addEventListener("abort", onAbort, { once: true });
		done.then((result) => {
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		});
	});
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
