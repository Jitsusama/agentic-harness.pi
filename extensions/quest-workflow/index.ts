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

import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { keyHint, SessionManager } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.js";
import { dataDir } from "../../lib/internal/paths.js";
import { appendJourneyByPath } from "../../lib/internal/quest/append-journey.js";
import { discoverQuests } from "../../lib/internal/quest/discovery.js";
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
import { registerBuiltinTreeProviders } from "../../lib/tree/index.js";
import { QUEST_ACTIONS } from "./actions.js";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
} from "./config.js";
import { enforceQuest, isFocusedDocWrite } from "./enforce.js";
import {
	attachCurrentSession,
	detachSessionFromLoaded,
	listAllQuests,
	persist,
	prunePhantomSessionsOnLoaded,
	reconcileSessionMembership,
	refreshLoadedSlice,
	refreshProgress,
	resolveStartup,
} from "./lifecycle.js";
import { showLoaded } from "./lookup.js";
import { formatQuestList, renderStatus, renderWidget } from "./render.js";
import {
	collapseListingPreview,
	isListingDetails,
	renderListingExpanded,
} from "./render-rows.js";
import { createQuestState, type QuestState } from "./state.js";
import { handle, type QuestToolParams } from "./transitions.js";
import { currentSessionId, isPersistedSession } from "./verbs/shared.js";

const DEFAULT_WIDTH = 80;
const CALL_PREFIX_WIDTH = 14;

export default async function questWorkflow(pi: ExtensionAPI) {
	// Seed the pluggable registries with their built-in
	// types on activate. Idempotent: re-registers cleanly.
	registerBuiltinRefTypes();
	registerBuiltinHandleTypes();
	registerBuiltinPersonResolvers();
	registerBuiltinUrlFetchers();
	registerBuiltinTerminalDrivers();
	registerBuiltinTreeProviders();

	// Resolve the quests root from the package config file.
	// A missing file or a malformed section degrades to the
	// default data-dir location; the config query verb is
	// where provenance and any warning surface to the user.
	const loaded = await loadPackageConfig();
	const section = loaded.ok
		? getSection(loaded.config, QUEST_WORKFLOW_SLUG, parseQuestWorkflowConfig)
		: { value: {} };
	const questsRoot = resolveQuestsRoot(
		section.value,
		dataDir("quest-workflow"),
	);
	const state = createQuestState({ questsRoot });

	// Expose the PR-workflow bridge so pr-workflow can
	// scaffold a sidequest when it loads a PR. The
	// integration is additive: pr-workflow checks for the
	// bridge and skips quietly when absent. We hold a
	// reference to our own bridge so a session_shutdown
	// from a stale extension instance can only clear its
	// own registration, not a fresher one that a later
	// activation installed.
	const ownBridge = {
		questsRoot: () => state.questsRoot,
		loadedQuestId: () => state.questId,
		logJourney: (questDir: string, prose: string) =>
			appendJourneyByPath(questDir, prose),
	};
	registerQuestPrBridge(ownBridge);

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
			"`focus` and `unfocus` set or clear the focused document. While a plan is focused in think or draft, edits to already-tracked code defer to build; the plan itself, quest-directory files, scratch paths and brand-new files still flow.",
			"Stage transitions are think → draft → build → concluded (or retired). `think` accepts a kind on a fresh loop (default plan); `draft` scaffolds the document and mints its id; `build` lets you implement.",
			"A refused transition returns guidance and changes nothing. There is no human gate and no approval prompt.",
		],
		parameters: Type.Object({
			action: StringEnum([...QUEST_ACTIONS], {
				description:
					"The action to perform. `status` is an alias for `show`. The dispatcher's refusal path Levenshtein-suggests the nearest action when an agent calls past the schema's enum (e.g. through a custom client that bypasses validation).",
			}),
			id: Type.Optional(
				Type.String({
					description:
						"Target id. For load/focus: the quest or document id. For spawn-tab/pane/window: open the new terminal pointed at this quest without touching the caller's loaded state. For reparent: the quest id(s) to move, comma-separated for a batch. For conclude/retire: a comma-separated id set triggers a bulk, reversible status sweep over those quests (no tree pruning), distinct from concluding the loaded quest. For locate: the needle to resolve to its owning quest (a quest id, document id, alias ref or session id). For create: ignored.",
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
					description:
						"create: parent quest id when minting a subquest. reparent: the new parent quest id, or `null` to move the target(s) to top level.",
				}),
			),
			kind: Type.Optional(
				Type.String({
					description:
						"create: quest, subquest or sidequest. reclassify: the loaded quest's new kind (quest, subquest or sidequest). think: plan, research, brief or report. draft: override the document kind chosen at think time before the id is minted (plan, research, brief or report).",
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
						"alias-add/alias-remove: the alias in `type:value` form (e.g. `github-pr:shop/world#47281`). alias-add also accepts a comma-separated list to add several at once.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"find: free-text needle matched against title, id, body and alias values. locate: the needle to resolve when `id` is not given.",
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
						"Working directory. For spawn: where the new terminal starts. For session-attach: the directory recorded on the attached session. For tree-add: the repo to scaffold a tree from. For tree-adopt: a path inside the existing git tree to register (you do not need to change your session's directory to adopt a tree). Defaults to the loaded quest's directory or the pi cwd.",
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
			dryRun: Type.Optional(
				Type.Boolean({
					description:
						"reparent and bulk conclude/retire: preview the planned changes and report exactly what would change without writing anything. Use undo to reverse the last applied structural edit.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description:
						"list/find/who: maximum rows in the listing. Defaults to 25.",
					minimum: 1,
				}),
			),
			offset: Type.Optional(
				Type.Integer({
					description:
						"list/find/who: skip the first N rows before rendering. Use with limit for pagination.",
					minimum: 0,
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

		renderResult(result, options, theme) {
			const d = result.details as
				| {
						ok?: boolean;
						guidance?: string;
						listing?: unknown;
				  }
				| undefined;
			if (d && d.ok === false) {
				return new Text(theme.fg("warning", d.guidance ?? "Refused"), 0, 0);
			}
			const content =
				result.content?.[0] && "text" in result.content[0]
					? result.content[0].text
					: "";
			const listing = isListingDetails(d?.listing) ? d.listing : undefined;
			if (listing) {
				if (options.expanded) {
					return new Text(
						theme.fg("success", renderListingExpanded(listing)),
						0,
						0,
					);
				}
				return new Text(
					theme.fg("success", collapseListingPreview(listing, content)) +
						(listing.rows.length > 0
							? theme.fg(
									"muted",
									` (${keyHint("app.tools.expand", "to expand")})`,
								)
							: ""),
					0,
					0,
				);
			}
			const first = content.split("\n")[0];
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
		persist(state, pi, ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Re-read the loaded quest's README so a title, status
		// or priority edited in place (not through a verb that
		// already updates state) is reflected in the status line
		// without a manual reload.
		refreshLoadedSlice(state);
		refreshProgress(state);
		updateScoreboard(state, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		// Surface any layout-drift errors the discovery walk
		// found. After the canonical-layout tightening, a
		// nested QEST dir or a misplaced doc file gets recorded
		// as a DiscoveryError and skipped from the index. The
		// user needs to know those quests didn't load so they
		// can run the migrator (or fix by hand) rather than
		// noticing later that a quest "vanished."
		const { errors } = discoverQuests(state.questsRoot);
		if (errors.length > 0) {
			const preview = errors.slice(0, 5);
			console.error(
				`[quest-workflow] discovery surfaced ${errors.length} layout error(s):`,
			);
			for (const err of preview) {
				console.error(`  ${err.path}: ${err.message}`);
			}
			if (errors.length > preview.length) {
				console.error(`  ... and ${errors.length - preview.length} more`);
			}
			console.error(
				"Run `scripts/migrate-quests-canonical.ts --dry-run` to inspect, then drop --dry-run to apply.",
			);
		}

		// Resolve which quest to load through the one startup
		// pipeline: an explicit spawn request wins, then this
		// session's persisted history (a /reload restores the last
		// loaded quest and focused document), then the cwd for a
		// fresh session launched inside a quest or its tree.
		resolveStartup(state, pi, ctx);
		// Once a quest is loaded (restored, autoloaded or
		// resolved from the cwd), record this session on it so
		// the sessions frontmatter reflects where work happens.
		if (state.questId) {
			// Garbage-collect no-log phantoms here too: most reopens go
			// through this autoload/restore path rather than the explicit
			// load verb, so pruning only there would rarely fire. The
			// no-op case is cheap (it skips the write).
			prunePhantomSessionsOnLoaded(state);
			const sid = currentSessionId(ctx, undefined);
			attachCurrentSession(state, {
				id: sid,
				cwd: ctx.cwd,
				persisted: isPersistedSession(ctx),
			});
			// Reconcile on the launch path too, not only the explicit
			// load verb: a resumed or spawned session lands here, and
			// without this it would re-attach while still reading active
			// on a straggler quest from an earlier run.
			if (sid && isPersistedSession(ctx) && state.questId) {
				reconcileSessionMembership(state, sid, state.questId);
			}
		}
		updateScoreboard(state, ctx);
	});

	// Tear down the bridge so a session_shutdown followed
	// by a re-activation doesn't leave a stale closure
	// pointing at the old state object on globalThis.
	// Pass our own bridge so an out-of-order shutdown
	// can only clear its own registration, never a
	// fresher instance's.
	pi.on("session_shutdown", async (_event, ctx) => {
		// Mark this session detached on the loaded quest so its
		// liveness reads correctly after the process exits.
		if (state.questId) {
			const sid = currentSessionId(ctx, undefined);
			if (sid) detachSessionFromLoaded(state, sid);
		}
		unregisterQuestPrBridge(ownBridge);
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
	const width = process.stdout.columns || DEFAULT_WIDTH;
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
					width,
				)
			: undefined,
	);
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
						documentTitle: state.documentTitle,
						done: state.done,
						total: state.total,
						currentItem: state.currentItem,
					},
					ctx.ui.theme,
					width,
				),
	);
}
