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
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { keyHint, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	boundedByDetails,
	openSessionStore,
} from "../../lib/core/result/index.ts";
import { registerBuiltinTreeProviders } from "../../lib/core/tree/index.ts";
import { setProgressSource } from "../../lib/internal/away/state.ts";
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { dataDir } from "../../lib/internal/paths.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../lib/internal/quest/discovery.ts";
import { formatRelativeAge } from "../../lib/internal/quest/session-liveness.ts";
import { offerShellEnvironment } from "../../lib/internal/shell/environment.ts";
import {
	registerBuiltinHandleTypes,
	registerBuiltinPersonResolvers,
} from "../../lib/people/index.ts";
import { registerStandingContext } from "../../lib/prompt/index.ts";
import { registerBuiltinUrlFetchers } from "../../lib/quest/index.ts";
import { registerBuiltinRefTypes } from "../../lib/refs/index.ts";
import { registerBuiltinTerminalDrivers } from "../../lib/terminal/index.ts";
import { asideFor } from "../../lib/ui/aside.ts";
import {
	asText,
	count,
	drawInto,
	firstText,
	renderToolCall,
} from "../../lib/ui/index.ts";
import { QUEST_ACTIONS } from "./actions.ts";
import { answerTreeClaims } from "./claims.ts";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
} from "./config.ts";
import { QUEST_CONTEXT, renderQuestContext } from "./context.ts";
import { isFocusedDocWrite, questVerdicts } from "./enforce.ts";
import { adoptTree, applyQuestGuards } from "./guard.ts";
import {
	attachCurrentSession,
	captureSessionIdentity,
	listAllQuests,
	persist,
	prunePhantomSessionsOnLoaded,
	reconcileSessionMembership,
	refreshLoadedSlice,
	refreshProgress,
	releaseSessionOnShutdown,
	resolveStartup,
} from "./lifecycle.ts";
import { recentSessionHints, showLoaded } from "./lookup.ts";
import { sayPeersOnStartup } from "./peers.ts";
import { keepDesktopListsCurrent } from "./quest-index.ts";
import { questsTouchedBy, RecordWatch } from "./record-watch.ts";
import { formatQuestList, renderWidget } from "./render.ts";
import {
	collapseListingPreview,
	collapseText,
	isListingDetails,
	renderListingExpanded,
} from "./render-rows.ts";
import { questCommandEnvironment } from "./scratch.ts";
import {
	endReasonForShutdown,
	lostSessionCount,
	recordSessionEnd,
	setSignalStampSession,
	stopHeartbeat,
	trackSession,
} from "./session-registry.ts";
import { STANDING_RULES, standingRules } from "./standing-rules.ts";
import { createQuestState, type QuestState } from "./state.ts";
import { handle, type QuestToolParams } from "./transitions.ts";
import { currentSessionId, isPersistedSession } from "./verbs/shared.ts";
import { keepQuestWeights } from "./weights.ts";
import { defaultWorkspaceRoot } from "./workspace.ts";

/** What an `agent_before_settle` handler may return, as pi 0.87 defines it. */
interface BeforeSettleResult {
	entries?: {
		type: "custom_message";
		customType: string;
		content: string;
		display: boolean;
	}[];
	continue?: boolean;
}

export default async function questWorkflow(pi: ExtensionAPI) {
	declareGuards(
		GUARDS.questRecord,
		GUARDS.questOwnedFields,
		GUARDS.questTemp,
		GUARDS.questPlanStage,
		GUARDS.questUntrackedTree,
		GUARDS.questHomeless,
	);
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
	const state = createQuestState({
		questsRoot,
		autoloadFromCwd: section.value.autoloadFromCwd,
		sessionRetentionDays: section.value.sessionRetentionDays,
	});

	// So the working layer does not reclaim a tree a quest is holding.
	answerTreeClaims(pi, questsRoot);

	// The agent's commands name the loaded quest, so the machine can
	// share itself by quest, and their temporary files go where that
	// quest reaps them. Asked as each command starts, so loading another
	// quest moves both.
	offerShellEnvironment("quest-workflow", () =>
		questCommandEnvironment(defaultWorkspaceRoot(), state.questId),
	);

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
			"Use action `create` to mint a new quest; a session with none loaded is put on it, and one already on a quest stays there. Use action `load` to switch to an existing one. The status line shows the loaded quest at all times.",
			"Edit a quest document's body with `journal` (add a Journey entry), `tick`/`untick` (a checkbox item) and `section` (replace one `##` section), not with edit or write: the workflow rewrites these files between reads, and hand edits miss. They act on the focused document, or the README when nothing is focused; `id` names any document or any quest's README, loaded or not, and `journal` takes a document's id as its quest's. Never load a quest just to write to it. Stage changes go through think/draft/build/conclude/retire.",
			"Read a quest document with `show` rather than reading or grepping its file: its `id` gives the outline (sections and their sizes, open items, the next), `title` one section, `query` one item and its notes, by its number or first words. Plans grow past 400 KB.",
			"`unload` puts a quest down and changes nothing on disk. `conclude` seals one for good (status, priority, documents, trees) and needs its `id`; never conclude to put a quest down. When unsure which was meant, unload.",
			"`focus` and `unfocus` set or clear the focused document. While a plan is focused in think or draft, edits to already-tracked code in the quest's trees (any tree, while it tracks none) defer to build; the plan itself, attachments, any workspace and brand-new files still flow.",
			"A quest folder holds only its README, its JOURNEY.md (written by journal), its ID documents and attachments/ (cited charts, notes and summaries within the limits). Clones, raw data, labs, runs and builds go in the quest's workspace, ~/.cache/pi/agentic-harness.pi/quest-workspace/<ID>/, whose tmp/ is cleared at conclude and is $TMPDIR while the quest is loaded: use $TMPDIR or mktemp for temporary files, never a path named in /tmp. When a result says a call left a record out of shape, move the files where it says.",
			"Stage transitions are think → draft → build → concluded (or retired). `think` accepts a kind on a fresh loop (default plan); `draft` writes the document and mints its id; `build` lets you implement. With nothing in hand, `draft` given a note and a title thinks and drafts in one call. Concluding or retiring the focused document puts it down, and a finished document is never reopened: think or draft beside it starts a fresh loop.",
			"A refused transition returns guidance and changes nothing. Nobody approves a transition and nothing prompts for one.",
		],
		parameters: Type.Object({
			action: StringEnum([...QUEST_ACTIONS], {
				description:
					"The action to perform. `status` is an alias for `show`, which given a document's id answers its outline: sections and their sizes, open items, the next.",
			}),
			id: Type.Optional(
				Type.String({
					description:
						"Target id: the quest or document acted on, loaded or not (default: the focused document, else the README). For reparent, conclude, retire and restore: comma-separated for several. For conclude/retire: the loaded quest's id seals it in full, trees pruned; other quest ids run a reversible status sweep; a document id concludes just that document. For locate: any quest, document, alias or session id. For undo: required, a quest the last structural change touched; undo reverses that change, which may be another session's, and refuses with no id or one it did not touch.",
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
						"create: the quest's title, as a person reads it (becomes the H1). draft: the document's title. section: the heading of the section to replace, or to add (a README's optional Milestones, Spirit, Outcomes or Context), without its emoji (e.g. Purpose). retitle: the new title, which replaces the H1 of the quest or document `id` names. show: the section to read.",
				}),
			),
			parent: Type.Optional(
				Type.String({
					description:
						"create: parent quest id when minting a subquest. reparent: the new parent quest id, or `null` to move the targets to top level.",
				}),
			),
			kind: Type.Optional(
				Type.String({
					description:
						"create and reclassify: quest, subquest or sidequest. think, or draft to override think's choice: plan, research, brief or report.",
				}),
			),
			note: Type.Optional(
				Type.String({
					description:
						"think: what this document is about, or what sent you back to thinking. create: optional Summary prose. journal: the Journey entry to add; the date is put in front of it.",
				}),
			),
			body: Type.Optional(
				Type.String({
					description:
						"section: the section's new text, without its heading. It may not hold a `## ` heading of its own.",
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
						"alias-add/alias-remove: the alias in `type:value` form (e.g. `github-pr:shop/world#47281`). Both accept a comma-separated list to add or remove several at once. tree-expand: the zone to add (e.g. system/gitstream).",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"find: free-text needle matched against title, id, body and alias values. locate: the needle to resolve when `id` is not given. tick/untick, and show to read it with its notes: the checkbox item, by its number, its text or the start of it.",
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
						"who: filter Cast bullets by name substring. session-attach/session-rename: a label for the session entry, as a person reads it.",
				}),
			),
			layout: Type.Optional(
				Type.String({
					description:
						"spawn and restore: window, tab or pane. Defaults to the person's terminal setting, else tab; spawn-* takes its suffix.",
				}),
			),
			terminal: Type.Optional(
				Type.String({
					description:
						"spawn and restore: kitty, wezterm, tmux, zellij, foot, alacritty, ghostty or one configured. Defaults to the person's setting, else the terminal the session sits in.",
				}),
			),
			nesting: Type.Optional(
				Type.String({
					description:
						"spawn and restore: for pi in nested terminals, innermost (the default, the one the person sees) or outermost.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description:
						"spawn: the command to run, `pi` by default. It runs detached, past every guard, so spawn only what the user authorized.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory: where spawn starts, the repo tree-add cuts from, a path inside the tree tree-adopt registers, or which tree tree-prune and tree-expand act on when the quest has several. Defaults: spawn takes the quest's newest tree, else a recent session's folder, else a tree's repo, else home, never a quest folder; the rest take the loaded quest's directory or the pi cwd.",
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
						"conclude/retire: 'quest' or 'document', which wins over what the id's shape implies. With no id it acts on the focused document, and refuses when nothing is focused.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"tree-prune: override its safety refusals (dirty tree, unmerged branch, attached session), consenting to lose uncommitted work: confirm with the person first. restore: reopen the lost sessions (or those id names), a terminal each, rather than list them; confirm first too.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description:
						"reparent, and conclude/retire of quests not loaded here: say what would change, writing nothing. spawn and restore: say what would open where, and which setting chose it, opening nothing. Every other action, and conclude/retire of the loaded quest or a document, refuses it and does nothing.",
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await handle(
				state,
				pi,
				ctx,
				params as QuestToolParams,
				signal,
			);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.guidance }],
					details: { ok: false, guidance: result.guidance },
				};
			}
			updateScoreboard(state, ctx);
			return {
				content: [
					{
						type: "text",
						// A tree or a listing can run long even with paging,
						// and this is the one place every action answers from.
						text: boundedByDetails(openSessionStore(), {
							text: result.message,
							details: result.details,
							narrowing:
								"Page with 'limit' and 'offset', or narrow with " +
								"'find', 'status' or 'priority'.",
						}),
					},
				],
				details: {
					ok: true,
					...(result.details ?? {}),
					questId: state.questId,
					documentId: state.documentId,
					stage: state.documentStage,
				},
			};
		},

		renderCall(args, theme, context) {
			const a = args as QuestToolParams;
			return renderToolCall(
				{
					tool: "quest",
					action: a.action,
					subject: a.title ?? a.id ?? a.note ?? a.url ?? a.reason,
				},
				theme,
				asText(context?.lastComponent),
			);
		},

		renderResult(result, options, theme, context) {
			const d = result.details as
				| {
						ok?: boolean;
						guidance?: string;
						listing?: unknown;
				  }
				| undefined;
			if (d && d.ok === false) {
				// The error colour, as review and work both use for a refusal. Warning
				// read as a soft advisory next to a green success, which is backwards:
				// the tool did not proceed.
				return drawInto(
					context?.lastComponent,
					theme.fg("error", d.guidance ?? "Refused"),
				);
			}
			const content = firstText(result);
			const listing = isListingDetails(d?.listing) ? d.listing : undefined;
			if (listing) {
				if (options.expanded) {
					return drawInto(
						context?.lastComponent,
						theme.fg("success", renderListingExpanded(listing)),
					);
				}
				return drawInto(
					context?.lastComponent,
					theme.fg("success", collapseListingPreview(listing, content)) +
						(listing.rows.length > 0
							? theme.fg(
									"muted",
									` (${keyHint("app.tools.expand", "to expand")})`,
								)
							: ""),
				);
			}
			// Non-listing results (show, who, links, ancestors) carry rich
			// multi-line output. Feed the human the same text as the agent,
			// collapsed to a first-line preview with an expand hint rather
			// than dropping everything past the first line.
			return drawInto(
				context?.lastComponent,
				theme.fg(
					"success",
					collapseText(
						content,
						options.expanded === true,
						keyHint("app.tools.expand", "to expand"),
					),
				),
			);
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
					"Usage: /quest-resume <session-id>. Run `quest recent` to list resumable sessions with their ids and resume commands.",
					"warning",
				);
				return;
			}
			if (!state.questId) {
				ctx.ui.notify(
					"No quest loaded. `quest load <id>` first, then /quest-resume.",
					"warning",
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
					"warning",
				);
				return;
			}
			let sessions: { id: string; path: string; cwd: string }[];
			try {
				sessions = await SessionManager.list(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(
					`Could not list sessions: ${(err as Error).message}`,
					"warning",
				);
				return;
			}
			const hit = sessions.find((s) => s.id === sessionId);
			if (!hit) {
				ctx.ui.notify(
					`Session ${sessionId} not found on disk for ${ctx.cwd}. It may live under a different cwd; open pi in that directory and try again.`,
					"warning",
				);
				return;
			}
			await ctx.switchSession(hit.path);
		},
	});

	// The record, read from disk after each call that could touch a quest
	// folder, since a command can make files without naming them.
	const watch = new RecordWatch({
		questsRoot,
		workspaceRoot: defaultWorkspaceRoot(),
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			const input = event.input as Record<string, unknown>;
			const refusal = applyQuestGuards(
				state,
				questVerdicts(state, event.toolName, input, ctx.cwd),
				adoptTree,
				() => `${event.toolName} ${JSON.stringify(input)}`,
			);
			if (refusal) return refusal;
			watch.before(
				event.toolCallId,
				questsTouchedBy(state, event.toolName, input, ctx.cwd, homedir()),
			);
			return undefined;
		},
	);

	// Before the run settles, continue once with whatever record breakage
	// it left. The event arrived after the pi this package builds against,
	// so it is registered through the untyped surface; an older pi never
	// fires it, and the per-call reports still reach the agent.
	const onBeforeSettle = pi.on.bind(pi) as unknown as (
		event: "agent_before_settle",
		handler: () => Promise<BeforeSettleResult | undefined>,
	) => void;
	onBeforeSettle("agent_before_settle", async () => {
		const message = watch.settle();
		if (!message) return;
		return {
			entries: [
				{
					type: "custom_message",
					customType: "quest-record",
					content: message,
					display: true,
				},
			],
			continue: true,
		};
	});

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
		// A quest action can change what a quest's work is weighted by, and
		// which quests orchestrate, and what the desktop lists.
		if (event.toolName === "quest") {
			keepQuestWeights(state.questsRoot);
			void keepDesktopListsCurrent(state.questsRoot);
		}
		const broke = watch.after(event.toolCallId);
		if (broke) {
			return { content: [...event.content, { type: "text", text: broke }] };
		}
	});

	// Where the focused plan stands, for away-workflow's nudge that keeps
	// an unattended run going. Only a plan in build is work in progress.
	setProgressSource(() => {
		refreshProgress(state);
		if (state.documentKind !== "plan" || state.documentStage !== "build")
			return undefined;
		if (!state.documentId || state.total === 0) return undefined;
		return {
			document: state.documentId,
			done: state.done,
			total: state.total,
			...(state.currentItem ? { next: state.currentItem } : {}),
		};
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
		// can move them back into place rather than noticing
		// later that a quest "vanished."
		const { errors } = discoverQuests(state.questsRoot);
		// As one notice through the session's screen, never straight to
		// the terminal, which pi is drawing (lib/ui/aside.ts).
		if (errors.length > 0) {
			const preview = errors.slice(0, 5);
			const lines = [
				`[quest-workflow] discovery surfaced ${count(errors.length, "layout error")}:`,
				...preview.map((err) => `  ${err.path}: ${err.message}`),
				...(errors.length > preview.length
					? [`  and ${errors.length - preview.length} more`]
					: []),
				"Each is skipped until it is moved into the layout the quest-format skill describes.",
			];
			asideFor(ctx)(lines.join("\n"));
		}
		// From the walk just made, so it costs a look, and it catches a
		// priority edited by hand while no session was running.
		keepQuestWeights(state.questsRoot);
		void keepDesktopListsCurrent(state.questsRoot);

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
			// Before attaching, which writes this process over the record.
			sayPeersOnStartup(state, pi, ctx);
			const sid = currentSessionId(ctx, undefined);
			attachCurrentSession(state, {
				id: sid,
				cwd: ctx.cwd,
				persisted: isPersistedSession(ctx),
				...captureSessionIdentity(),
			});
			// Reconcile on the launch path too, not only the explicit
			// load verb: a resumed or spawned session lands here, and
			// without this it would re-attach while still reading active
			// on a straggler quest from an earlier run.
			if (sid && isPersistedSession(ctx) && state.questId) {
				reconcileSessionMembership(state, sid, state.questId);
			}
		}
		// Record every tab a person could want back, quest or not, so a
		// later restart can reconstruct what was open together. Only a
		// persisted interactive session is resumable: a fan-out runs
		// without a session and a print run has no tab. The record is
		// re-dated on a heartbeat and stamped by the signal that takes the
		// tab away, since pi reports a closed tab as a quit. Best-effort.
		const sid = currentSessionId(ctx, undefined);
		if (sid && isPersistedSession(ctx) && ctx.hasUI) {
			trackSession(
				{
					sessionId: sid,
					cwd: ctx.cwd,
					...(state.questId ? { questId: state.questId } : {}),
					...captureSessionIdentity(),
				},
				() => releaseSessionOnShutdown(state, sid),
			);
		}
		updateScoreboard(state, ctx);
		// A passive pointer, nothing more: list the few most recently
		// active sessions so a fresh shell can see where work was without
		// probing history or loading anything. The authoritative, probed
		// view is `quest recent`.
		showSessionHint(state, ctx);
	});

	// Tear down the bridge so a session_shutdown followed
	// by a re-activation doesn't leave a stale closure
	// pointing at the old state object on globalThis.
	// Pass our own bridge so an out-of-order shutdown
	// can only clear its own registration, never a
	// fresher instance's.
	pi.on("session_shutdown", async (event, ctx) => {
		const sid = currentSessionId(ctx, undefined);
		// Stop beating before stamping: a tick that landed afterwards
		// would touch the file again and re-date a session that has
		// already ended.
		stopHeartbeat();
		// End the session's registry record, but only for the reasons
		// that actually end something. A reload keeps the same session
		// running in the same process, so stamping it would date a tab
		// as closed while it is still on screen.
		const ended = endReasonForShutdown(event.reason);
		if (sid && ended) recordSessionEnd(sid, ended);
		// A swap hands the process to another conversation, so a later
		// signal is no longer this session's to take. A quit keeps
		// following it: pi reports a signal as a quit, and the listener
		// that runs right after this is what corrects the record.
		if (ended === "swapped") setSignalStampSession(undefined);
		// Mark this session detached on the loaded quest so its
		// liveness reads correctly after the process exits. Only when
		// something ended, for the same reason as the record: a reload
		// keeps the session running in this process.
		if (sid && ended) releaseSessionOnShutdown(state, sid);
		// The discovery memo is the process's and outlives this code. The
		// code a reload brings may shape the index differently, so it
		// starts from an empty memo rather than reading this one.
		if (event.reason === "reload") clearDiscoveryCache();
	});

	// Tell the model which quest the conversation is on, which document
	// is focused and at what stage, without re-deriving it from disk on
	// every step. A standing context: frozen into the system prompt, with
	// a later change said as a message, so a quest action never rewrites
	// the cached conversation.
	registerStandingContext(pi, QUEST_CONTEXT, () => renderQuestContext(state));

	// The rules the orchestrator above this quest sets for every quest
	// below it, so a session starts with them rather than reading that
	// quest's whole README.
	const rulesFor = standingRules(() => state.questsRoot);
	registerStandingContext(pi, STANDING_RULES, () => rulesFor(state.questId));
}

/** The minimal render component pi's setWidget callback form returns. */
interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

type Theme = import("@earendil-works/pi-coding-agent").Theme;

interface UiSink {
	setStatus(key: string, value: string | undefined): void;
	setWidget(
		key: string,
		value:
			| string[]
			| ((tui: unknown, theme: Theme) => WidgetComponent)
			| undefined,
	): void;
	theme: Theme;
}

/**
 * Paint the loaded quest into its widget, the quest's one line.
 *
 * The widget uses pi's callback form, whose `render(width)` the TUI
 * re-invokes on every paint, including a resize, with the live width,
 * so the line re-truncates to the new width.
 *
 * The footer slot is cleared rather than left alone: a session that
 * reloaded from a version which drew the quest there would otherwise
 * keep the old text until it ended.
 */
export function updateScoreboard(state: QuestState, ctx: { ui: UiSink }): void {
	const live = state.questId !== null;
	ctx.ui.setStatus("quest-workflow", undefined);
	const widgetInput = {
		questId: state.questId,
		questKind: state.questKind,
		questStatus: state.questStatus,
		questTitle: state.questTitle,
		documentKind: state.documentKind,
		documentStage: state.documentStage,
		documentTitle: state.documentTitle,
		done: state.done,
		total: state.total,
		currentItem: state.currentItem,
	};
	ctx.ui.setWidget(
		"quest-workflow",
		!live
			? undefined
			: (_tui: unknown, theme: Theme): WidgetComponent => ({
					render: (width: number) => renderWidget(widgetInput, theme, width),
					invalidate() {},
				}),
	);
}

/** The most recent sessions the passive start hint will name. */
const SESSION_HINT_ROWS = 3;

/**
 * Show a passive, one-shot hint naming the few most recently active
 * sessions, so a fresh shell can see where work was without probing
 * history or loading anything. Reads only cheap log activity; it
 * never probes liveness, never loads a quest and never mutates a
 * record. Silent when there is nothing recent to point at.
 */
function showSessionHint(
	state: QuestState,
	ctx: { ui: { notify(message: string, level: "info"): void } },
): void {
	// Lead with what was lost. The moment restore is most needed is
	// the moment nobody thinks to run it: after a crash you are busy
	// reconstructing, not remembering which verb exists.
	const lost = lostSessionCount();
	if (lost > 0) {
		ctx.ui.notify(
			`${count(lost, "quest session")} went with a crash or a closed terminal. Run \`quest restore\` to see them, or \`quest restore force\` to reopen them.`,
			"info",
		);
	}
	const hints = recentSessionHints(state, SESSION_HINT_ROWS);
	if (hints.length === 0) return;
	const now = new Date();
	const lines = hints.map((h) => {
		const age = formatRelativeAge(h.lastActivity, now);
		const when = age ? ` (${age})` : "";
		const where = h.cwd ? ` ${h.cwd}` : "";
		return `- ${h.questId} ${h.title ?? ""}${where}${when}`.trimEnd();
	});
	ctx.ui.notify(
		`Recent quest sessions:\n${lines.join("\n")}\nRun \`quest recent\` for the live view.`,
		"info",
	);
}
