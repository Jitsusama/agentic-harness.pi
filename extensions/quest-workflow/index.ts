/**
 * Quest Workflow Extension
 *
 * The unified hierarchical workspace: campaigns (quests),
 * subquests under them, and free-standing sidequests, with
 * plan, research, brief and report documents nested
 * underneath. Subsumes the plan-workflow stage machine and
 * the asks/sidequests/issues substrate that lived under
 * `~/src/localhost/documents/projects/`.
 *
 * The extension is the only one with the `quest` tool; the
 * skill teaches the methodology, the convention skill
 * teaches the README format, and this extension keeps the
 * state and the discipline. One tool, action verbs, no
 * slash commands for the primary surface.
 */

import { homedir } from "node:os";
import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { dataDir } from "../../lib/internal/paths.js";
import { appendJourneyByPath } from "../../lib/internal/quest/append-journey.js";
import {
	registerBuiltinHandleTypes,
	registerBuiltinPersonResolvers,
} from "../../lib/people/index.js";
import {
	registerBuiltinUrlFetchers,
	registerQuestPrBridge,
	unregisterQuestPrBridge,
} from "../../lib/quest/index.js";
import { registerBuiltinRefTypes } from "../../lib/refs/index.js";
import { registerBuiltinTerminalDrivers } from "../../lib/terminal/index.js";
import { enforceQuest, isFocusedDocWrite } from "./enforce.js";
import {
	listAllQuests,
	loadQuest,
	persist,
	refreshProgress,
	restore,
	restoreFromCwd,
} from "./lifecycle.js";
import { showLoaded } from "./lookup.js";
import { formatQuestList, renderStatus, renderWidget } from "./render.js";
import { createQuestState, type QuestState } from "./state.js";
import { handle, type QuestToolParams } from "./transitions.js";

const DEFAULT_WIDTH = 80;
const CALL_PREFIX_WIDTH = 14;

export default function questWorkflow(pi: ExtensionAPI) {
	// Seed the pluggable registries with their built-in
	// types on activate. Idempotent: re-registers cleanly.
	registerBuiltinRefTypes();
	registerBuiltinHandleTypes();
	registerBuiltinPersonResolvers();
	registerBuiltinUrlFetchers();
	registerBuiltinTerminalDrivers();

	const state = createQuestState({
		homeDir: homedir(),
		dataDir: dataDir("quest-workflow"),
	});

	// Expose the PR-workflow bridge so pr-workflow can
	// scaffold a sidequest when it loads a PR. The
	// integration is additive: pr-workflow checks for the
	// bridge and skips quietly when absent.
	registerQuestPrBridge({
		questsRoot: () => state.questsRoot,
		loadedQuestId: () => state.questId,
		logJourney: (questDir, prose) => appendJourneyByPath(questDir, prose),
	});

	pi.registerTool({
		name: "quest",
		label: "Quest",
		description:
			"Drive quests, subquests and sidequests through their lifecycle. Create, load, focus, run the document stage machine, conclude or retire.",
		promptSnippet:
			"Drive quest work with the quest tool. Create from titles (and " +
			"eventually URLs); load by id; focus a document and run its " +
			"think/draft/build/conclude/retire stage machine. Read the quest " +
			"convention skill for the README format.",
		promptGuidelines: [
			"Use action `create` to mint a new quest. Use action `load` to switch to an existing one. The status bar shows the loaded quest at all times.",
			"`focus` and `unfocus` set or clear the focused document. While a plan is focused in think or draft, code writes are blocked everywhere except the plan document itself.",
			"Stage transitions are think → draft → build → concluded (or retired). `think` accepts a kind on a fresh loop (default plan); `draft` scaffolds the document and mints its id; `build` lets you implement.",
			"A refused transition returns guidance and changes nothing. There is no human gate and no approval prompt.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"create",
					"load",
					"unload",
					"show",
					"list",
					"tree",
					"tree-add",
					"tree-list",
					"tree-prune",
					"tree-expand",
					"expand",
					"focus",
					"unfocus",
					"think",
					"draft",
					"build",
					"conclude",
					"retire",
					"promote",
					"demote",
					"drive",
					"park",
					"defer",
					"top",
					"bottom",
					"bump",
					"sink",
					"before",
					"after",
					"renumber",
					"alias-add",
					"alias-remove",
					"session-attach",
					"session-detach",
					"session-rename",
					"spawn-tab",
					"spawn-pane",
					"spawn-window",
					"find",
					"who",
					"links",
				] as const,
				{ description: "The action to perform." },
			),
			id: Type.Optional(
				Type.String({
					description:
						"Target id. For load/focus: the quest or document id. For create: ignored.",
				}),
			),
			url: Type.Optional(
				Type.String({
					description:
						"create: seed a new quest from this URL (Slack thread, GitHub PR or issue). The tool fetches and parses the source.",
				}),
			),
			title: Type.Optional(
				Type.String({
					description:
						"create: the quest's human title (becomes the H1). draft: the document's title.",
				}),
			),
			parent: Type.Optional(
				Type.String({
					description: "create: parent quest id when minting a subquest.",
				}),
			),
			kind: Type.Optional(
				Type.String({
					description:
						"create: quest, subquest or sidequest. think: plan, research, brief or report.",
				}),
			),
			note: Type.Optional(
				Type.String({
					description:
						"think: what this document is about, or what sent you back to thinking. create: optional Summary prose.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "retire: why the document is being abandoned.",
				}),
			),
			priority: Type.Optional(
				Type.String({
					description:
						"create: initial priority bucket (driving, active, queued, bench, someday). Defaults to active. find: filter by priority.",
				}),
			),
			status: Type.Optional(
				Type.String({
					description:
						"find: filter by status (active, paused, blocked, concluded, retired).",
				}),
			),
			target: Type.Optional(
				Type.String({
					description: "before/after: the quest id to position against.",
				}),
			),
			ref: Type.Optional(
				Type.String({
					description:
						"alias-add/alias-remove: the alias in `type:value` form (e.g. `github-pr:shop/world#47281`).",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"find: free-text needle matched against title, id, body and alias values.",
				}),
			),
			since: Type.Optional(
				Type.String({
					description:
						"find: only quests updated on or after this date (YYYY-MM-DD or ISO).",
				}),
			),
			until: Type.Optional(
				Type.String({
					description: "find: only quests updated on or before this date.",
				}),
			),
			role: Type.Optional(
				Type.String({
					description:
						"who: filter Cast bullets by role (owner, reviewer, originator, ...).",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"who: filter Cast bullets by name substring. session-attach/session-rename: human label for the session entry.",
				}),
			),
			layout: Type.Optional(
				Type.String({
					description:
						"spawn: explicit layout (tab, pane, window). Defaults to the action's suffix.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description:
						"spawn: shell command for the new terminal. Defaults to `pi`. This launches a detached process the other guardians cannot intercept; the agent should only spawn commands the user has authorized.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"spawn/session-attach: working directory. Defaults to the loaded quest's directory or the pi cwd.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description:
						"session-*: target session id when not the current pi session.",
				}),
			),
			field: Type.Optional(
				Type.String({
					description:
						"find: which date drives since/until (started, updated, due, eta). Defaults to updated.",
				}),
			),
			refType: Type.Optional(
				Type.String({
					description:
						"find: only quests carrying an alias of this type (e.g. github-pr).",
				}),
			),
			pattern: Type.Optional(
				Type.String({
					description: "links: substring filter on the link's value or URL.",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description:
						"conclude/retire: 'quest' or 'document'. Defaults to the focused document when one is set, otherwise the loaded quest.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"tree-prune: override safety refusals (dirty working tree, unmerged branch, attached session). Destructive: passing true is consent to lose uncommitted work, so the agent should confirm with the user first.",
				}),
			),
			skipTree: Type.Optional(
				Type.Boolean({
					description:
						"build: skip the primary-plan tree gate (documentation-only build with no working tree).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await handle(state, pi, ctx, params as QuestToolParams);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.guidance }],
					details: { ok: false, guidance: result.guidance },
				};
			}
			updateScoreboard(state, ctx);
			return {
				content: [{ type: "text", text: result.message }],
				details: {
					ok: true,
					...(result.details ?? {}),
					questId: state.questId,
					documentId: state.documentId,
					stage: state.documentStage,
				},
			};
		},

		renderCall(args, theme) {
			const a = args as QuestToolParams;
			const action = a.action ?? "";
			let text = theme.fg("toolTitle", theme.bold("quest "));
			text += theme.fg("text", action);
			const note = a.title ?? a.id ?? a.note ?? a.url ?? a.reason;
			if (note) {
				const room = Math.max(
					0,
					(process.stdout.columns || DEFAULT_WIDTH) -
						CALL_PREFIX_WIDTH -
						action.length,
				);
				text += theme.fg("dim", `: ${truncateToWidth(note, room)}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| { ok?: boolean; guidance?: string }
				| undefined;
			if (d && d.ok === false) {
				return new Text(theme.fg("warning", d.guidance ?? "Refused"), 0, 0);
			}
			const first =
				result.content?.[0] && "text" in result.content[0]
					? result.content[0].text.split("\n")[0]
					: "";
			return new Text(theme.fg("success", first), 0, 0);
		},
	});

	pi.registerCommand("quest", {
		description:
			"Show the loaded quest, or `/quest list` to discover quests under the questsRoot.",
		handler: async (args, ctx) => {
			if (args?.trim() === "list") {
				const entries = listAllQuests(state);
				ctx.ui.notify(
					entries.length > 0
						? formatQuestList(entries)
						: `No quests under ${state.questsRoot}.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				state.questId
					? `Quest ${state.questId} (${state.questStatus}/${state.questPriority}) → ${state.questDir}`
					: "No quest loaded.",
				"info",
			);
		},
	});

	pi.registerCommand("quest-resume", {
		description:
			"Switch to a pi session previously attached to the loaded quest. Usage: `/quest-resume <session-id>`",
		handler: async (args, ctx) => {
			const sessionId = args?.trim();
			if (!sessionId) {
				ctx.ui.notify(
					"Usage: /quest-resume <session-id>. Run `quest show` to see the loaded quest's attached sessions.",
					"warn",
				);
				return;
			}
			if (!state.questId) {
				ctx.ui.notify(
					"No quest loaded. `quest load <id>` first, then /quest-resume.",
					"warn",
				);
				return;
			}
			// Confirm the session id is in the loaded quest's
			// frontmatter; we don't want to send the user to a
			// session that isn't part of this quest's audit
			// trail.
			const projection = await showLoaded(state);
			const attached = (projection?.frontMatter.sessions ?? []).some(
				(s) => s.id === sessionId,
			);
			if (!attached) {
				ctx.ui.notify(
					`Session ${sessionId} is not attached to ${state.questId}. Use \`quest session-attach\` to attach the current session, or \`quest show\` to see attached sessions.`,
					"warn",
				);
				return;
			}
			let sessions: { id: string; path: string; cwd: string }[];
			try {
				sessions = await SessionManager.list(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(
					`Could not list sessions: ${(err as Error).message}`,
					"warn",
				);
				return;
			}
			const hit = sessions.find((s) => s.id === sessionId);
			if (!hit) {
				ctx.ui.notify(
					`Session ${sessionId} not found on disk for ${ctx.cwd}. It may live under a different cwd; open pi in that directory and try again.`,
					"warn",
				);
				return;
			}
			await ctx.switchSession(hit.path);
		},
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> =>
			enforceQuest(
				state,
				event.toolName,
				event.input as Record<string, unknown>,
				ctx.cwd,
			),
	);

	// When the focused document gets edited, repaint the
	// scoreboard so progress numbers update. Persist the
	// loaded-quest and focused-document pointers on every
	// tool result so a /reload (or any other session restart)
	// can re-hydrate without re-reading the cwd. Mirrors the
	// pr-workflow pattern: pi sequences event handlers, so a
	// tool that mutates state in-handler has finished writing
	// by the time we read it here.
	pi.on("tool_result", async (event, ctx) => {
		if (
			isFocusedDocWrite(
				event.toolName,
				event.input as Record<string, unknown>,
				state.documentPath,
				ctx.cwd,
			)
		) {
			refreshProgress(state);
			updateScoreboard(state, ctx);
		}
		persist(state, pi);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshProgress(state);
		updateScoreboard(state, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		// The persisted slice in the session history is the
		// authoritative source: a /reload reuses the same
		// session, so the last loaded quest and focused
		// document are exactly the right thing to restore.
		const restored = restore(state, pi, ctx);
		if (!restored) {
			// A fresh session has no history yet. A spawn from
			// the quest workflow's spawn-* verbs ships the
			// loaded quest id via this env var so the new
			// session can name itself after the right quest
			// even when the cwd doesn't disambiguate. Consume
			// and clear it so the hint doesn't carry across
			// in-process session restarts.
			const autoloadId = process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
			if (autoloadId) {
				delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
				loadQuest(state, pi, autoloadId);
			}
			if (!state.questId) restoreFromCwd(state, pi, ctx);
		}
		updateScoreboard(state, ctx);
	});

	// Tear down the bridge so a session_shutdown followed
	// by a re-activation doesn't leave a stale closure
	// pointing at the old state object on globalThis.
	pi.on("session_shutdown", async () => {
		unregisterQuestPrBridge();
	});

	// Inject the loaded-quest context into every agent
	// turn's system prompt so the model sees "this
	// conversation is on quest X, focused on document Y, at
	// stage Z" without re-deriving it from filesystem
	// state on every step.
	pi.on("before_agent_start", async (event) => {
		if (!state.questId) return undefined;
		const parts: string[] = [
			`Quest ${state.questId} loaded (${state.questKind ?? "quest"}, ${state.questStatus ?? "active"}/${state.questPriority ?? "active"}).`,
		];
		if (state.questTitle) parts.push(`Title: ${state.questTitle}.`);
		if (state.documentId) {
			parts.push(
				`Focused document: ${state.documentId} (${state.documentKind}/${state.documentStage}).`,
			);
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n[Quest workflow context] ${parts.join(" ")}`,
		};
	});
}

interface UiSink {
	setStatus(key: string, value: string | undefined): void;
	setWidget(key: string, value: string[] | undefined): void;
	theme: import("@mariozechner/pi-coding-agent").Theme;
}

function updateScoreboard(state: QuestState, ctx: { ui: UiSink }): void {
	const live = state.questId !== null;
	ctx.ui.setStatus(
		"quest-workflow",
		live
			? renderStatus(
					{
						questId: state.questId,
						questKind: state.questKind,
						questStatus: state.questStatus,
					},
					ctx.ui.theme,
				)
			: undefined,
	);
	const width = process.stdout.columns || DEFAULT_WIDTH;
	ctx.ui.setWidget(
		"quest-workflow",
		!live
			? undefined
			: renderWidget(
					{
						questId: state.questId,
						questTitle: state.questTitle,
						documentKind: state.documentKind,
						documentStage: state.documentStage,
						done: state.done,
						total: state.total,
					},
					ctx.ui.theme,
					width,
				),
	);
}
