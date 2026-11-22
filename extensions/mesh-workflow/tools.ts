/**
 * The mesh's tools: send, read back, join, leave or list groups, stop
 * a peer reaching this one, end a session of this orchestration, and
 * sprout new work as a cell of its own.
 *
 * Each registers here, with its parameters and how it renders. What
 * each does lives in tools/, a file for each: send.ts and reach.ts
 * for sending, read.ts, groups.ts for joining, leaving and listing,
 * stop.ts, end.ts and sprout.ts, beside what they all act through (local.ts) and
 * how they say times and wants (said.ts).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	LOOK_KINDS,
	type Pointing,
	pointAt,
	refusalOf,
	withdrawLook,
} from "../../lib/mesh/looks/looks.ts";
import { INTENTS } from "../../lib/mesh/message.ts";
import { leasesText } from "./leases.ts";
import { refusedSection } from "./refusals.ts";
import { sendDrawing } from "./send-drawing.ts";
import { end } from "./tools/end.ts";
import {
	groupsText,
	join,
	leave,
	peersText,
	tiesText,
} from "./tools/groups.ts";
import { type Answer, answer, type Local, peers } from "./tools/local.ts";
import { NEED_GRANTS_NOTHING } from "./tools/need.ts";
import { MOST_READ, read } from "./tools/read.ts";
import { type SendParams, send, sendAcross } from "./tools/send.ts";
import { type SproutParams, sproutFrom } from "./tools/sprout.ts";
import { stop } from "./tools/stop.ts";
import { waitOnPerson } from "./wait.ts";

export type { Local } from "./tools/local.ts";

export function registerTools(
	pi: ExtensionAPI,
	local: () => Local | undefined,
	quiet: () => boolean = () => false,
): void {
	const using =
		<P>(act: (at: Local, params: P) => Answer | Promise<Answer>) =>
		async (_id: string, params: P) => {
			const at = local();
			if (!at) {
				return answer(
					"This pi is not on the mesh: it keeps no session, runs with PI_MESH=off, or has not started one yet.",
				);
			}
			at.peer.refresh();
			return act(at, params);
		};

	pi.registerTool({
		name: "mesh_send",
		label: "Mesh",
		// The always-visible tool list names only tools with a snippet. Without
		// one a session reading it after a reload concluded it had no mesh
		// tools and went through codemode; one line names the seven.
		promptSnippet:
			"Message the other pi sessions on this machine; mesh_read, mesh_groups, mesh_join, mesh_leave and mesh_stop read the mesh and shape who hears what, mesh_wait says what waits on the person, mesh_sprout starts new work as a cell of its own, and mesh_end lets an orchestrator end a session of its own.",
		description: `Send a message to other pi sessions (peers) on this machine; it joins their conversation as context. Only a question or hold put to a peer, an answer to its question or its orchestrator's pivot starts its turn; an fyi or finding is read with its next turn. Send only what changes what a peer should do (a hold before a reboot, a switch or a merge; a question only it can answer) or concerns what it owns (a finding). Never send progress, acknowledgements, thanks or word of heavy work, which the machine's queue orders by itself. Address the narrowest group that reaches everyone affected: a peer's address (5GV2AH), alone for a question to it, since everyone in a group reads what goes there; its quest's (#quest/5gv2ah, quests under it too) or repository's (#repo/agentic-harness-pi); a named group (#harness), which sending joins; or #machine, which everyone hears and which takes only holds and the answers ending them. When you don't know who holds what you need, send to need with about saying what it is about: it goes to the one live cell that works on it, found by the node's hubs and ties, and is refused, never sent to an orchestrator, when none is within reach. ${NEED_GRANTS_NOTHING} A question to several peers asks each. A message opening by naming peers ('P9R1KI: may I') goes to them alone. When the person asks to pause other sessions' work, as before a reboot, send a hold to #machine asking each peer to answer once parked, then answer it yourself with re and endsHold when work may resume; a reboot ends it too. Answering your own hold without endsHold leaves it held. A pause sent as a question or fyi leaves sessions parked. When the person says another peer's hold is over, answer it with endsHold. Leave \`to\` out and the mesh picks, saying where. mesh_groups lists the groups.`,
		parameters: Type.Object({
			to: Type.Optional(
				Type.String({
					description:
						"Comma-separated groups: peer addresses such as P9R1KI, groups such as #harness, need for the live cell that works on what it is about, orchestrator for the orchestrator above this peer's quest (or, where its quest has none, its hub from use: the live cell above it is most tied to, an address only), or machine. Leave it out and the mesh picks, saying where and why",
				}),
			),
			intent: StringEnum(INTENTS, {
				description:
					"hold: put off something until you say it is over; question: wants an answer; finding: for whoever owns what it is about, saying what you checked it against; fyi: context only; pivot: an orchestrator changing what its sessions do, each answering once it has",
			}),
			text: Type.String({
				description: "The message, plain and short, standing on its own",
			}),
			re: Type.Optional(
				Type.String({
					description:
						"The id of the message this answers, as shown in brackets beside it, such as 2f95756a",
				}),
			),
			supersedes: Type.Optional(
				Type.String({
					description:
						"The id of a message this peer sent that this one withdraws or corrects; it goes wherever that one went",
				}),
			),
			endsHold: Type.Optional(
				Type.Boolean({
					description:
						"true when the hold named by re is over: your own, as you end it, or another peer's only when the person has told you it is, which ends once they confirm, never on your own judgement",
				}),
			),
			realm: Type.Optional(
				Type.String({
					description:
						"Another realm to send into by address, such as work, as an fyi, finding or question; only realms this node has a flow to, and nothing there can answer back. Leave it out for this realm",
				}),
			),
			about: Type.Optional(
				Type.String({
					description:
						"With need in to: what the need is about, in a few words of the work, such as 'mycelium carry'; matched against what each cell works on. Left out, the text's words are used",
				}),
			),
		}),
		execute: using((at, params: SendParams) =>
			params.realm?.trim() ? sendAcross(at, params) : send(at, params),
		),
		// Under /mesh quiet the session's own sends leave the screen too.
		...sendDrawing(quiet),
	});

	pi.registerTool({
		name: "mesh_read",
		label: "Mesh",
		description:
			"Read the latest messages this peer hears on the mesh, and what it sent, to catch up after a reload or compaction, or to read a glance in full. With unanswered, list instead every question on the mesh, from any peer, still waiting on a peer it was put to, oldest first with its age, to see which sessions are stuck; an orchestrator sees those of its own orchestration.",
		parameters: Type.Object({
			count: Type.Optional(
				Type.Number({
					description: `How many of the latest to show; default 15, at most ${MOST_READ}`,
				}),
			),
			before: Type.Optional(
				Type.String({
					description:
						"A message's id, as shown in brackets: read only what came before it, to read on where an answer stopped",
				}),
			),
			unanswered: Type.Optional(
				Type.Boolean({
					description:
						"true to list every question on the mesh still waiting on an answer from a peer it named, from the last two hours, rather than the latest messages",
				}),
			),
		}),
		execute: using(read),
	});

	pi.registerTool({
		name: "mesh_join",
		// Called in 2 of 40 sessions from 18 October: loaded on demand.
		exposure: "deferred",
		label: "Mesh",
		description:
			"Join a mesh group, so this peer hears what is sent to it and to the groups it is part of, and bring other peers into it without asking them. This peer is already in its quest's and repository's groups. Join, or make, a group for work shared beyond those (#harness, #optimus/power), not every group there is; join a peer's address to follow its home group.",
		parameters: Type.Object({
			group: Type.String({
				description:
					"A group such as #harness, a part of one such as #optimus/power, or a peer's address. A named group nobody is in yet is made by joining it.",
			}),
			invite: Type.Optional(
				Type.String({
					description:
						"Comma-separated addresses of peers to bring into a named group too; each is told, and is in it from then on until it leaves",
				}),
			),
			why: Type.Optional(
				Type.String({
					description: "What the group is for, said to those invited",
				}),
			),
		}),
		execute: using(join),
	});

	pi.registerTool({
		name: "mesh_leave",
		// Called in 1 of 40 sessions from 18 October: loaded on demand.
		exposure: "deferred",
		label: "Mesh",
		description:
			"Leave a mesh group this peer joined and no longer works on, so its messages stop reaching it. The groups its work puts it in are left with the work.",
		parameters: Type.Object({
			group: Type.String({ description: "The group to leave" }),
		}),
		execute: using(leave),
	});

	pi.registerTool({
		name: "mesh_stop",
		// Called in 1 of 40 sessions from 18 October: loaded on demand.
		exposure: "deferred",
		label: "Mesh",
		description:
			"Stop a peer reaching this one, when what it sends keeps costing this peer more than it gives. Until this peer lifts it, the stopped peer's messages reach it only as one-line glances, never in full and never as a turn, and its sends to this peer's home group are refused. The stopped peer is told, with why. Only this peer can lift it.",
		parameters: Type.Object({
			peer: Type.String({ description: "The address of the peer to stop" }),
			why: Type.Optional(
				Type.String({ description: "Why, said to the stopped peer" }),
			),
			lift: Type.Optional(
				Type.Boolean({
					description: "Lift a stop this peer set instead of setting one",
				}),
			),
		}),
		execute: using(stop),
	});

	pi.registerTool({
		name: "mesh_end",
		// For an orchestrator alone: loaded on demand.
		exposure: "deferred",
		label: "Mesh",
		description:
			"End a session of this orchestration, by its address, once it is no longer needed: its pi is asked to quit, as a closed window would, and the window it is shown in closes with it. Only the session playing an orchestrator's role may, only for sessions whose quests it orchestrates on this machine, and a turn running there ends with it. A session whose quest is concluded or retired ends itself, so this is for the rest.",
		parameters: Type.Object({
			peer: Type.String({
				description: "The address of the session to end, such as 5GV2AH",
			}),
		}),
		execute: using(end),
	});

	pi.registerTool({
		name: "mesh_wait",
		// Declared in 72 sessions from 9 November and called in 3: loaded
		// on demand, its 2,900 characters read only by a session that asks.
		exposure: "deferred",
		label: "Mesh",
		description:
			"Say that this session's quest has something waiting on the person that only they can do (a login, a look, a decision, a yes), or that it no longer waits. It shows in the launcher's Needs You and outlives this session. Every item says how it will be known done (doneWhen), so it can clear itself: a check the desktop's daemon runs, a signal it hears, or the person saying so where nothing else can tell. An item is ready at once unless readyWhen says what it waits for; ready raises a notice. The answer says when no daemon judges checks and signals yet, and then the item moves on only when you say it again. A switch signal with a commit means a switch to that commit or past it. Say it again with the same id to change it, and with done: true to settle it sooner.",
		parameters: Type.Object({
			id: Type.String({
				description:
					"A short name for the item within this quest, such as eero-login, used to change or settle it",
			}),
			title: Type.Optional(
				Type.String({ description: "What they are to do, in a few words" }),
			),
			why: Type.Optional(
				Type.String({ description: "Why it needs them rather than an agent" }),
			),
			minutes: Type.Optional(
				Type.Integer({ description: "How many minutes it takes them" }),
			),
			when: Type.Optional(
				Type.String({
					description:
						"When they can do it, in words: now, tonight, after 08:00. Say the time itself with at",
				}),
			),
			ready: Type.Optional(
				Type.Boolean({
					description:
						"Whether they can do it now, raising a notice. Defaults to true unless readyWhen is given",
				}),
			),
			doneWhen: Type.Optional(
				Type.Object(
					{
						check: Type.Optional(Type.String()),
						signal: Type.Optional(Type.String()),
						by: Type.Optional(Type.Literal("person")),
					},
					{
						description:
							'How it will be known done, required for a new item: exactly one of check (a command that succeeds once it is done, stopped after 90 seconds, so bound its own network calls under that), signal ("boot", "switch", "switch:<core commit>" for a switch to it or past it, "device:<name>" or "file:<absolute path>"), or by: "person" where nothing else can tell',
					},
				),
			),
			readyWhen: Type.Optional(
				Type.Object(
					{
						check: Type.Optional(Type.String()),
						signal: Type.Optional(Type.String()),
						by: Type.Optional(Type.Literal("person")),
					},
					{
						description:
							"What it waits for before they can do it, in doneWhen's form; leave it out when they can do it now",
					},
				),
			),
			at: Type.Optional(
				Type.String({ description: "The time it is for, as an ISO time" }),
			),
			deadline: Type.Optional(
				Type.String({
					description: "The time it must be done by, as an ISO time",
				}),
			),
			machine: Type.Optional(
				Type.String({ description: "The machine it is done at, by name" }),
			),
			steps: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"What they do, step by step, a few words each; required for a new item",
				}),
			),
			done: Type.Optional(
				Type.Boolean({ description: "It no longer waits: settles the item" }),
			),
		}),
		execute: using((at, params: Parameters<typeof waitOnPerson>[1]) => {
			if (!at.waiting) {
				return answer(
					"Nothing was kept: this pi keeps no folder for what waits on the person.",
				);
			}
			const outcome = waitOnPerson(at.waiting, params);
			return answer(outcome.text, {
				written: outcome.written,
				items: outcome.items,
			});
		}),
	});

	pi.registerTool({
		name: "show_person",
		label: "Mesh",
		promptSnippet:
			"Point the person at something to look at (a PR, a page, a file, a diff, a terminal): it goes on their look list, never opened for them.",
		description:
			"Point the person at something to look at: a pull request, a page, a file, a diff or a session's terminal. It goes on their look list in the launcher, newest first, where they open it in its place or clear it; nothing opens by itself. It stays until they do, through reboots, apart from notices and Needs You, naming this session, what it is and why they should look. A look that asks nothing back (an ask of 'Nothing, just to see', and no choices) leaves once they open it, or a day on, and you are told. Pointing at the same thing again from this session or another on its quest replaces the look in its place rather than adding it twice: a pull request's tabs and diffs count as the pull request, and a page's fragment as the page. Use it whenever you would otherwise tell them a link or a path to go and find. Write title, why and ask for the person reaching it hours later, in plain words: no message or quest ids, session addresses, paths or code. When it no longer applies (the question was answered, the work moved on), take it back with withdraw.",
		parameters: Type.Object({
			kind: StringEnum([...LOOK_KINDS], {
				description:
					"What it opens: pr or page (a URL, in their browser), file or diff (a file's absolute path, or a diff's URL, in their editor), terminal (a session's window)",
			}),
			target: Type.String({
				description:
					"What opens: the URL, the file's absolute path, or the session's id",
			}),
			title: Type.Optional(
				Type.String({ description: "What it is, in a few words" }),
			),
			why: Type.Optional(
				Type.String({
					description:
						"Why they should look, in a sentence: what happened, for him",
				}),
			),
			ask: Type.Optional(
				Type.String({
					description:
						"What they're asked to do, with the choices, e.g. 'Say whether the bar reads right at your width: keep it or roll it back', or 'Nothing, just to see'",
				}),
			),
			choices: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"When the ask wants a word back, its answers as short labels (at most 4, a few words each), e.g. ['Keep it', 'Roll it back']: the person picks one where they are, and it comes back to this session, or the one on its quest, as a message",
				}),
			),
			thread: Type.Optional(
				Type.String({
					description:
						"A label of yours that folds looks whatever they open, e.g. the mesh question's id they serve: a later look on the same thread replaces the earlier one. Never shown to the person",
				}),
			),
			withdraw: Type.Optional(
				Type.Boolean({
					description:
						"true to take back the look at kind and target that this session, or an earlier one on its quest, put up, opened or not, since it no longer applies; title, why and ask are then left out",
				}),
			),
		}),
		execute: using((at, params: ShowPersonParams) => {
			if (!at.looks) {
				return answer(
					"Nothing was kept: this pi keeps no folder for the person's look list.",
				);
			}
			const quest = at.presences.of(at.peer.session)?.quest;
			if (params.withdraw === true) {
				const took = withdrawLook(
					at.looks,
					{ session: at.peer.session, ...(quest ? { quest } : {}) },
					params.kind,
					params.target,
				);
				return answer(
					took
						? "Taken back: it's off the person's look list."
						: "Nothing to take back: neither this session nor its quest has a look standing at that.",
					{ withdrawn: took },
				);
			}
			const pointing: Pointing = {
				kind: params.kind,
				target: params.target,
				title: params.title ?? "",
				why: params.why ?? "",
				ask: params.ask ?? "",
				...(params.choices ? { choices: params.choices } : {}),
				...(params.thread ? { thread: params.thread } : {}),
			};
			const refused = refusalOf(pointing);
			if (refused) return answer(`⊘ ${refused} Nothing was added.`);
			const look = pointAt(at.looks, pointing, {
				session: at.peer.session,
				address: at.peer.signature,
				...(quest ? { quest } : {}),
			});
			return answer(
				`On the person's look list: ${look.title}. ${look.asks ? "It stays there until they answer or clear it, its quest ends, or this session takes it back with withdraw once it no longer applies." : "It asks nothing back, so it leaves once they open it, or in a day."}${look.choices ? " What they pick comes back as a message." : ""}`,
				{ look },
			);
		}),
	});

	pi.registerTool({
		name: "mesh_sprout",
		// New: loaded on demand until sessions are seen to call it.
		exposure: "deferred",
		label: "Mesh",
		description:
			"Start new work as a cell of its own, in one step: words or a link (a PR, an issue, a Slack thread) go to the node, which starts a new pi session in the work's repository, on this machine or the one named. That session makes its own top-level quest, or joins a live quest already holding the work beside whoever works there, and asks the map to tie it to this one; the tie is there only once the map shows it. Use it when the person says to start, branch out or hand off a piece of work rather than do it here. Nothing opens on their screen: the answer says how to reach it.",
		parameters: Type.Object({
			words: Type.String({
				description:
					"The work: a link alone, or the person's words for it, which the new session reads first",
			}),
			folder: Type.Optional(
				Type.String({
					description:
						"The repository's folder it works in; left out, the link's repository under ~/src, else this session's folder when it is a repository. Never home",
				}),
			),
			machine: Type.Optional(
				Type.String({
					description:
						"The machine it starts on, by its mycelium node's name; left out, this one",
				}),
			),
		}),
		execute: (_id, params: SproutParams, signal, _onUpdate, ctx) => {
			// Refreshed first, as every mesh tool is, so --from names this
			// session as it stands now.
			const at = local();
			at?.peer.refresh();
			return sproutFrom(params, ctx.cwd, at?.peer.signature, undefined, signal);
		},
	});

	pi.registerTool({
		name: "mesh_groups",
		label: "Mesh",
		description:
			"List the peers on the mesh and what each works on, the groups, who is in each, and which this peer is in, the leases peers hold (what each is changing, answering, holding or waiting on, and the heavy work it runs or waits its turn for in the machine's queue), and the peers this one is tied to by who has talked with whom in the last day, strongest first.",
		parameters: Type.Object({}),
		execute: using(async (at) => {
			const [standing, ties] = await Promise.all([peers(at), at.ties?.()]);
			return answer(
				`${groupsText(standing, at.peer)}${refusedSection(standing.present, at.presences.refusal)}${peersText(standing.present, at.peer, Date.now(), standing.resuming)}${leasesText(at.board.all(), standing.present, Date.now(), at.queue?.())}${tiesText(ties, standing.present)}`,
				{ groups: at.peer.groups },
			);
		}),
	});
}

/** What show_person is called with: a pointing, or a withdraw of one. */
interface ShowPersonParams {
	readonly kind: Pointing["kind"];
	readonly target: string;
	readonly title?: string;
	readonly why?: string;
	readonly ask?: string;
	readonly choices?: readonly string[];
	readonly thread?: string;
	readonly withdraw?: boolean;
}
