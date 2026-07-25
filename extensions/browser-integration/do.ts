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
	kind: Type.Optional(
		Type.Literal("act", {
			description:
				"act: operate an element named by role and accessible name. " +
				"The default, and the only kind so far.",
		}),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	action: Type.Union(
		[
			Type.Literal("click"),
			Type.Literal("type"),
			Type.Literal("hover"),
			Type.Literal("focus"),
			Type.Literal("clear"),
			Type.Literal("select"),
			Type.Literal("scrollTo"),
		],
		{
			description:
				"click or type into the element; hover or focus it to " +
				"reveal state-dependent behaviour; clear empties a field; " +
				"select chooses an option by its text; scrollTo brings it " +
				"into view.",
		},
	),
	role: Type.String({ description: "The target element's role." }),
	name: Type.String({ description: "The target's accessible name." }),
	text: Type.Optional(
		Type.String({
			description:
				"For action 'type': the text to enter. For 'select': the " +
				"option to choose.",
		}),
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
			const kind = params.kind ?? "act";
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					`No session '${name}'. Navigate somewhere with browser_go first.`,
				);
			}

			const action = buildAction(params);
			if (!action) {
				const needs =
					params.action === "select"
						? "the option to choose in"
						: "the text to enter into";
				return refusal(
					name,
					kind,
					`action '${params.action}' needs ${needs} role ` +
						`${params.role} name "${params.name}".`,
				);
			}

			const session = await registry.acquire(name);
			const result = await session.act(action);
			if (!result.ok) {
				if ("blocked" in result) {
					return refusal(
						name,
						kind,
						`Waited ${result.blocked.waitedMs}ms but role ${params.role} ` +
							`name "${params.name}" never became ready: ` +
							`${result.blocked.blocker}.`,
					);
				}
				return refusal(
					name,
					kind,
					describeRefusal(action.target, result.refusal),
				);
			}
			const view = await pageView(session);
			// Say when the page kept the caller waiting, so a slow
			// interaction is visible rather than merely felt.
			return answer(
				name,
				kind,
				result.waitedMs
					? `Waited ${result.waitedMs}ms for it to be ready.\n\n${view}`
					: view,
			);
		},
	});
}

/** Turn the tool's flat parameters into a page action. */
function buildAction(params: {
	action:
		| "click"
		| "type"
		| "hover"
		| "focus"
		| "clear"
		| "select"
		| "scrollTo";
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
	// Typing and selecting are the only actions that carry a
	// value, and neither means anything without one.
	if (params.action === "type" || params.action === "select") {
		if (params.text === undefined) return null;
		return { kind: params.action, target, text: params.text };
	}
	return { kind: params.action, target };
}
