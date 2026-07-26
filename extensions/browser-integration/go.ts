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
import {
	type BrowserSession,
	CookieSetupNeeded,
} from "../../lib/web/session.js";
import { renderDialogs } from "../../lib/web/telemetry/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";
import { pageView } from "./see.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("open"),
				Type.Literal("navigate"),
				Type.Literal("close"),
				Type.Literal("dialogs"),
			],
			{
				description:
					"open: start a session (optionally at a url). " +
					"navigate: go to a url, opening a session when none is live. " +
					"close: dispose the session. " +
					"dialogs: decide how alerts and confirms get answered, and " +
					"read back the ones already seen. " +
					"Defaults to navigate with a url, open without one.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	url: Type.Optional(Type.String({ description: "URL for open or navigate." })),
	accept: Type.Optional(
		Type.Boolean({
			description:
				"For dialogs: accept them from now on, rather than " +
				"dismissing. A dialog stops the page until it is answered, " +
				"so one of the two always happens; the default is to " +
				"dismiss, which changes least.",
		}),
	),
	promptText: Type.Optional(
		Type.String({
			description: "For dialogs: what to type into an accepted prompt.",
		}),
	),
	cookies: Type.Optional(
		Type.Boolean({
			description:
				"Carry your own Chrome cookies into this session, for sites " +
				"you are already signed in to. Applies when the session is " +
				"first opened. Defaults to false: a session is a clean user.",
		}),
	),
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
			"you see where you landed. Each session gets its own cookies and " +
			"storage, so two named sessions are two independent users. " +
			"A javascript dialog stops the page until it is answered, so " +
			"sessions dismiss them by default; kind 'dialogs' changes that " +
			"and reports the ones already raised.",
		promptSnippet:
			"Move a browser session with browser_go (navigate, open, " +
			"close, dialogs).",
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

			let session: BrowserSession;
			try {
				session = await registry.acquire(name, {
					...(params.cookies === undefined ? {} : { cookies: params.cookies }),
				});
			} catch (err) {
				// Asking for cookies that are not set up is a fixable
				// mistake, so say how to fix it rather than throwing.
				if (err instanceof CookieSetupNeeded) {
					return refusal(name, kind, err.message);
				}
				throw err;
			}

			if (kind === "dialogs") {
				if (params.accept !== undefined || params.promptText !== undefined) {
					session.setDialogPolicy({
						accept: params.accept ?? false,
						...(params.promptText === undefined
							? {}
							: { promptText: params.promptText }),
					});
				}
				const { policy, seen } = session.dialogs;
				const stance = policy.accept
					? `Dialogs are accepted${
							policy.promptText === undefined
								? ""
								: `, and prompts answered "${policy.promptText}"`
						}.`
					: "Dialogs are dismissed.";
				return answer(name, kind, `${stance}\n\n${renderDialogs(seen)}`);
			}

			if (!params.url) {
				return answer(name, kind, `Opened session '${name}'.`);
			}
			await session.navigate(params.url);
			return answer(name, kind, await pageView(session));
		},
	});
}
