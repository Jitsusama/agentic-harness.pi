/**
 * Secret Scrub Interceptor Extension
 *
 * Puts every credential a tool's answer holds out of sight before the
 * model reads it or pi writes it to the session's log, leaving words that
 * say what kind it was (see `lib/internal/secrets.ts` for the shapes).
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
 * (`output-file.ts`), and so is each payload the
 * result store keeps, as it is written (`lib/core/result/spill.ts`).
 */

import type {
	ExtensionAPI,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { scrubDeep, scrubSecrets } from "../../lib/internal/secrets.ts";
import { savedOutputFile, scrubOutputFile } from "./output-file.ts";

type Content = ToolResultEvent["content"];

/** The answer's parts with each text scrubbed, and whether any changed. */
function scrubContent(content: Content): {
	content: Content;
	changed: boolean;
} {
	let changed = false;
	const scrubbed = content.map((part) => {
		if (part.type !== "text") return part;
		const { text, kinds } = scrubSecrets(part.text);
		if (kinds.length === 0) return part;
		changed = true;
		return { ...part, text };
	});
	return { content: scrubbed, changed };
}

/** Wires the scrub onto every tool's answer. */
export default function secretScrubInterceptor(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		// Before anything else, and whatever the answer holds: a credential
		// can sit in the part of the output the answer left out.
		// pi names it in the details, pi-durable in the structured answer.
		const saved = new Set(
			[event.details, event.structuredContent].map((naming) =>
				savedOutputFile(naming),
			),
		);
		for (const file of saved) if (file) scrubOutputFile(file);
		const content = scrubContent(event.content);
		const details = scrubDeep(event.details);
		const structured = scrubDeep(event.structuredContent);
		if (
			!content.changed &&
			details.kinds.length === 0 &&
			structured.kinds.length === 0
		) {
			return undefined;
		}
		return {
			content: content.content,
			details: details.value,
			structuredContent: structured.value,
		};
	});
}
