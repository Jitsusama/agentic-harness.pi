/**
 * browser_go: be somewhere.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool opens a session, moves it to a URL and closes
 * it again. Navigating with no session open starts one, so the
 * common path costs a single call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";
import { pageView } from "./see.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[Type.Literal("open"), Type.Literal("navigate"), Type.Literal("close")],
			{
				description:
					"open: start a session (optionally at a url). " +
					"navigate: go to a url, opening a session when none is live. " +
					"close: dispose the session. " +
					"Defaults to navigate with a url, open without one.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	url: Type.Optional(Type.String({ description: "URL for open or navigate." })),
});

/** Register the navigation half of the browser family. */
export function registerGo(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_go",
		label: "Browser Go",
		description:
			"Put a browser session somewhere. kind 'navigate' goes to a url and " +
			"opens a session if none is live; kind 'open' starts a session, with " +
			"a url if you have one; kind 'close' disposes it. Passing just a url " +
			"navigates. Navigating returns the page's accessibility outline, so " +
			"you see where you landed.",
		promptSnippet:
			"Move a browser session with browser_go (navigate, open, close).",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			// A url is an intent to go there; without one there is
			// nowhere to go, so the only thing left is to open.
			const kind = params.kind ?? (params.url ? "navigate" : "open");

			if (kind === "close") {
				const closed = await registry.close(name);
				return answer(
					name,
					kind,
					closed ? `Closed session '${name}'.` : `No session '${name}'.`,
				);
			}

			if (kind === "navigate" && !params.url) {
				return refusal(name, kind, "navigate needs a url.");
			}

			const session = await registry.acquire(name);
			if (!params.url) {
				return answer(name, kind, `Opened session '${name}'.`);
			}
			await session.navigate(params.url);
			return answer(name, kind, await pageView(session));
		},
	});
}
