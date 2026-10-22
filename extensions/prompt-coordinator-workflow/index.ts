/**
 * Prompt Coordinator extension.
 *
 * Owns the single before_agent_start hook that appends the
 * resident system-prompt block. Contributors (conventions,
 * recalled memory, captured rules) register into lib/prompt;
 * this extension assembles them in order, freezes the result
 * once per session, and returns byte-identical bytes every
 * turn so the resident prompt never churns.
 *
 * The freeze is written to the session log (`FROZEN_ENTRY`) and
 * read back on every session start, so a `/reload` or a resumed
 * session renders the same bytes. Assembled again, it would take
 * in every fact retained and rule captured since, the system
 * prompt would differ, and the next turn would write the whole
 * context to the cache again. What was learned since is already
 * in the conversation.
 *
 * Extensions that used to append to the system prompt
 * themselves migrate onto this coordinator as contributors,
 * so there is one assembly point rather than several racing
 * appends.
 *
 * The block is a prompt section of its own rather than a whole
 * system prompt returned from the hook. pi treats a returned prompt
 * as forced, and a forced prompt opens every request with that text
 * and the tools as they are now, so a tool added, removed or
 * reworded, or any section changing, rewrote the whole cache: on 22
 * October, 40 times across sessions following a deploy, about $78. A
 * section lets pi send a change after the conversation and tools
 * inline, so the cache holds.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLastEntry } from "../../lib/internal/state.ts";
import {
	createFrozenResidentPrompt,
	type FrozenResidentPrompt,
} from "../../lib/prompt/index.ts";

/** Custom entry holding the session's frozen resident block. */
const FROZEN_ENTRY = "prompt-coordinator-frozen";

/** The prompt section the block is rendered into. */
export const RESIDENT_SECTION = "resident";

interface FrozenRecord {
	readonly block: string;
}

function isFrozenRecord(data: unknown): data is FrozenRecord {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as { block?: unknown }).block === "string"
	);
}

export default function promptCoordinator(pi: ExtensionAPI) {
	let frozen: FrozenResidentPrompt = createFrozenResidentPrompt();
	let recorded = false;

	// A new session gets a fresh freeze, and a reloaded or resumed one
	// the freeze it already has.
	pi.on("session_start", async (_event, ctx) => {
		const record = getLastEntry<unknown>(ctx, FROZEN_ENTRY);
		const kept = isFrozenRecord(record) ? record.block : undefined;
		recorded = kept !== undefined;
		frozen = createFrozenResidentPrompt(kept);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const block = await frozen.assemble(ctx);
		if (!recorded) {
			pi.appendEntry(FROZEN_ENTRY, { block } satisfies FrozenRecord);
			recorded = true;
		}
		if (block) event.systemPromptOptions.sections[RESIDENT_SECTION] = block;
		return undefined;
	});
}
