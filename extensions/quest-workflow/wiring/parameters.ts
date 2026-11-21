/**
 * The quest tool's arguments: each one's name, type and what it means
 * to each action. They change when an action takes a new argument or
 * an old one comes to mean more.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { QUEST_ACTIONS } from "../actions.ts";

/** The quest tool's arguments, which pi checks each call against. */
export const QUEST_PARAMETERS = Type.Object({
	action: StringEnum([...QUEST_ACTIONS], {
		description:
			"The action. `status` is `show`, which given a document's id answers its outline: sections and sizes, open items, the next.",
	}),
	id: Type.Optional(
		Type.String({
			description:
				"The quest or document, loaded or not (default: the focused document, else the README); comma-separated for reparent, conclude, retire and reopen-sessions. conclude/retire: the loaded quest's id seals it, trees pruned; another quest's id sweeps its status and removes its whole scratch folder (undo restores only status and priority); a document's id ends just that. locate: any quest, document, alias or session id. undo: reverses this session's newest change.",
		}),
	),
	url: Type.Optional(
		Type.String({
			description:
				"create: seed the quest from a Slack thread, GitHub PR or issue URL.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description:
				"create: the quest's title (its H1). draft: the document's. section: the heading to replace or add (a README's optional Milestones, Spirit, Outcomes or Context), no emoji. retitle: `id`'s new H1. show: the section to read.",
		}),
	),
	parent: Type.Optional(
		Type.String({
			description:
				"create: the parent quest, for a subquest. reparent: the new parent, or `null` for top level.",
		}),
	),
	kind: Type.Optional(
		Type.String({
			description:
				"create, reclassify: quest, subquest or sidequest. think, or draft over think's choice: plan, research, brief or report.",
		}),
	),
	note: Type.Optional(
		Type.String({
			description:
				"think: what the document is about, or what sent it back. create: Summary prose. journal: the Journey entry, dated for you. spawn: what the new session is for, told it first.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"section: the section's new text, without its heading or any `## ` heading.",
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
				"create: driving, active (default), queued, bench or someday. find: filter by it.",
		}),
	),
	status: Type.Optional(
		Type.String({
			description: "find: active, paused, blocked, concluded or retired.",
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
				"alias-add/remove: comma-separated `type:value` (e.g. `github-pr:shop/world#47281`). need-add/remove: comma-separated kind=value, as needs. budget: a provider's name, `none` or `inherit`; left out, it says which. tree-expand: the zone (e.g. system/gitstream).",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"find: text matched in titles, ids, bodies and aliases. locate: what to resolve without `id`. tick/untick/show: an item by its number, text or start; show also takes words no item reads, listing the lines that hold them (`a|b` for either).",
		}),
	),
	since: Type.Optional(
		Type.String({
			description: "find: on or after this date (YYYY-MM-DD or ISO).",
		}),
	),
	until: Type.Optional(
		Type.String({
			description: "find: on or before this date.",
		}),
	),
	role: Type.Optional(
		Type.String({
			description:
				"who: Cast bullets by role (owner, reviewer, originator, ...).",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"who: Cast bullets by name. session-attach/rename: the session's label.",
		}),
	),
	layout: Type.Optional(
		Type.String({
			description:
				"spawn, reopen-sessions: window, tab or pane (default: the person's setting, else tab).",
		}),
	),
	terminal: Type.Optional(
		Type.String({
			description:
				"spawn, reopen-sessions: kitty, wezterm, tmux, zellij, foot, alacritty, ghostty or one configured.",
		}),
	),
	host: Type.Optional(
		Type.String({
			description:
				"spawn: attended or background, to open it in the shared pi host, not a terminal; left out, the spawnHost setting decides (off by default).",
		}),
	),
	nesting: Type.Optional(
		Type.String({
			description:
				"spawn, reopen-sessions: in nested terminals, innermost (default) or outermost.",
		}),
	),
	machine: Type.Optional(
		Type.String({
			description:
				"spawn: the machine to start on, by its mycelium node's name; it starts held there and the window here joins it.",
		}),
	),
	needs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"spawn: what the machine must be, kind=value (machine, system, arch, reach, accelerator), e.g. reach=home; the node picks one.",
		}),
	),
	fence: Type.Optional(
		Type.String({
			description:
				"spawn: fence or strict, the fence the session tells the node it runs in (left out: the quest's, else strict); fence may start it on another machine under a strict parent. need-add: the quest's own, which its spawns declare; need-remove with fence clears it. Declare fence only when both hold: (1) it needs none of optimus's own credentials: its TPM keys, the agents' proxy, or Joel's gcloud or World push; (2) its work reads no stranger's text: other people's PRs and issues, Slack, email, or web pages beyond docs. Strict when unsure.",
		}),
	),
	command: Type.Optional(
		Type.String({
			description:
				"spawn: the command (default `pi`). It runs past every guard, so spawn only what the user authorized.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Where spawn starts (default: a reopened session's folder, else the quest's newest tree), the repo tree-add cuts from, a path tree-adopt registers, or the tree tree-release and tree-expand act on.",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description: "session-*: another session than this one.",
		}),
	),
	field: Type.Optional(
		Type.String({
			description:
				"find: the date since/until read: started, updated (default), due or eta.",
		}),
	),
	refType: Type.Optional(
		Type.String({
			description: "find: quests with an alias of this type (e.g. github-pr).",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description: "links: text in the link's value or URL.",
		}),
	),
	scope: Type.Optional(
		Type.String({
			description:
				"conclude/retire: 'quest' or 'document', over what the id implies; with no id, the focused document.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"tree-release: override its refusals, losing uncommitted work: confirm with the person first. section: let a body drop most of a large section. reopen-sessions: reopen the lost sessions rather than list them; confirm first too.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description:
				"Say what would change, doing nothing: reparent, spawn, reopen-sessions, budget-sweep, conclude/retire of quests not loaded here. Others refuse it.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "list/find/who: most rows (default 25).",
			minimum: 1,
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			description: "list/find/who: rows to skip, to page with limit.",
			minimum: 0,
		}),
	),
});
