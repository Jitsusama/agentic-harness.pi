/**
 * Standing context: state the model should know, kept out of the cache's way.
 *
 * Some extensions tell the model where things stand on every prompt:
 * which quest is loaded, which mastery layer is current. Re-rendering
 * that into the system prompt each time looks harmless, but the
 * system prompt sits ahead of the whole conversation in the
 * provider's prefix cache, so the first prompt after the state
 * changes re-writes every token of history at the cache-write price.
 * Over a month the quest line alone did that 169 times, about $450
 * at Opus 5.5 list.
 *
 * A standing context freezes its text into the system prompt the
 * first time a session renders it, and says a later change once, as
 * a hidden message appended to the conversation, which is new content
 * the cache never held. The caller words both. The ledger of what was
 * frozen and what was last said is persisted as a session entry, so a
 * reload renders the same bytes.
 *
 * A compaction can take the last change message away. When it does,
 * the state is said again on the next prompt. When the message
 * survives in the tail the compaction kept, or the summary carries it
 * because this module contributed it, nothing is said: repeating it
 * after every compaction once accounted for 1,206 of 1,406 quest
 * messages over two months, all identical to the one before.
 *
 * The frozen text is a prompt section of its own, not text returned as
 * the whole system prompt. pi treats a returned prompt as forced: every
 * request then opens with that text and the tools as they are now, so
 * any change to a tool or a section rewrites the whole cache. Measured
 * on 22 October, a tool removed mid-run made the next request read 0
 * of 76,202 cached tokens. As a section, a change is sent as an
 * addition after the conversation, and tools change inline.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	isSummaryContributions,
	recordContribution,
	SUMMARY_CONTRIBUTIONS,
} from "../compaction/contributions.ts";
import { getLastEntry } from "../internal/state.ts";

/**
 * What the model has been told. `frozen` is the text in the system
 * prompt (null: there was none when it froze; absent: not frozen yet);
 * `delivered` is the state the model last heard.
 */
export interface StandingContextLedger {
	frozen?: string | null;
	delivered?: string | null;
}

/** How one extension's standing context reads. */
export interface StandingContextWording {
	/**
	 * The customType of a change message. The ledger is persisted under
	 * this name with `-ledger` appended.
	 */
	readonly customType: string;
	/** What is appended to the system prompt for the frozen text. */
	inPrompt(text: string): string;
	/** What a change message says, given the state now (null: none). */
	changed(text: string | null): string;
}

/** One turn's contribution: the section, any message, the new ledger. */
export interface StandingContextTurn {
	/** The section's text, or nothing when there was no state at the freeze. */
	readonly section?: string;
	readonly message?: { customType: string; content: string; display: boolean };
	readonly ledger: StandingContextLedger;
}

/**
 * The section and any message for this turn, given what the model has
 * been told and the context as it stands.
 */
export function standingContextTurn(
	wording: StandingContextWording,
	ledger: StandingContextLedger,
	current: string | null,
): StandingContextTurn {
	const frozen = ledger.frozen === undefined ? current : ledger.frozen;
	const delivered = ledger.delivered === undefined ? frozen : ledger.delivered;
	const section = frozen === null ? undefined : wording.inPrompt(frozen).trim();
	const next = { frozen, delivered: current };
	const said = section === undefined ? {} : { section };
	if (current === delivered) return { ...said, ledger: next };
	return {
		...said,
		ledger: next,
		message: {
			customType: wording.customType,
			content: wording.changed(current),
			display: false,
		},
	};
}

/**
 * The ledger once a compaction has summarised earlier messages. When
 * the model can still see what it was last told (`stillHeard`), the
 * ledger stands; otherwise what was said goes back to the frozen text,
 * so a state that still differs from it is said again.
 */
export function standingContextAfterCompaction(
	ledger: StandingContextLedger,
	stillHeard = false,
): StandingContextLedger {
	if (ledger.frozen === undefined || stillHeard) return ledger;
	return { frozen: ledger.frozen, delivered: ledger.frozen };
}

/** What this module records on a compaction it contributed to. */
interface SaidInSummary {
	said: string | null;
}

/** An entry on the session's branch, as far as this module reads one. */
interface BranchEntry {
	id?: string;
	type?: string;
	customType?: string;
}

/**
 * Whether the model still hears the last change after a compaction:
 * its message is in the kept tail, or the summary says it.
 */
function stillHeard(
	customType: string,
	delivered: string | null | undefined,
	branch: readonly BranchEntry[],
	compaction: { firstKeptEntryId?: string; details?: unknown },
): boolean {
	const said = (
		compaction.details as
			| { contributions?: Record<string, SaidInSummary | undefined> }
			| undefined
	)?.contributions?.[customType];
	if (said && said.said === delivered) return true;
	const kept = branch.findIndex((e) => e.id === compaction.firstKeptEntryId);
	if (kept === -1) return false;
	let last = -1;
	for (const [i, e] of branch.entries()) {
		if (e.type === "custom_message" && e.customType === customType) last = i;
	}
	return last >= kept;
}

/**
 * Wire a standing context into a session: restore its ledger on start,
 * contribute to every prompt, and reset what was said at compaction.
 */
export function registerStandingContext(
	pi: ExtensionAPI,
	wording: StandingContextWording,
	current: () => string | null,
): void {
	const entry = `${wording.customType}-ledger`;
	let ledger: StandingContextLedger = {};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		ledger = getLastEntry<StandingContextLedger>(ctx, entry) ?? {};
	});

	const section = sectionName(wording.customType);
	pi.on("before_agent_start", async (event) => {
		const turn = standingContextTurn(wording, ledger, current());
		if (!sameLedger(turn.ledger, ledger)) pi.appendEntry(entry, turn.ledger);
		ledger = turn.ledger;
		if (turn.section !== undefined) {
			event.systemPromptOptions.sections[section] = turn.section;
		}
		return turn.message ? { message: turn.message } : undefined;
	});

	// Offer the state to a summary the harness writes, so a compaction
	// that drops the message does not drop what it said. Only a state
	// that differs from the frozen text needs it: the frozen text is in
	// the system prompt, which no compaction touches.
	pi.events.on(SUMMARY_CONTRIBUTIONS, (data: unknown) => {
		if (!isSummaryContributions(data)) return;
		if (ledger.frozen === undefined) return;
		if (ledger.delivered === undefined || ledger.delivered === ledger.frozen) {
			return;
		}
		data.appendix.push(`\n\n${wording.changed(ledger.delivered)}`);
		recordContribution(data, wording.customType, { said: ledger.delivered });
	});

	pi.on("session_compact", async (event, ctx: ExtensionContext) => {
		const heard = stillHeard(
			wording.customType,
			ledger.delivered,
			ctx.sessionManager.getBranch() as readonly BranchEntry[],
			event.compactionEntry,
		);
		const next = standingContextAfterCompaction(ledger, heard);
		if (sameLedger(next, ledger)) return;
		ledger = next;
		pi.appendEntry(entry, ledger);
	});
}

/**
 * The prompt section a standing context is frozen into, named after its
 * message type in the lowercase letters, digits, `_` and `-` pi allows.
 */
export function sectionName(customType: string): string {
	const name = customType.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
	return /^[a-z]/.test(name) ? name : `standing_${name}`;
}

function sameLedger(a: StandingContextLedger, b: StandingContextLedger) {
	return a.frozen === b.frozen && a.delivered === b.delivered;
}
