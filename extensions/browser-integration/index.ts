/**
 * Browser Integration extension.
 *
 * A structured-action browser tool over named, persistent
 * sessions: open, navigate, observe, act, close. observe
 * returns the page's accessibility outline (roles and names);
 * act targets an element the way the model named it and a
 * fresh observe follows, so the agent always sees the result
 * of what it did. Sessions dispose on idle and at shutdown, on
 * the hardened shared browser lifecycle, so nothing leaks.
 *
 * No slash command: the agent (or a subagent) drives the tool.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { closeBrowser } from "../../lib/web/browser.js";
import { BrowserSession, type PageAction } from "../../lib/web/session.js";
import type { SemanticTarget } from "../../lib/web/target.js";

/** Close a session after this long without use. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface BrowserDetails {
	readonly ok: boolean;
	readonly session?: string;
}

interface Held {
	session: BrowserSession;
	idle: ReturnType<typeof setTimeout>;
}

export default function browserIntegration(pi: ExtensionAPI) {
	const sessions = new Map<string, Held>();

	const touch = (name: string, held: Held): void => {
		clearTimeout(held.idle);
		held.idle = setTimeout(() => {
			sessions.delete(name);
			void held.session.close();
		}, IDLE_TIMEOUT_MS);
		held.idle.unref?.();
	};

	const disposeAll = async (): Promise<void> => {
		const held = [...sessions.values()];
		sessions.clear();
		for (const h of held) {
			clearTimeout(h.idle);
			await h.session.close().catch(() => {});
		}
		await closeBrowser();
	};

	pi.on("session_shutdown", async () => {
		await disposeAll();
	});

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Drive a real browser over a named, persistent session. Actions: " +
			"open (start a session), navigate (go to a url), observe (return the " +
			"page's accessibility outline of roles and names), act (click or type " +
			"targeting an element by its role and accessible name, disambiguated " +
			"by container or the 1-based ordinal among same-named matches), and " +
			"close. A fresh observe follows every act. Target elements the way " +
			"they read in the outline, e.g. role button name 'Sign in'.",
		promptSnippet:
			"Drive a browser with the browser tool: observe the accessibility " +
			"outline, then act on elements by role and name.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("open"),
					Type.Literal("navigate"),
					Type.Literal("observe"),
					Type.Literal("act"),
					Type.Literal("close"),
				],
				{ description: "Which browser operation to run." },
			),
			session: Type.Optional(
				Type.String({ description: "Session name. Defaults to 'default'." }),
			),
			url: Type.Optional(
				Type.String({ description: "URL for open or navigate." }),
			),
			actKind: Type.Optional(
				Type.Union([Type.Literal("click"), Type.Literal("type")], {
					description: "For act: click an element or type into it.",
				}),
			),
			role: Type.Optional(
				Type.String({ description: "For act: the target element's role." }),
			),
			name: Type.Optional(
				Type.String({ description: "For act: the target's accessible name." }),
			),
			text: Type.Optional(
				Type.String({ description: "For act type: the text to enter." }),
			),
			ordinal: Type.Optional(
				Type.Number({
					description: "For act: 1-based position among same-named matches.",
				}),
			),
			container: Type.Optional(
				Type.String({
					description: "For act: restrict to a container with this name.",
				}),
			),
		}),
		async execute(_id, params): Promise<AgentToolResult<BrowserDetails>> {
			const name = params.session ?? "default";
			const text = (body: string): AgentToolResult<BrowserDetails> => ({
				content: [{ type: "text", text: body }],
				details: { ok: true, session: name },
			});
			const bad = (body: string): AgentToolResult<BrowserDetails> => ({
				content: [{ type: "text", text: body }],
				details: { ok: false, session: name },
			});

			if (params.action === "close") {
				const held = sessions.get(name);
				if (!held) return text(`No session '${name}'.`);
				clearTimeout(held.idle);
				sessions.delete(name);
				await held.session.close();
				return text(`Closed session '${name}'.`);
			}

			let held = sessions.get(name);
			if (!held) {
				if (params.action !== "open" && params.action !== "navigate") {
					return bad(`No session '${name}'. Open one first.`);
				}
				held = {
					session: await BrowserSession.open(name),
					idle: setTimeout(() => {}, 0),
				};
				sessions.set(name, held);
			}
			touch(name, held);

			if (
				(params.action === "open" || params.action === "navigate") &&
				params.url
			) {
				await held.session.navigate(params.url);
			}
			if (params.action === "act") {
				const built = buildAction(params);
				if (!built)
					return bad("act needs actKind, role and name (and text for type).");
				const result = await held.session.act(built);
				if (!result.ok) {
					return bad(
						result.reason === "ambiguous"
							? `Ambiguous: ${result.count} elements match role '${params.role}' name '${params.name}'. Disambiguate by container or ordinal.`
							: `No element matches role '${params.role}' name '${params.name}'.`,
					);
				}
			}
			// A fresh observe follows every navigate and act.
			const obs = await held.session.observe();
			return text(`${obs.title} — ${obs.url}\n\n${obs.outline}`);
		},
	});
}

function buildAction(params: {
	actKind?: "click" | "type";
	role?: string;
	name?: string;
	text?: string;
	ordinal?: number;
	container?: string;
}): PageAction | null {
	if (!params.actKind || !params.role || !params.name) return null;
	const target: SemanticTarget = {
		role: params.role,
		name: params.name,
		...(params.ordinal ? { ordinal: params.ordinal } : {}),
		...(params.container ? { container: { name: params.container } } : {}),
	};
	if (params.actKind === "type") {
		if (params.text === undefined) return null;
		return { kind: "type", target, text: params.text };
	}
	return { kind: "click", target };
}
