/**
 * browser_see: read the truth about a page, changing nothing.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool answers "page": the accessibility outline of
 * what is on screen, which is also the view every do call
 * returns once it has changed something.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrowserSession } from "../../lib/web/session.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";

/**
 * The page as the caller should read it: where they are, then
 * the accessibility outline of what is there.
 */
export async function pageView(session: BrowserSession): Promise<string> {
	const observed = await session.observe();
	return `${observed.title}\n${observed.url}\n\n${observed.outline}`;
}

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Literal("page", {
			description:
				"page: the accessibility outline of what is on screen. " +
				"The default, and the only kind so far.",
		}),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
});

/** Register the reading half of the browser family. */
export function registerSee(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_see",
		label: "Browser See",
		description:
			"Read the current state of a browser session without changing it. " +
			"kind 'page' (the default) returns the page's accessibility outline: " +
			"the roles and names of everything on screen, which is how you name " +
			"elements when you act on them.",
		promptSnippet:
			"Read a browser page with browser_see; act on it with browser_do.",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			const kind = params.kind ?? "page";
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					`No session '${name}'. Open one with browser_go, or navigate ` +
						`and it opens itself.`,
				);
			}
			const session = await registry.acquire(name);
			return answer(name, kind, await pageView(session));
		},
	});
}
