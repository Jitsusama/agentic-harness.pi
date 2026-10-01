/**
 * The contract between the compaction host and whatever writes its
 * summaries.
 *
 * The compaction workflow is the only handler of pi's
 * `session_before_compact`. It owns when to compact, writing ahead,
 * where the verbatim tail starts, the clock, what other extensions
 * contribute and what gets recorded. What it does not own is the
 * summary itself: that comes from a chain of providers, each asked in
 * turn whether it can write this one (`assess`) and then asked to
 * (`write`). A provider that declines or fails passes the compaction
 * to the next, and every decline and failure is recorded on the
 * compaction entry, so how often each happens is measurable.
 *
 * A provider registers over the event bus rather than by importing
 * the host, so it can live in another extension or another package.
 * The names are versioned because the payload is a public contract; a
 * breaking change ships as `:v2` beside the old one. Either load order
 * works: a provider emits {@link COMPACTION_REGISTER_PROVIDER} when it
 * activates, in case the host is already up, and again whenever the
 * host announces {@link COMPACTION_READY}, in case it was not.
 * Registration is keyed by id, so registering again replaces.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type {
	EventBus,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** pi's preparation of a compaction, as it hands one to an extension. */
export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

/** Emitted by the host once it accepts providers. */
export const COMPACTION_READY = "compaction:ready:v1";

/** Emitted by a provider to register itself with the host. */
export const COMPACTION_REGISTER_PROVIDER = "compaction:register-provider:v1";

/**
 * Emitted by an extension asking the host to announce itself, for when
 * it loaded second and missed {@link COMPACTION_READY}.
 */
export const COMPACTION_REQUEST = "compaction:request:v1";

/**
 * When the summary is written: in the background once the trigger
 * fires, or while the compaction waits for it.
 */
export type CompactionTiming = "ahead" | "on the spot";

/**
 * Why the summary is wanted: `policy` for one written ahead because
 * compacting pays, otherwise what pi said triggered the compaction.
 */
export type CompactionReason = "policy" | SessionBeforeCompactEvent["reason"];

/** What the summary should dwell on, and who asked for it. */
export interface CompactionFocus {
	/** Typed by whoever asked for this compaction, as in `/compact <focus>`. */
	readonly requested?: string;
	/** Handed in by other extensions as summary contributions. */
	readonly contributed: readonly string[];
}

/** One summary the host wants written. */
export interface CompactionRequest {
	readonly timing: CompactionTiming;
	readonly reason: CompactionReason;
	readonly ctx: ExtensionContext;
	/** The session branch as it stands. */
	readonly branch: readonly SessionEntry[];
	/** The last entry the summary covers; what follows stays verbatim. */
	readonly coveredLeafId: string;
	/** pi's own preparation, present only on the spot. */
	readonly preparation?: CompactionPreparation;
	/** Whether the conversation opens with an earlier compaction's summary. */
	readonly hasPreviousSummary: boolean;
	readonly focus: CompactionFocus;
	/** Tokens in the context as it stands. */
	readonly contextTokens: number;
	/** Output the host expects a summary to take, thinking included. */
	readonly expectedOutputTokens: number;
	/** The most the summary may take; a provider may cap it further. */
	readonly maxSummaryTokens: number;
	/**
	 * pi's estimate (`estimateTokens`) of what the summary replaces: the
	 * context's messages, an earlier summary included, less the tail
	 * kept verbatim. A provider sizes its summary from it; absent, the
	 * host could not say.
	 */
	readonly replacedTokens?: number;
}

/** Whether a provider can write a summary, and what it would cost. */
export type CompactionAssessment =
	| { readonly ok: true; readonly dollars: number }
	| { readonly ok: false; readonly reason: string };

/** A written summary, or why there is none. */
export type CompactionWritten =
	| {
			readonly ok: true;
			/** The summary. The host appends file lists and contributions. */
			readonly text: string;
			/** What writing it cost, recorded where the cost ledger reads it. */
			readonly usage?: Usage;
			/** Anything the provider wants kept, under `details.provider`. */
			readonly details?: Record<string, unknown>;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/**
			 * Whether the same call could succeed if made again: a dropped
			 * stream, an overloaded or rate-limited provider. The host asks
			 * once more before passing the compaction on.
			 */
			readonly retryable?: boolean;
	  };

/** One provider that did not write the summary, and why. */
export interface CompactionAttempt {
	readonly provider: string;
	readonly timing: CompactionTiming;
	/**
	 * `retried` is a failure the host asked again after, so the next
	 * attempt from the same provider is its second try.
	 */
	readonly outcome: "declined" | "failed" | "retried";
	readonly reason: string;
}

/** Something that writes compaction summaries. */
export interface CompactionProvider {
	/** Recorded as `details.summariser` and named in `PI_COMPACTION_PROVIDERS`. */
	readonly id: string;
	/** Lower is asked first when the chain is not configured. */
	readonly precedence: number;
	/**
	 * Whether it writes to a focus. One that cannot is skipped when
	 * somebody types a focus, and recorded as not following a
	 * contributed one when it writes anyway.
	 */
	readonly followsFocus: boolean;
	/**
	 * Whether it can write this summary, from what is already known:
	 * synchronous and free, since the host asks every turn to price a
	 * compaction.
	 */
	assess(request: CompactionRequest): CompactionAssessment;
	/**
	 * Write the summary. Resolves with a failure rather than rejecting,
	 * since a summary written ahead is awaited by nobody until a
	 * compaction comes. Stops when the signal aborts.
	 */
	write(
		request: CompactionRequest,
		signal: AbortSignal,
	): Promise<CompactionWritten>;
}

/** What the host hands out over {@link COMPACTION_READY}. */
export interface CompactionHostApi {
	/** Register a provider, replacing one with the same id. */
	registerProvider(provider: CompactionProvider): void;
	/** Ids of every registered provider, in the order the chain asks them. */
	listProviders(): readonly string[];
}

/** Whether a bus payload is a compaction provider. */
export function isCompactionProvider(
	data: unknown,
): data is CompactionProvider {
	if (typeof data !== "object" || data === null) return false;
	const p = data as Record<string, unknown>;
	return (
		typeof p.id === "string" &&
		p.id.length > 0 &&
		typeof p.precedence === "number" &&
		typeof p.followsFocus === "boolean" &&
		typeof p.assess === "function" &&
		typeof p.write === "function"
	);
}

/**
 * Register a provider with the host now, and again whenever the host
 * announces itself. Returns what stops the re-registering.
 */
export function registerCompactionProvider(
	bus: Pick<EventBus, "emit" | "on">,
	provider: CompactionProvider,
): () => void {
	const stop = bus.on(COMPACTION_READY, () =>
		bus.emit(COMPACTION_REGISTER_PROVIDER, provider),
	);
	bus.emit(COMPACTION_REGISTER_PROVIDER, provider);
	return stop;
}

/**
 * The focus as one instruction: the typed focus and every contributed
 * one, each said once, or nothing when there is none.
 */
export function combinedFocus(focus: CompactionFocus): string | undefined {
	// A contributor that also asked for this compaction by hand can hand
	// in the same focus both ways; it is said once.
	const parts = new Set(
		[focus.requested, ...focus.contributed].filter(
			(p): p is string => !!p?.trim(),
		),
	);
	return parts.size > 0 ? [...parts].join("\n\n") : undefined;
}
