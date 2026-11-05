/**
 * A reviewer marks where the brief it shares with the round ends.
 *
 * Loaded into each reviewer of a round with `--extension`, never
 * auto-discovered, which is why it lives outside `extensions/`: in the
 * session that dispatched the round, the first message is a person's
 * and there is no brief in it to mark.
 *
 * Registers no tool and changes nothing the model reads. It moves where
 * the request asks Anthropic to cache, so the first reviewer to reach
 * the model writes the brief under a key the rest of the round reads.
 * The reasoning, and every case where it leaves a request alone, is in
 * `withBriefBreakpoint`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// From the module directly, not the library barrel: this runs in every
// reviewer, on every request, and needs nothing else.
import { withBriefBreakpoint } from "../../lib/subagent/brief-breakpoint.ts";

export default function sharedBrief(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) =>
		withBriefBreakpoint(event.payload),
	);
}
