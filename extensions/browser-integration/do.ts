/**
 * browser_do: change the page.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool acts semantically: click or type against an
 * element named the way it reads in the outline. Every call
 * answers with a fresh page view, so the caller always sees
 * the result of what it just did.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TargetedAction } from "../../lib/web/session.js";
import { describeRefusal, type Target } from "../../lib/web/target/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";
import { pageView } from "./see.js";

const parameters = Type.Object({
	kind: Type.Literal("act", {
		description:
			"act: operate an element named by role and accessible name. " +
			"The only kind so far.",
	}),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	action: Type.Union([Type.Literal("click"), Type.Literal("type")], {
		description: "Click the element, or type into it.",
	}),
	role: Type.String({ description: "The target element's role." }),
	name: Type.String({ description: "The target's accessible name." }),
	text: Type.Optional(
		Type.String({ description: "For action 'type': the text to enter." }),
	),
	container: Type.Optional(
		Type.String({
			description: "Restrict the search to a container with this name.",
		}),
	),
	ordinal: Type.Optional(
		Type.Number({
			description: "1-based position among same-named matches.",
		}),
	),
});

/** Register the acting half of the browser family. */
export function registerDo(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_do",
		label: "Browser Do",
		description:
			"Act on a browser page. kind 'act' clicks an element or types into " +
			"it, targeting the element the way it reads in the outline: by role " +
			"and accessible name, narrowed by container or by the 1-based " +
			"ordinal among same-named matches. The page view that follows shows " +
			"what the action did.",
		promptSnippet:
			"Act on a browser page with browser_do: target elements by role and " +
			"accessible name.",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			if (!registry.has(name)) {
				return refusal(
					name,
					params.kind,
					`No session '${name}'. Navigate somewhere with browser_go first.`,
				);
			}

			const action = buildAction(params);
			if (!action) {
				return refusal(
					name,
					params.kind,
					"action 'type' needs the text to enter.",
				);
			}

			const session = await registry.acquire(name);
			const result = await session.act(action);
			if (!result.ok) {
				return refusal(
					name,
					params.kind,
					describeRefusal(action.target, result.refusal),
				);
			}
			return answer(name, params.kind, await pageView(session));
		},
	});
}

/** Turn the tool's flat parameters into a page action. */
function buildAction(params: {
	action: "click" | "type";
	role: string;
	name: string;
	text?: string;
	container?: string;
	ordinal?: number;
}): TargetedAction | null {
	const target: Target = {
		role: params.role,
		name: params.name,
		...(params.ordinal ? { ordinal: params.ordinal } : {}),
		...(params.container ? { container: { name: params.container } } : {}),
	};
	if (params.action === "type") {
		if (params.text === undefined) return null;
		return { kind: "type", target, text: params.text };
	}
	return { kind: "click", target };
}
