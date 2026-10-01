/**
 * What became of each compaction, said on the event bus as it happens.
 *
 * The compaction workflow already writes its record to the session: the
 * compaction entry's details, and a custom entry for a summary that fell
 * back to pi, one written ahead that went unused, or a compaction that
 * failed. A host that rebuilds sessions from its own log can drop custom
 * entries, and one that runs headless shows no notice to anybody, so the
 * same facts are emitted on {@link COMPACTION_OUTCOME} too. Forwarding
 * them to wherever such a host keeps telemetry is how it tells "the
 * harness compacted" apart from "pi's summariser did, and here is why".
 *
 * The payload is a public contract, so the channel is versioned.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { CompactionFailure } from "./failure.ts";
import type { CompactionAttempt } from "./provider.ts";

/** Emitted by the compaction workflow once per outcome. */
export const COMPACTION_OUTCOME = "compaction:outcome:v1";

/** One compaction's outcome. */
export type CompactionOutcome =
	| {
			/**
			 * pi applied a compaction. `details.summariser` names the
			 * provider that wrote it; it is absent when pi's own summariser
			 * did, after a `fallback` saying why.
			 */
			readonly kind: "compacted";
			readonly sessionId: string;
			readonly tokensBefore: number;
			readonly firstKeptEntryId: string;
			/** The compaction entry's details, as recorded. */
			readonly details: Readonly<Record<string, unknown>>;
	  }
	| {
			/** No provider wrote it, so pi's own summariser does. */
			readonly kind: "fallback";
			readonly sessionId: string;
			readonly reason: string;
			readonly attempts: readonly CompactionAttempt[];
	  }
	| {
			/** A summary written ahead could not be used. */
			readonly kind: "ahead-unused";
			readonly sessionId: string;
			readonly reason: string;
	  }
	| {
			/** The compaction itself failed, and the trigger backs off. */
			readonly kind: "failed";
			readonly sessionId: string;
			readonly failure: CompactionFailure;
	  };

/**
 * Say an outcome on the bus. A listener that throws must not cost the
 * compaction anything, so whatever it does is its own business.
 */
export function emitOutcome(
	bus: Pick<EventBus, "emit">,
	outcome: CompactionOutcome,
): void {
	try {
		bus.emit(COMPACTION_OUTCOME, outcome);
	} catch {
		// Deliberately dropped: the outcome is already recorded on the
		// session, and there is nobody to hand a listener's failure to.
	}
}

/** Whether a bus payload is a compaction outcome. */
export function isCompactionOutcome(data: unknown): data is CompactionOutcome {
	if (typeof data !== "object" || data === null) return false;
	const o = data as Record<string, unknown>;
	return (
		typeof o.sessionId === "string" &&
		(o.kind === "compacted" ||
			o.kind === "fallback" ||
			o.kind === "ahead-unused" ||
			o.kind === "failed")
	);
}
