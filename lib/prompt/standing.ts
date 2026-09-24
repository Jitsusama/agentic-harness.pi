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
 * reload renders the same bytes; a compaction, which summarises the
 * change messages away, sets what was said back to the frozen text so
 * a state that still differs from it is said again.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

/** One turn's contribution: the prompt, any message, the new ledger. */
export interface StandingContextTurn {
	readonly systemPrompt: string;
	readonly message?: { customType: string; content: string; display: boolean };
	readonly ledger: StandingContextLedger;
}

/**
 * The system prompt and any message for this turn, given what the
 * model has been told and the context as it stands.
 */
export function standingContextTurn(
	wording: StandingContextWording,
	ledger: StandingContextLedger,
	current: string | null,
	systemPrompt: string,
): StandingContextTurn {
	const frozen = ledger.frozen === undefined ? current : ledger.frozen;
	const delivered = ledger.delivered === undefined ? frozen : ledger.delivered;
	const prompt =
		frozen === null ? systemPrompt : systemPrompt + wording.inPrompt(frozen);
	const next = { frozen, delivered: current };
	if (current === delivered) return { systemPrompt: prompt, ledger: next };
	return {
		systemPrompt: prompt,
		ledger: next,
		message: {
			customType: wording.customType,
			content: wording.changed(current),
			display: false,
		},
	};
}

/** The ledger once a compaction has summarised earlier messages. */
export function standingContextAfterCompaction(
	ledger: StandingContextLedger,
): StandingContextLedger {
	if (ledger.frozen === undefined) return ledger;
	return { frozen: ledger.frozen, delivered: ledger.frozen };
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

	pi.on("before_agent_start", async (event) => {
		const turn = standingContextTurn(
			wording,
			ledger,
			current(),
			event.systemPrompt,
		);
		if (!sameLedger(turn.ledger, ledger)) pi.appendEntry(entry, turn.ledger);
		ledger = turn.ledger;
		return turn.message
			? { systemPrompt: turn.systemPrompt, message: turn.message }
			: { systemPrompt: turn.systemPrompt };
	});

	pi.on("session_compact", async () => {
		ledger = standingContextAfterCompaction(ledger);
		pi.appendEntry(entry, ledger);
	});
}

function sameLedger(a: StandingContextLedger, b: StandingContextLedger) {
	return a.frozen === b.frozen && a.delivered === b.delivered;
}
