/**
 * Done Chime Widget Extension
 *
 * Rings when a run the person typed is done, so they hear it from across
 * the room: a loud, low ding, then a voice on the machine saying which
 * session is ready. Joel, 16 October: "give me that loud ding and spoken
 * voice shit when you are done thinking and have something to propose",
 * and on the 18th, lower, for his dog.
 *
 * Only the run the person typed into rings (`when.ts`), and only once it
 * has outlasted their glance, since dozens of sessions on the machine
 * run on messages, steers and resumes nobody is waiting for. A session
 * nobody can be at never rings: a subagent, print or JSON mode. Neither
 * does one whose person stopped it, or said they are away.
 *
 * The ring (`ring.ts`) plays the machine's ding and speaks with its local
 * voice, as `sound.json` describes them (`sound.ts`): pw-play and piper,
 * lowered by sox, on Linux; afplay and say on macOS. A missing tool is
 * silence, and `PI_NOTIFY=off` silences it whole.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAway } from "../../lib/internal/away/state.ts";
import { doneLine, ring, spokenName } from "./ring.ts";
import { heardAt, rings } from "./when.ts";

export default function doneChimeWidget(pi: ExtensionAPI) {
	// When the person last typed into the run under way, while it is theirs.
	let heard: number | undefined;

	pi.on("input", async (event) => {
		heard = heardAt(heard, { kind: "input", ...event }, Date.now());
	});

	// A custom message that wakes an idle session starts a run nobody typed.
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "custom") return;
		heard = heardAt(heard, { kind: "message" }, Date.now());
	});

	pi.on("agent_settled", async (event, ctx) => {
		const run = {
			attended: ctx.hasUI,
			...(heard !== undefined ? { heardAt: heard } : {}),
			at: Date.now(),
			aborted: event.aborted,
			away: isAway(),
		};
		heard = undefined;
		if (!rings(run)) return;
		// Never waited on, so a slow speaker holds nothing up.
		void ring(doneLine(spokenName(pi.getSessionName(), ctx.cwd)));
	});
}
