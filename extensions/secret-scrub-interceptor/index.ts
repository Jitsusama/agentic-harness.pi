/**
 * Secret Scrub Interceptor Extension
 *
 * Puts every credential a tool's answer holds out of sight before the
 * model reads it or pi writes it to the session's log, leaving words that
 * say what kind it was (see `lib/internal/secrets/secrets.ts` for the shapes, and
 * for the session's own secret variables, put out of sight by value).
 *
 * An agent's tools print what they find, and some of what they find is a
 * credential: a token in a shell's history, a key in a file read, a
 * service's JSON answer. Once in a result it sat in the model's context,
 * went to the provider with every later turn, and stayed in the session's
 * log for good. On 7 November 84 of one machine's 625 session logs held a
 * token-shaped string, and a backup copied them off the machine hourly.
 * What is scrubbed here reaches neither.
 *
 * Silent, like every interceptor: the mark says enough for the agent to
 * know a secret was there and not to ask for it again. The text, the
 * details and the structured answer are each scrubbed, since pi logs all
 * three; a picture is handed on as it is. A result with nothing to hide
 * is handed on untouched. The file a long command's whole output was
 * saved to, by pi or by a host's pi-durable bash, is scrubbed too
 * (`lib/internal/secrets/saved-output.ts`), and so is each payload the
 * result store keeps, as it is written (`lib/core/result/spill.ts`).
 *
 * A command that prints the environment, env, printenv or launchctl print
 * among them, has every value in its answer that could be a credential
 * scrubbed, whatever its variable is called: on 12 November a launchctl
 * print over SSH put two of another machine's work tokens, whose names no
 * shape knew and whose values the session didn't hold, into an agent's
 * context and log.
 *
 * A host's tool round answers with the same scrub of the answer and its
 * saved file (`host/engine/tool-round.ts`), so a hosted conversation that
 * loads no extension is scrubbed the same way.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scrubSavedOutput } from "../../lib/internal/secrets/saved-output.ts";
import { scrubToolResult } from "../../lib/internal/secrets/secrets.ts";

/** Wires the scrub onto every tool's answer. */
export default function secretScrubInterceptor(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		// Before anything else, and whatever the answer holds: a credential
		// can sit in the part of the output the answer left out.
		scrubSavedOutput(event, event.input);
		return scrubToolResult(event, event.input);
	});
}
