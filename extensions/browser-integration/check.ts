/**
 * browser_check: verdicts rather than readings.
 *
 * The other three tools answer questions. This one forms a
 * judgment: it walks, audits or compares, and says whether what
 * it found is acceptable. Kinds grow with the phases of the
 * browser evolution plan; keyboard is the first, because a page
 * nobody can tab through is broken in a way no screenshot shows.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { analyseWalk, renderWalk } from "../../lib/web/a11y/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Literal("keyboard", {
			description:
				"keyboard: tab through the page and report what a person " +
				"using only a keyboard can reach. The default, and the only " +
				"kind so far.",
		}),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	maxStops: Type.Optional(
		Type.Number({
			description:
				"How many times to press Tab. Defaults to twice the number of " +
				"focusable things, which is enough to show a cycle.",
		}),
	),
});

/** Register the judging member of the browser family. */
export function registerCheck(
	pi: ExtensionAPI,
	registry: SessionRegistry,
): void {
	pi.registerTool({
		name: "browser_check",
		label: "Browser Check",
		description:
			"Form a verdict about a browser page. kind 'keyboard' tabs through " +
			"the page and reports focus traps, controls that cannot be reached, " +
			"focus that cannot be seen and a tab order that does not follow the " +
			"page. It moves focus to do this and puts it back afterwards.",
		promptSnippet:
			"Judge a browser page with browser_check: kind 'keyboard' walks the " +
			"tab order and reports what a keyboard user cannot reach.",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			const kind = params.kind ?? "keyboard";
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					`No session '${name}'. Navigate somewhere with browser_go first.`,
				);
			}

			const session = await registry.acquire(name);
			const capture = await session.keyboardWalk(params.maxStops);
			if (capture.candidates.length === 0) {
				return answer(
					name,
					kind,
					"Nothing on this page can hold focus. A page with no " +
						"focusable controls cannot be used with a keyboard at all, " +
						"which is either the point or the bug.",
				);
			}

			return answer(name, kind, renderWalk(analyseWalk(capture)));
		},
	});
}
