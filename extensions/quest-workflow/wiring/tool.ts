/**
 * The quest tool as pi sees it: its description and guidelines, how a
 * call runs through the stage machine and answers, and how its call
 * and result are drawn. It changes when the tool says or shows
 * something new, not when an action does.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { boundedByDetails } from "../../../lib/core/result/details.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import { keepDoingSaid } from "../../../lib/internal/quest/sessions/doing.ts";
import { sayDid, stageTitle } from "../../../lib/internal/session/events.ts";
import { asText, drawInto, renderToolCall } from "../../../lib/ui/tool-call.ts";
import { firstText } from "../../../lib/ui/tool-result.ts";
import { spawnedBy, watchFirstTurn } from "../first-turn-watch.ts";
import { withRenamedAction } from "../renames.ts";
import {
	collapseListingPreview,
	collapseText,
	isListingDetails,
	renderListingExpanded,
} from "../render-rows.ts";
import type { QuestState } from "../state.ts";
import { handle, type QuestToolParams } from "../transitions.ts";
import { cutReadAdvice } from "../verbs/document.ts";
import { currentSessionId } from "../verbs/shared.ts";
import { QUEST_PARAMETERS } from "./parameters.ts";
import { updateScoreboard } from "./scoreboard.ts";

/** Register the quest tool, which acts on the given state. */
export function registerQuestTool(pi: ExtensionAPI, state: QuestState): void {
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
			"`focus` and `unfocus` set or clear the focused document. While a plan is focused in think or draft, edits to already-tracked code in the quest's trees (any tree, while it tracks none) defer to build; the plan itself, attachments, any scratch folder and brand-new files still flow.",
			"A quest folder holds only its README, its JOURNEY.md (written by journal), its ID documents and attachments/ (cited charts, notes and summaries within the limits). Clones, raw data, labs, runs and builds go in the quest's scratch folder, ~/.cache/pi/agentic-harness.pi/quest-workspace/<ID>/, whose tmp/ is $TMPDIR while the quest is loaded: use $TMPDIR or mktemp for temporary files, never a path named in /tmp. Conclude and retire remove the whole scratch folder, so move what is worth keeping into attachments/ first. When a result says a call left a record out of shape, move the files where it says.",
			"Stage transitions are think → draft → build → concluded (or retired). `think` accepts a kind on a fresh loop (default plan); `draft` writes the document and mints its id; `build` lets you implement. With nothing in hand, `draft` given a note and a title thinks and drafts in one call. Concluding or retiring the focused document puts it down, and a finished document is never reopened: think or draft beside it starts a fresh loop. `think` with a kind, or `draft` with a title, beside a document in draft or build puts that one down where it stands and starts the new one; `think` with no kind sends the focused document back to think.",
			"A refused transition returns guidance and changes nothing. Nobody approves a transition and nothing prompts for one.",
		],
		parameters: QUEST_PARAMETERS,
		// pi checks what this returns against the schema next, as it
		// does for its own edit tool's rewritten arguments.
		prepareArguments: (args) =>
			withRenamedAction(args) as Static<typeof QUEST_PARAMETERS>,
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
			keepDoingSaid(state, currentSessionId(ctx, undefined), ctx.ui);
			const stage = stageTitle(params.action, state.documentId ?? params.id);
			if (stage && !params.dryRun) {
				sayDid(pi.events, {
					kind: "stage",
					where: state.questId ?? "",
					title: stage,
				});
			}
			// A session a spawn started is looked for a minute on.
			const spawned = spawnedBy(params.action, result.details);
			if (spawned) watchFirstTurn(pi, ctx, spawned);
			return {
				content: [
					{
						type: "text",
						// A tree or a listing can run long even with paging,
						// and this is the one place every action answers from.
						text: boundedByDetails(openSessionStore(ctx), {
							text: result.message,
							details: result.details,
							narrowing:
								cutReadAdvice(params as QuestToolParams) ??
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
}
