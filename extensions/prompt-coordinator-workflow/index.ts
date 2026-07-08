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
 * Extensions that used to append to the system prompt
 * themselves migrate onto this coordinator as contributors,
 * so there is one assembly point rather than several racing
 * appends.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createFrozenResidentPrompt,
	type FrozenResidentPrompt,
} from "../../lib/prompt/index.js";

export default function promptCoordinator(pi: ExtensionAPI) {
	let frozen: FrozenResidentPrompt = createFrozenResidentPrompt();

	// A new session gets a fresh freeze, so a resumed or switched
	// session reassembles rather than carrying the old bytes.
	pi.on("session_start", async () => {
		frozen = createFrozenResidentPrompt();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const block = await frozen.assemble(ctx);
		if (!block) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});
}
