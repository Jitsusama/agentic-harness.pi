/**
 * The mesh's tools: send, read back, join, leave or list groups, stop
 * a peer reaching this one, and end a session of this orchestration.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { endSession } from "../../lib/core/session/index.ts";
import type { QueueRecord } from "../../lib/internal/priority/folder.ts";
import {
	type TickedOwner,
	tickedStanding,
} from "../../lib/internal/process-ticks.ts";
import { answeringTo, namedAtStart } from "../../lib/mesh/address.ts";
import { endTarget } from "../../lib/mesh/end.ts";
import type { CrossAnswer, Crossed, Crossing } from "../../lib/mesh/flow.ts";
import {
	ALL,
	groupNamed,
	groupsNamed,
	hears,
	homeOf,
	isJoinable,
	MACHINE,
	machineTakes,
	orchestratorNamed,
} from "../../lib/mesh/group.ts";
import { closeThroughHost, hostedHere } from "../../lib/mesh/host-close.ts";
import { type Board, isCurrent, othersOn } from "../../lib/mesh/lease.ts";
import { type Census, census } from "../../lib/mesh/liveness.ts";
import {
	LOOK_KINDS,
	type Pointing,
	pointAt,
	refusalOf,
	withdrawLook,
} from "../../lib/mesh/looks.ts";
import {
	clock,
	heading,
	INTENTS,
	line,
	type Message,
	reaches,
	senderIdentity,
	shortId,
} from "../../lib/mesh/message.ts";
import type { Peer } from "../../lib/mesh/peer.ts";
import { pivotTargets } from "../../lib/mesh/pivot.ts";
import type { Presence, Presences } from "../../lib/mesh/presence.ts";
import { type Judge, type Route, routeOf } from "../../lib/mesh/routing.ts";
import { stoppedBy } from "../../lib/mesh/stop.ts";
import {
	idNamed,
	mayReplace,
	type Reader,
	type Self,
	sentBy,
} from "../../lib/mesh/thread.ts";
import type { Transport } from "../../lib/mesh/transport.ts";
import {
	UNANSWERED_WITHIN_MS,
	unanswered,
	withinOrchestration,
} from "../../lib/mesh/unanswered.ts";
import type { WantKind } from "../../lib/mesh/want.ts";
import { count } from "../../lib/ui/count.ts";
import { leasesText } from "./leases.ts";
import {
	type Refusal,
	refusedMark,
	refusedNotes,
	refusedSection,
} from "./refusals.ts";
import { sendDrawing } from "./send-drawing.ts";
import { type Waiting, waitOnPerson } from "./wait.ts";

/** The most messages one mesh_read hands back. */
const MOST_READ = 50;

/**
 * The most one mesh_read answer spends on messages, newest kept first.
 * Messages are short by request, yet with their receipts fifty came to
 * 30 KB, and seven answers between 24 and 26 October ran past 20 KB.
 * What is left out is read on with `before`, rather than stored.
 */
const READ_BUDGET_BYTES = 12_288;

/** What the tools act through, once the session has started. */
export interface Local {
	readonly peer: Peer;
	readonly transport: Transport;
	readonly presences: Presences;
	/** The leases every peer holds (see lib/mesh/lease.ts). */
	readonly board: Board;
	/** The classifier, for routing a message that names no group. */
	readonly route?: Judge;
	/** The machine queue's jobs, while some session keeps it. */
	readonly queue?: () => QueueRecord["jobs"] | undefined;
	/** The realms the node lets this one send to (see lib/mesh/flow.ts). */
	readonly flows?: () => Promise<readonly string[]>;
	/** Hand a message to the node to send into another realm. */
	readonly cross?: (crossing: Crossing) => Promise<CrossAnswer>;
	/** Note a message this peer sent, so it is never handed back to it. */
	sent(message: Message): void;
	/**
	 * Ask the person to confirm ending another peer's hold on their word:
	 * why it may not be sent, or nothing once it may (see end-hold.ts).
	 */
	confirmEnd?(hold: Message, text: string): Promise<string | undefined>;
	/** Where what waits on the person is kept (see wait.ts). */
	readonly waiting?: Waiting;
	/** Where what sessions point the person at is kept (lib/mesh/looks.ts). */
	readonly looks?: string;
	/** Ask a session's process to end; pi's own SIGTERM by default. */
	readonly endProcess?: EndProcess;
}

/**
 * Asks the process a presence names to end, once it is sure it is that
 * one, saying `by` asked, for a host's journal.
 */
export type EndProcess = (
	owner: TickedOwner,
	by: string,
) => Promise<"ended" | "gone" | "unsure">;

/** What mesh_send hands back beside its words. */
export interface SendDetails {
	readonly sent: boolean;
	/** The homes it was not written to, of peers that stopped this one. */
	readonly refused?: readonly string[];
	/** Where the mesh sent it, and why, when the sender named no group. */
	readonly routed?: Route;
	readonly message?: Message;
	/** The peers it goes to, by the address each signs with. */
	readonly reached?: readonly string[];
	/** The peers it was addressed to whose sessions have ended. */
	readonly gone?: readonly string[];
	/** What crossed into another realm, as the node sent it. */
	readonly crossed?: Crossed;
	/** Why the node refused a crossing, as it said it. */
	readonly crossRefused?: { readonly code: string; readonly why: string };
}

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
			"Message the other pi sessions on this machine; mesh_read, mesh_groups, mesh_join, mesh_leave and mesh_stop read the mesh and shape who hears what, mesh_wait says what waits on the person, and mesh_end lets an orchestrator end a session of its own.",
		description:
			"Send a message to other pi sessions (peers) on this machine; it joins their conversation as context. Only a question or hold put to a peer, an answer to its question or its orchestrator's pivot starts its turn; an fyi or finding is read with its next turn. Send only what changes what a peer should do (a hold before a reboot, a switch or a merge; a question only it can answer) or concerns what it owns (a finding). Never send progress, acknowledgements, thanks or word of heavy work, which the machine's queue orders by itself. Address the narrowest group that reaches everyone affected: a peer's address (5GV2AH), alone for a question to it, since everyone in a group reads what goes there; its quest's (#quest/5gv2ah, quests under it too) or repository's (#repo/agentic-harness-pi); a named group (#harness), which sending joins; or #machine, which everyone hears and which takes only holds and the answers ending them. A question to several peers asks each. A message opening by naming peers ('P9R1KI: may I') goes to them alone. When the person asks to pause other sessions' work, as before a reboot, send a hold to #machine asking each peer to answer once parked, then answer it yourself with re and endsHold when work may resume; a reboot ends it too. Answering your own hold without endsHold leaves it held. A pause sent as a question or fyi leaves sessions parked. When the person says another peer's hold is over, answer it with endsHold. Leave `to` out and the mesh picks, saying where. mesh_groups lists the groups.",
		parameters: Type.Object({
			to: Type.Optional(
				Type.String({
					description:
						"Comma-separated groups: peer addresses such as P9R1KI, groups such as #harness, orchestrator for the orchestrator above this peer's quest, or machine. Leave it out and the mesh picks, saying where and why",
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
		name: "mesh_groups",
		label: "Mesh",
		description:
			"List the peers on the mesh and what each works on, the groups, who is in each, and which this peer is in, and the leases peers hold: what each is changing, answering, holding or waiting on, and the heavy work it runs or waits its turn for in the machine's queue.",
		parameters: Type.Object({}),
		execute: using(async (at) => {
			const standing = await peers(at);
			return answer(
				`${groupsText(standing, at.peer)}${refusedSection(standing.present, at.presences.refusal)}${peersText(standing.present, at.peer, Date.now())}${leasesText(at.board.all(), standing.present, Date.now(), at.queue?.())}`,
				{ groups: at.peer.groups },
			);
		}),
	});
}

type Answer = ReturnType<typeof answer>;

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

/**
 * Every peer, answering only to its own addresses, sorted by whether
 * it is still on the mesh.
 */
function peers(at: Local): Promise<Census> {
	const everyone = at.presences.all();
	return census(
		everyone.map((one) => ({
			...one,
			addresses: answeringTo(one, everyone),
		})),
	);
}

/**
 * The hold a send ends on the person's word, or why it ends none: only
 * another peer's hold can be, since this peer ends its own itself.
 */
function endedOnWord(
	at: Local,
	asked: boolean | undefined,
	re: string | undefined,
): { hold?: Message; why?: string } {
	if (!asked) return {};
	const hold = re ? at.transport.read(re) : undefined;
	if (hold?.intent !== "hold") {
		return {
			why: `${re ? `[${re.slice(re.lastIndexOf("-") + 1)}]` : "what it answers"} is no other peer's hold, so endsHold was left out`,
		};
	}
	// This peer's own hold is its to end, with no word to confirm.
	if (sentBy(hold, { addresses: at.peer.addresses, ...senderIdentity() })) {
		return {};
	}
	return { hold };
}

/** Why a note on this peer's own hold went answering nothing. */
function keptSaid(kept: Message): string {
	const id = shortId(kept);
	return `[${id}] is this peer's own hold, and answering it ends it for every peer it parked, so re was left out and it still holds: to end it, answer it with endsHold true; to change what it holds, replace [${id}] with supersedes`;
}

/**
 * This peer's own hold that a send answers without saying it ends it.
 * Answering its own hold ends it for every peer it parked, so that is
 * done only when the send says so with endsHold: on 12 November a
 * holder's note that a small push was fine during its hold answered it
 * with re, and ended it in the middle of the person's calls.
 */
function ownHoldKept(
	at: Local,
	named: string | undefined,
	ends: boolean | undefined,
	self: Self,
): Message | undefined {
	if (ends || named === undefined) return undefined;
	const answered = at.transport.read(named);
	return answered?.intent === "hold" && sentBy(answered, self)
		? answered
		: undefined;
}

/**
 * The intent a send goes with, and why when it is not the one asked: a
 * hold that answers a hold goes as an fyi. Answering this peer's own
 * hold ends it, so sent as a hold the end would put everyone off again
 * for two hours; and an answer to another peer's hold is news for its
 * sender, where a hold would park everyone it reached. Twice on 7
 * November an end of 85PKB2's went as a hold, and sessions woken hours
 * later answered it as one to park on. A hold that replaces this peer's
 * own (supersedes) stays one, since that is how a hold changes its words.
 */
export function answeringIntent(
	asked: Message["intent"],
	answered: Message | undefined,
	self: { readonly addresses: readonly string[]; readonly pid: number },
	replacing: Message | undefined,
): { intent: Message["intent"]; why?: string } {
	if (asked !== "hold" || answered?.intent !== "hold" || replacing) {
		return { intent: asked };
	}
	const id = shortId(answered);
	return {
		intent: "fyi",
		why: sentBy(answered, self)
			? `it answers [${id}], this peer's own hold, so it went as an fyi rather than a new hold; to hold on in other words, replace [${id}] with supersedes`
			: `it answers [${id}], another peer's hold, so it went as an fyi: a hold would park everyone it reached; send a hold of this peer's own without re`,
	};
}

/** Whether the mesh's own routing, not the sender, picked the groups. */
function routedWide(
	routed: Route | undefined,
	aimed: readonly string[] | undefined,
	chosen: readonly string[],
): boolean {
	return routed !== undefined && aimed === undefined && chosen.length === 0;
}

/** What mesh_send is asked. */
interface SendParams {
	readonly to?: string;
	readonly intent: Message["intent"];
	readonly text: string;
	readonly re?: string;
	readonly supersedes?: string;
	readonly endsHold?: boolean;
	readonly realm?: string;
}

/**
 * Why a send may not answer `re`, when it names a message that crossed
 * from another realm: nothing said here reaches back there, so an answer
 * would be written where nobody who asked could read it.
 */
function crossedAnswerRefused(
	at: Local,
	re: string | undefined,
): Answer | undefined {
	const asked = re ? at.transport.read(re) : undefined;
	if (!asked?.fromRealm) return undefined;
	return answer(
		`Not sent: [${shortId(asked)}] crossed from the ${asked.fromRealm} realm, and nothing said on the mesh reaches back there, so it can't be answered. If it needs an answer, tell the person in your reply.`,
		{ sent: false } satisfies SendDetails,
	);
}

/**
 * Send into another realm through the machine's node, which alone may
 * carry it, and only along a flow it was told of. Refused here when no
 * flow goes there, and otherwise refused by the node as it says, never
 * dropped without a word. Nothing is written into this realm's mesh.
 */
async function sendAcross(at: Local, params: SendParams): Promise<Answer> {
	const realm = params.realm?.trim() ?? "";
	const flows = (await at.flows?.()) ?? [];
	if (!flows.includes(realm) || !at.cross) {
		return answer(
			`Not sent: this realm's node has no flow to ${realm}, so nothing sent here reaches it. ${flowsText(flows)}`,
			{ sent: false, refused: [realm] } satisfies SendDetails,
		);
	}
	const to = groupsNamed(params.to ?? "");
	if (to.length === 0) {
		return answer(
			`Not sent: a message to the ${realm} realm goes to peers there by address, and the mesh can't pick them from here. Name them with to.`,
			{ sent: false } satisfies SendDetails,
		);
	}
	const re = params.re ? (messageNamed(at, params.re) ?? params.re) : undefined;
	const refused = crossedAnswerRefused(at, re);
	if (refused) return refused;
	const sent = await at.cross({
		realm,
		from: at.peer.signature,
		to,
		intent: params.intent,
		text: params.text,
		...(re ? { re } : {}),
	});
	if (!sent.ok) {
		return answer(`Not sent: the node refused it (${sent.code}): ${sent.why}`, {
			sent: false,
			crossRefused: { code: sent.code, why: sent.why },
		} satisfies SendDetails);
	}
	const { crossed } = sent;
	const left = [
		params.supersedes ? "supersedes" : "",
		params.endsHold ? "endsHold" : "",
	].filter(Boolean);
	const notes = [
		`It went to the ${realm} realm through this machine's node, and no copy is kept here.`,
		crossed.intent === "question"
			? "Nothing there can answer it on the mesh, so wait on no answer."
			: "",
		left.length > 0
			? `${left.join(" and ")} can't cross, so ${left.length === 1 ? "it was" : "they were"} left out.`
			: "",
	].filter(Boolean);
	return answer(
		`Sent to the ${realm} realm as ${crossed.from}: [${shortId(crossed)}] ${crossed.intent} to ${crossed.to.join(", ")}: ${crossed.text}\n${notes.join(" ")}`,
		{ sent: true, crossed } satisfies SendDetails,
	);
}

/** Which realms this one may send to, as a refusal says it. */
function flowsText(flows: readonly string[]): string {
	return flows.length === 0
		? "Its node lets it send to no other realm."
		: `Its node lets it send to ${flows.join(" and ")}: pass that as realm, with the peers there by address.`;
}

/**
 * The id a message was named by, as written: looked for among the last
 * hours' first, since that is where nearly every answer's question is,
 * and in the whole week only when not found there.
 */
function messageNamed(at: Local, written: string): string | undefined {
	return (
		idNamed(written, at.transport.recentIds()) ??
		idNamed(written, at.transport.ids())
	);
}

async function send(at: Local, params: SendParams): Promise<Answer> {
	const self = { addresses: at.peer.addresses, ...senderIdentity() };
	const reNamed = params.re ? messageNamed(at, params.re) : undefined;
	// Left without re, a holder's note about its own hold leaves it held.
	const kept = ownHoldKept(at, reNamed, params.endsHold, self);
	const answersNamed = kept ? undefined : reNamed;
	const crossedAnswer = crossedAnswerRefused(at, answersNamed);
	if (crossedAnswer) return crossedAnswer;

	const ended = endedOnWord(at, params.endsHold, answersNamed);
	if (ended.hold) {
		const refused = at.confirmEnd
			? await at.confirmEnd(ended.hold, params.text)
			: "nobody here can confirm it is the person's word.";
		if (refused !== undefined) {
			return answer(`Not sent: ${refused}`, {
				sent: false,
			} satisfies SendDetails);
		}
	}
	const supersedes = params.supersedes
		? messageNamed(at, params.supersedes)
		: undefined;
	const replaced = supersedes ? at.transport.read(supersedes) : undefined;
	// A send is never refused for how it was written: what does not hold
	// is left out and said, and the message goes on without it.
	const ownReplaced = replaced && sentBy(replaced, self) ? replaced : undefined;
	const intent = answeringIntent(
		params.intent,
		kept ?? (answersNamed ? at.transport.read(answersNamed) : undefined),
		self,
		ownReplaced,
	);
	const target = orchestratorNamed(params.to ?? "", at.peer.orchestratedBy);
	const named = groupsNamed(target.to);
	// Meant for one recipient that is not there: routed by rule, it would
	// land in a group that may have nobody listening.
	if (target.missing && named.length === 0) {
		return answer(
			"Not sent: no orchestrator is above this peer's quest. Tell the person in your reply, or name the peers it is for by address.",
			{ sent: false } satisfies SendDetails,
		);
	}
	const unnamed = named.filter((group) => groupNamed(group) === undefined);
	const said = [
		target.missing
			? "no orchestrator is above this peer's quest, so `orchestrator` reached nobody and was left out"
			: "",
		params.re && !answersNamed
			? `no message has the id ${params.re}, so it answers nothing`
			: "",
		params.supersedes && !replaced
			? `no message has the id ${params.supersedes}, so it replaces nothing`
			: "",
		replaced && !ownReplaced
			? `${params.supersedes} was sent by ${replaced.from}, and only a message's sender may replace it, so it replaces nothing`
			: "",
		unnamed.length > 0
			? `${unnamed.join(", ")} cannot be a group, so it was left out`
			: "",
		ended.why ?? "",
		kept ? keptSaid(kept) : "",
		intent.why ?? "",
	].filter(Boolean);
	const notes: string[] =
		said.length > 0
			? [
					`${capitalized(said.join("; "))}. mesh_read shows each message's id in brackets.`,
				]
			: [];
	const standing = await peers(at);
	const everyone = standing.present;
	let pivotTo: readonly string[] = [];
	if (params.intent === "pivot") {
		// Read the mark now: an orchestration undone since this session
		// last looked sends nothing.
		at.peer.refresh();
		const pivot = pivotTargets(
			at.peer.orchestrates,
			named.filter((group) => !unnamed.includes(group)),
			everyone,
		);
		if ("refused" in pivot) {
			return answer(`Not sent: ${pivot.refused}.`, {
				sent: false,
			} satisfies SendDetails);
		}
		pivotTo = pivot.to;
	}
	// A replacement goes wherever what it replaces went, so it reaches
	// everyone who heard that, beside whoever it is now sent to.
	const chosen = [
		...new Set([
			...(ownReplaced?.to ?? []),
			// An end goes wherever the hold went, to everyone it parked.
			...(ended.hold?.to ?? []),
			...named.filter((group) => !unnamed.includes(group)),
			...pivotTo,
		]),
	];
	// A message that opens by naming peers is for them: sent to a group
	// they share, every other member would read it to learn it was not.
	// An answer is left where it was sent, since the group its question
	// went to sees by it that the question is answered, and a replacement
	// must reach everyone who heard what it replaces.
	// A pivot goes where it was checked to go, never narrowed to peers
	// named at its start, who may be outside the orchestration.
	const meant =
		params.re === undefined &&
		ownReplaced === undefined &&
		params.intent !== "pivot"
			? namedAtStart(params.text, at.peer.session, everyone).map(homeOf)
			: [];
	// An answer that names nowhere goes back to whoever asked: routed by
	// what it says, a live check's PONG went to #all on 2026-10-25 and
	// never reached the peer waiting on it.
	const asker = answersNamed ? at.transport.read(answersNamed) : undefined;
	if (
		chosen.length === 0 &&
		asker &&
		!sentBy(asker, self) &&
		named.length === 0
	) {
		chosen.push(homeOf(asker.from));
	}
	const aimed =
		meant.length > 0 && !sameGroups(chosen, meant) ? meant : undefined;
	if (aimed) {
		notes.push(
			`It opens by naming ${aimed.map((home) => home.slice(1)).join(", ")}, so it goes to ${aimed.length === 1 ? "that peer" : "those peers"} alone${chosen.length > 0 ? ` rather than ${chosen.join(", ")}` : ""}; open it another way to send it to a group.`,
		);
	}
	const routed =
		chosen.length > 0 || aimed
			? undefined
			: await routeOf(
					{ intent: intent.intent, text: params.text },
					at.peer,
					everyone,
					at.route,
				);
	if (routed) {
		notes.push(
			`It named no group, so it goes to ${routed.to.join(", ")}: ${routed.why}. Name the groups with to to send elsewhere.`,
		);
	}
	// A stop is absolute: a peer that stopped this one is not written to
	// at its home, however the send was meant. It is the one send the
	// mesh refuses, since it is the receiver's to make.
	const stops = stoppedBy(at.peer, everyone);
	const stoppedAt = (group: string) =>
		stops.filter(({ stopper }) =>
			stopper.addresses.map(homeOf).includes(group),
		);
	const meantFor = aimed ?? routed?.to ?? chosen;
	// The machine's group takes only holds and the answers that end them
	// (group.ts). What routing sent there goes to this peer's own work's
	// groups instead; what the sender named there is left out, and with
	// nowhere else to go is refused with where to send it.
	const machineRefused =
		meantFor.includes(ALL) && !machineTakes(intent.intent, asker);
	const ownWork = at.peer.scopes;
	const wanted = !machineRefused
		? meantFor
		: routed && !aimed && chosen.length === 0
			? [...ownWork]
			: meantFor.filter((group) => group !== ALL);
	const instead =
		ownWork.length > 0
			? `this peer's work's ${ownWork.length === 1 ? "group" : "groups"}, ${ownWork.join(", ")}, or to the peers it is for by address`
			: "the peers it is for by address, or a group they share";
	const machineText = `${MACHINE} takes only holds and the answers that end them, since every session on the machine hears it, those on other work too. Send it to ${instead}.`;
	if (machineRefused && wanted.length === 0) {
		// Without re a holder's note is no end, so say why it went.
		const why = kept ? `${capitalized(keptSaid(kept))}. ` : "";
		return answer(`Not sent: ${why}${machineText}`, {
			sent: false,
			refused: [ALL],
		} satisfies SendDetails);
	}
	if (machineRefused) {
		notes.push(
			routedWide(routed, aimed, chosen)
				? `Routing judged it for ${MACHINE}, but ${MACHINE} takes only holds and the answers that end them, so it goes to ${wanted.join(", ")}.`
				: `Not written to ${MACHINE}: ${machineText}`,
		);
	}
	const barred = wanted.filter((group) => stoppedAt(group).length > 0);
	const unbarred = wanted.filter((group) => !barred.includes(group));
	const barredText = () =>
		`${stopsText(stops.filter(({ stopper }) => barred.some((group) => stopper.addresses.map(homeOf).includes(group))))} Only it can lift that; until it does, leave it be.`;
	if (unbarred.length === 0) {
		return answer(`Not sent: ${barredText()}`, {
			sent: false,
			refused: barred,
		} satisfies SendDetails);
	}
	if (barred.length > 0) {
		notes.push(`Not written to ${barred.join(", ")}: ${barredText()}`);
	}
	// Written to an address nobody here goes by, a message is read by
	// nobody: on 2026-11-01 a methuselah session's findings for sessions
	// in the work realm sat unread while it waited on them.
	// Whoever wrote what this answers goes by its address here, presence
	// or none, as the machine's crossing holds do.
	const unheard = unheardOf(
		unbarred,
		standing,
		asker ? [homeOf(asker.from)] : [],
	);
	const to = unbarred.filter((group) => !unheard.includes(group));
	const flows = unheard.length > 0 ? ((await at.flows?.()) ?? []) : [];
	if (to.length === 0) {
		return answer(`Not sent: ${unheardText(unheard, flows)}`, {
			sent: false,
			refused: unheard,
		} satisfies SendDetails);
	}
	if (unheard.length > 0) {
		notes.push(
			`Not written to ${unheard.join(", ")}: ${unheardText(unheard, flows)}`,
		);
	}
	// Only peers still there count as in a group: one whose every other
	// member has ended is one nobody hears this in until someone joins.
	const empty = to.filter(
		(group) =>
			group.startsWith("#") &&
			group !== ALL &&
			!anyoneElseIn(group, everyone, at.peer),
	);
	if (empty.length > 0) {
		notes.push(
			`Nobody else is in ${empty.join(", ")} yet; mesh_read shows it to whoever joins within the week it is kept.`,
		);
	}
	// Only news answers by default: a question of its own asks, and a
	// hold puts off, so neither is taken for the answer it was not.
	const taken =
		params.re === undefined &&
		supersedes === undefined &&
		(intent.intent === "fyi" || intent.intent === "finding")
			? questionTaken(at, to)
			: undefined;
	const re = answersNamed ?? taken?.id;
	if (taken) {
		notes.push(
			`It answers [${shortId(taken)}], the question this peer took up; name re to say it answers another.`,
		);
	}
	const message = at.transport.send({
		from: at.peer.signature,
		to,
		intent: intent.intent,
		text: params.text,
		...senderIdentity(),
		...(re ? { re } : {}),
		...(supersedes ? { supersedes } : {}),
		...(ended.hold && re === ended.hold.id ? { endsHold: true as const } : {}),
	});
	at.sent(message);
	// A peer reads what it writes to: overnight Skynet listened to one
	// channel while it spoke in others, so an objection there went unheard.
	const reading = to.filter(
		(group) =>
			group.startsWith("#") &&
			group !== ALL &&
			!hears(at.peer.groups, group) &&
			at.peer.join(group),
	);
	const {
		notes: reachNotes,
		reached,
		gone,
	} = reach(
		message,
		standing,
		at.peer,
		at.transport.read,
		at.presences.refusal,
	);
	notes.unshift(...reachNotes);
	const glancing = stops
		.filter(({ stopper }) => reaches(message, stopper, -1))
		.map(({ stopper }) => stopper.addresses[0]);
	if (glancing.length > 0) {
		notes.push(
			`${glancing.join(", ")} stopped this peer, so it sees this as one line and no more.`,
		);
	}
	if (reading.length > 0) {
		notes.push(
			`This peer is in ${reading.join(", ")} now, so it hears the answers.`,
		);
	}
	if (message.intent === "hold") {
		notes.push(
			`It holds for two hours at most: answer [${shortId(message)}] with endsHold, or replace it, when it is over, so whoever waits on it carries on.`,
		);
	}
	const answered = re ? at.transport.read(re) : undefined;
	if (message.endsHold && answered) {
		notes.push(
			`It ends [${shortId(answered)}] on the person's word, and every peer waiting on it gets a turn to carry on.`,
		);
	} else if (
		params.endsHold &&
		answered?.intent === "hold" &&
		sentBy(answered, self)
	) {
		notes.push(
			`It ends [${shortId(answered)}], this peer's own hold, and every peer waiting on it gets a turn to carry on.`,
		);
	} else if (
		answered?.intent === "hold" &&
		!sentBy(answered, { addresses: at.peer.addresses, ...senderIdentity() })
	) {
		notes.push(
			`This peer waits on [${shortId(answered)}] now, and gets a turn to carry on when it ends.`,
		);
	}
	return answer(
		`Sent as ${message.from}: ${heading(message)}.\n${notes.join(" ")}`,
		{
			sent: true,
			message,
			reached,
			gone,
			...(routed ? { routed } : {}),
			...(barred.length > 0 ? { refused: barred } : {}),
		} satisfies SendDetails,
	);
}

/**
 * The question a message answers when its sender did not say: the one
 * question this peer took up in a turn that was asked by a peer it goes
 * to, or in a group it goes to. An answer that names nothing reads to
 * the asker as news, and to every other peer as no answer at all, so
 * each of them goes on to answer it too.
 */
function questionTaken(at: Local, to: readonly string[]): Message | undefined {
	const now = Date.now();
	const meant = (at.board.of(at.peer.session)?.leases ?? [])
		.filter((lease) => lease.kind === "answer" && isCurrent(lease, now))
		.map((lease) => at.transport.read(lease.subject))
		.filter(
			(asked): asked is Message =>
				asked !== undefined &&
				(to.includes(homeOf(asked.from)) ||
					asked.to.some((group) => to.includes(group))),
		);
	return meant.length === 1 ? meant[0] : undefined;
}

/**
 * The peers' home groups among `groups` that no session in this mesh
 * goes by, there or ended. The node writes the presence of every
 * session in this realm here, those on other machines too, so such an
 * address is mistyped or belongs to a realm kept apart from this one.
 * `known` names homes heard of otherwise, as a message's sender.
 */
function unheardOf(
	groups: readonly string[],
	standing: Census,
	known: readonly string[] = [],
): string[] {
	const homes = new Set([
		...known,
		...[...standing.present, ...standing.gone].flatMap((one) =>
			one.addresses.map(homeOf),
		),
	]);
	return groups.filter((group) => group.startsWith("@") && !homes.has(group));
}

/** Why a send leaves out the addresses no session here goes by. */
function unheardText(
	unheard: readonly string[],
	flows: readonly string[] = [],
): string {
	const names = unheard.map((group) => group.slice(1)).join(" or ");
	const elsewhere =
		flows.length > 0
			? `. This realm's node lets it send to ${flows.join(" and ")}: if it is meant for a session there, send it again with realm set to that realm.`
			: "; tell the person in your reply what it was for if it is meant for another realm.";
	return `no session in this realm goes by ${names}, there or ended. Realms are kept apart, so a session in another realm can't be reached from here, and a mistyped address reaches nobody. mesh_groups lists who is here${elsewhere}`;
}

/** Who a message just sent goes to, and which addressed peers it misses. */
function reach(
	message: Message,
	standing: Census,
	peer: Peer,
	read: Reader,
	refusal: Refusal,
): { notes: string[]; reached: string[]; gone: string[] } {
	const everyone = standing.present;
	const reached = everyone
		.filter((one) => one.session !== peer.session && one.addresses.length > 0)
		.filter((one) => reaches(message, one, -1))
		.map((one) => one.addresses[0] as string);
	const homes = (list: readonly Presence[]) =>
		new Set(list.flatMap((one) => one.addresses.map(homeOf)));
	const there = homes(everyone);
	const ended = homes(standing.gone);
	const addressed = message.to.filter((group) => group.startsWith("@"));
	const gone = addressed
		.filter((group) => !there.has(group) && ended.has(group))
		.map((group) => group.slice(1));
	const unknown = unheardOf(addressed, standing).map((group) => group.slice(1));
	// Waited on as though it were free to answer, it would hold its asker up.
	const waiting = everyone.flatMap((one) =>
		one.session !== peer.session &&
		one.wants &&
		one.addresses[0] &&
		one.addresses.some((address) => addressed.includes(homeOf(address)))
			? [
					`${one.addresses[0]} (${WANTING[one.wants.kind]} since ${clock({ at: one.wants.since })})`,
				]
			: [],
	);
	const idle = idleAddressed(message, everyone, peer, addressed, read);
	const refused = refusedNotes(
		everyone.filter(
			(one) =>
				one.session !== peer.session &&
				one.addresses.some((address) => addressed.includes(homeOf(address))),
		),
		refusal,
	);
	const notes = [
		reached.length > 0
			? `It goes to ${reached.join(", ")}; mesh_read says when each has it.`
			: "No peer on the mesh is reached by it yet.",
		gone.length > 0
			? `${gone.join(", ")} ${gone.length === 1 ? "has" : "have"} ended, so ${gone.length === 1 ? "it hears" : "they hear"} this only if restored.`
			: "",
		unknown.length > 0
			? `No peer goes by ${unknown.join(", ")}; one never will if the address is wrong.`
			: "",
		waiting.length > 0
			? `${waiting.join(" and ")} ${waiting.length === 1 ? "is waiting on its person, so it" : "are waiting on their people, so they"} may be slow to take this up.`
			: "",
		idle.length > 0 ? idleText(idle, message.intent) : "",
		...refused,
	].filter(Boolean);
	return { notes, reached, gone };
}

/** A peer an fyi or finding was put to that no run will read it in. */
interface Unwoken {
	readonly address: string;
	/** Whether this peer orchestrates it, so a pivot would start its turn. */
	readonly led: boolean;
}

/**
 * The idle peers an fyi or finding is addressed to that it starts no
 * turn for. On 9 November builders sat idle on fyis their orchestrator
 * meant them to act on, since a note waits for a turn something else
 * starts (lib/mesh/attention.ts). An idle orchestrator acts on what a
 * session it leads sends, so it is left out, as is a peer waiting on
 * its person, which the note before says already, and one whose own
 * question this answers, which takes its turn however it is sent.
 */
function idleAddressed(
	message: Message,
	everyone: readonly Presence[],
	peer: Peer,
	addressed: readonly string[],
	read: Reader,
): Unwoken[] {
	if (message.intent !== "fyi" && message.intent !== "finding") return [];
	const asked = message.re === undefined ? undefined : read(message.re);
	const asker = asked?.intent === "question" ? asked.from : undefined;
	return everyone.flatMap((one) => {
		const address = one.addresses[0];
		if (
			address === undefined ||
			one.session === peer.session ||
			one.busy ||
			one.wants ||
			(asker !== undefined && one.addresses.includes(asker)) ||
			!one.addresses.some((each) => addressed.includes(homeOf(each)))
		) {
			return [];
		}
		const leadsThis =
			peer.orchestratedBy !== undefined &&
			one.addresses.includes(peer.orchestratedBy);
		if (leadsThis) return [];
		const led =
			one.orchestratedBy !== undefined &&
			peer.addresses.includes(one.orchestratedBy);
		return [{ address, led }];
	});
}

/** Why an fyi or finding to idle peers waits, and what would wake them. */
function idleText(idle: readonly Unwoken[], intent: string): string {
	const one = idle.length === 1;
	const names = idle.map((each) => each.address).join(" and ");
	const wake = idle.every((each) => each.led)
		? "a question or a pivot"
		: "a question";
	return `${names} ${one ? "is" : "are"} idle, and ${intent === "fyi" ? "an fyi" : "a finding"} starts no turn, so ${one ? "it reads" : "they read"} this only when something else starts ${one ? "its" : "their"} next. Send ${wake} if ${one ? "it" : "they"} should act on it now.`;
}

async function read(
	at: Local,
	params: { count?: number; unanswered?: boolean; before?: string },
): Promise<Answer> {
	if (params.unanswered) return answer(await openText(at));
	const wanted = Math.min(
		MOST_READ,
		Math.max(1, Math.floor(params.count ?? 15)),
	);
	// Newest first, reading only until enough are found: what is shown,
	// not the mesh's whole week.
	const ids = at.transport.ids();
	const before = params.before ? idNamed(params.before, ids) : undefined;
	if (params.before && before === undefined) {
		return answer(
			`No message has the id ${params.before}, so there is nothing to read before it. mesh_read shows each message's id in brackets.`,
		);
	}
	const from = before === undefined ? ids.length : ids.indexOf(before);
	const latest: Message[] = [];
	for (let index = from - 1; index >= 0; index--) {
		if (latest.length >= wanted) break;
		const message = at.transport.read(ids[index] as string);
		if (
			message &&
			(sentBy(message, { addresses: at.peer.addresses, ...senderIdentity() }) ||
				reaches(message, at.peer.listener, -1))
		) {
			latest.unshift(message);
		}
	}
	const present = (await peers(at)).present;
	const receipt = receipts(at, present);
	const withdrawn = withdrawals(latest);
	const state = questionStates(at, latest, ids, present, withdrawn);
	const shown = withinBudget(
		latest.map((message) =>
			[
				line(message),
				withdrawn.get(message.id) ?? "",
				receipt(message),
				state.get(message.id) ?? "",
			]
				.filter(Boolean)
				.join("\n  "),
		),
	);
	const left = latest.length - shown.length;
	const oldest = latest[left];
	const rest =
		left > 0 && oldest
			? `\n${capitalized(count(left, "older message"))} left out to keep this short; mesh_read with before ${shortId(oldest)} reads on.`
			: "";
	const text =
		latest.length > 0
			? `${shown.join("\n")}${rest}`
			: before === undefined
				? "Nothing on the mesh yet."
				: "Nothing this peer hears came before that.";
	return answer(`This peer is ${at.peer.addresses.join(" or ")}.\n${text}`);
}

/**
 * The newest of these rendered messages that fit
 * {@link READ_BUDGET_BYTES}, oldest first, and always the newest one.
 */
function withinBudget(rendered: readonly string[]): string[] {
	const kept: string[] = [];
	let spent = 0;
	for (const one of [...rendered].reverse()) {
		const bytes = Buffer.byteLength(one, "utf8") + 1;
		if (kept.length > 0 && spent + bytes > READ_BUDGET_BYTES) break;
		kept.unshift(one);
		spent += bytes;
	}
	return kept;
}

/**
 * Every question on the mesh still waiting on a peer it named, oldest
 * first, with how long it has waited and whether that peer is still
 * there (lib/mesh/unanswered.ts).
 */
async function openText(at: Local, now = Date.now()): Promise<string> {
	const since = now - UNANSWERED_WITHIN_MS;
	// Ids start with the time they were sent, so older ones go unread.
	const messages = at.transport
		.ids()
		.filter((id) => !(Number.parseInt(id, 10) < since))
		.map((id) => at.transport.read(id))
		.filter((one): one is Message => one !== undefined);
	const everyone = at.presences.all();
	const aliases = (address: string): readonly string[] =>
		everyone.find((one) => one.addresses.includes(address))?.addresses ?? [
			address,
		];
	const present = new Set(
		(await peers(at)).present.flatMap((one) => one.addresses),
	);
	const all = unanswered(messages, aliases, now);
	// An orchestrator sees its own orchestration's: the rest of the mesh
	// is not its to unstick. Any other session sees the whole mesh.
	const heads = at.peer.orchestrates;
	const members = heads
		? new Set([
				...at.peer.addresses,
				...everyone
					.filter((one) => one.orchestratedBy === heads)
					.flatMap((one) => one.addresses),
			])
		: undefined;
	const open = members ? withinOrchestration(all, members) : all;
	const where = members ? " in this orchestration" : "";
	const elsewhere =
		all.length > open.length
			? ` ${all.length - open.length} more elsewhere on the mesh are left out.`
			: "";
	if (open.length === 0) {
		return `No question ${members ? "in this orchestration" : "on the mesh"} is waiting on an answer.${elsewhere}`;
	}
	const lines = open.slice(-MOST_READ).map(({ message, waitingOn }) => {
		const minutes = Math.round((now - Date.parse(message.at)) / 60_000);
		const who = waitingOn
			.map((address) => {
				if (!present.has(address)) return `${address} (gone)`;
				const one = everyone.find((each) => each.addresses.includes(address));
				return `${address}${refusedMark(one && at.presences.refusal(one))}`;
			})
			.join(", ");
		const text = message.text.replace(/\s+/g, " ").trim();
		const cut =
			text.length > OPEN_CHARS ? `${text.slice(0, OPEN_CHARS - 3)}...` : text;
		return `${clock(message)} [${shortId(message)}] from ${message.from}, ${minutes} min, waiting on ${who}: ${cut}`;
	});
	const more =
		open.length > MOST_READ
			? ` (the newest ${MOST_READ} of ${open.length} shown)`
			: "";
	return `${open.length} ${open.length === 1 ? "question is" : "questions are"}${where} waiting on an answer, oldest first${more}:${elsewhere}\n${lines.join("\n")}`;
}

/** How much of an open question's text its line shows. */
const OPEN_CHARS = 100;

/**
 * Where each of this peer's own questions among these stands: answered,
 * and by whom; being answered, by a peer that took it up; or unanswered,
 * and for how long. A question nobody answers otherwise reads the same
 * as one answered in a group the asker never looked at. A pivot is
 * answered like a question, by each session once it has changed course,
 * and also names those it reached that have not, so one ignored shows.
 */
function questionStates(
	at: Local,
	shown: readonly Message[],
	ids: readonly string[],
	present: readonly Presence[],
	withdrawn: ReadonlyMap<string, string>,
): Map<string, string> {
	const self = { addresses: at.peer.addresses, ...senderIdentity() };
	const asked = shown.filter(
		(message) =>
			(message.intent === "question" || message.intent === "pivot") &&
			sentBy(message, self) &&
			!withdrawn.has(message.id),
	);
	const states = new Map<string, string>();
	const first = asked[0]?.id;
	if (first === undefined) return states;
	// Only what came after the oldest question can answer one.
	const answers = new Map<string, Message[]>();
	for (const id of ids) {
		if (id <= first) continue;
		const one = at.transport.read(id);
		if (one?.re === undefined || sentBy(one, self)) continue;
		answers.set(one.re, [...(answers.get(one.re) ?? []), one]);
	}
	const now = Date.now();
	const board = at.board.all();
	for (const question of asked) {
		const given = answers.get(question.id) ?? [];
		if (question.intent === "pivot") {
			states.set(question.id, pivotState(question, given, present, self));
			continue;
		}
		if (given.length > 0) {
			const by = [...new Set(given.map((one) => one.from))].join(", ");
			const last = given.at(-1) as Message;
			states.set(question.id, `answered by ${by}, last in [${shortId(last)}]`);
			continue;
		}
		const answering = othersOn(
			board,
			at.peer.session,
			"answer",
			question.id,
			now,
		)
			.map(
				(held) =>
					present.find((one) => one.session === held.session)?.addresses[0],
			)
			.filter((address): address is string => address !== undefined);
		states.set(
			question.id,
			answering.length > 0
				? `being answered by ${answering.join(", ")}`
				: `unanswered after ${since(question, now)}`,
		);
	}
	return states;
}

/**
 * Who of the sessions a pivot reached has answered it, having changed
 * course, and who has not yet.
 */
function pivotState(
	pivot: Message,
	given: readonly Message[],
	present: readonly Presence[],
	self: { addresses: readonly string[]; pid: number },
): string {
	const by = new Set(given.map((one) => one.from));
	const reached = present.filter(
		(one) =>
			!one.addresses.some((address) => self.addresses.includes(address)) &&
			(one.addresses.some((address) => pivot.to.includes(homeOf(address))) ||
				one.groups.some((group) => pivot.to.includes(group))),
	);
	const waiting = reached
		.filter((one) => !one.addresses.some((address) => by.has(address)))
		.map((one) => one.addresses[0] as string);
	const answered = by.size > 0 ? `changed course: ${[...by].join(", ")}` : "";
	const yet = waiting.length > 0 ? `not yet: ${waiting.join(", ")}` : "";
	return [answered, yet].filter(Boolean).join("; ") || "reached nobody present";
}

/** How long ago a message was sent, in minutes, or hours past two. */
function since(message: Message, now: number): string {
	return lastedText(now - Date.parse(message.at));
}

/** A span of time in minutes, or hours past two. */
function lastedText(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/**
 * The messages among these that a later one replaced, each with the
 * line that says so, so a withdrawn message is never read as standing.
 */
function withdrawals(messages: readonly Message[]): Map<string, string> {
	const byId = new Map(messages.map((one) => [one.id, one]));
	const withdrawn = new Map<string, string>();
	for (const one of messages) {
		const original = one.supersedes ? byId.get(one.supersedes) : undefined;
		if (original && mayReplace(one, original)) {
			withdrawn.set(
				original.id,
				`withdrawn: replaced by [${shortId(one)}], so go by that instead`,
			);
		}
	}
	return withdrawn;
}

/**
 * Who has a message this peer sent, and who it is still on its way to,
 * among the peers still there. A peer has it once its read marker has
 * passed it, which happens when the message is handed to its model,
 * at whatever attention; a peer mid-run gets it at its next step.
 */
function receipts(
	at: Local,
	present: readonly Presence[],
): (message: Message) => string {
	const marks = new Map<string, string | undefined>();
	const markOf = (one: Presence) => {
		if (!marks.has(one.session)) {
			marks.set(one.session, at.transport.lastRead(one.addresses));
		}
		return marks.get(one.session);
	};
	return (message) => {
		const own = sentBy(message, {
			addresses: at.peer.addresses,
			...senderIdentity(),
		});
		if (!own) return "";
		const meant = present.filter(
			(one) =>
				one.session !== at.peer.session &&
				one.addresses.length > 0 &&
				reaches(message, one, -1),
		);
		if (meant.length === 0) return "reached no peer";
		const signed = (list: readonly Presence[]) =>
			list.map((one) => one.addresses[0]).join(", ");
		const has = meant.filter((one) => (markOf(one) ?? "") >= message.id);
		const waiting = meant.filter((one) => !has.includes(one));
		return [
			has.length > 0
				? `${signed(has)} ${has.length === 1 ? "has" : "have"} it`
				: "",
			waiting.length > 0 ? `not yet ${signed(waiting)}` : "",
		]
			.filter(Boolean)
			.join("; ");
	};
}

async function join(
	at: Local,
	params: { group: string; invite?: string; why?: string },
): Promise<Answer> {
	const group = joinable(params.group, at.presences.all());
	if (group === undefined || !isJoinable(group)) {
		return answer(
			`${params.group} is not a group to join: name one with letters, digits and dashes after a #, with / between a group and its part, as #optimus/power, or give a peer's address. Every peer is in #machine already.`,
		);
	}
	if (at.peer.addresses.map(homeOf).includes(group)) {
		return answer(
			`${group} is this peer's own home group; it is always in it.`,
		);
	}
	const already =
		hears(at.peer.scopes, group) && !at.peer.joined.includes(group);
	const joinedNow = !already && at.peer.join(group);
	const standing = await peers(at);
	const said = already
		? `Already in ${group} by this peer's work.`
		: `In ${group}.`;
	const invited = groupsNamed(params.invite ?? "");
	const lately = joinedNow ? saidLately(at, group) : "";
	if (invited.length === 0) {
		return answer(`${said} ${groupsText(standing, at.peer)}${lately}`, {
			groups: at.peer.groups,
		});
	}
	if (!group.startsWith("#")) {
		return answer(
			`${said} Nobody was invited: peers are brought into a named group, and anyone may follow a home group by joining it.`,
			{ groups: at.peer.groups },
		);
	}
	const homes = invited.filter(
		(one) =>
			one.startsWith("@") && !at.peer.addresses.map(homeOf).includes(one),
	);
	const notHomes = invited.filter((one) => !homes.includes(one));
	if (homes.length === 0) {
		return answer(
			`${said} Nobody was invited: ${notHomes.join(", ")} names no other peer. Invite peers by their addresses, as P9R1KI.`,
			{ groups: at.peer.groups },
		);
	}
	const why = params.why?.trim();
	const message = at.transport.send({
		from: at.peer.signature,
		to: homes,
		intent: "fyi",
		text: `${at.peer.signature} brings this peer into ${group}${why ? `: ${why}` : "."} It is in ${group} from now on, hearing what is said there, until it leaves with mesh_leave.`,
		...senderIdentity(),
		invite: group,
	});
	at.sent(message);
	const { notes } = reach(
		message,
		standing,
		at.peer,
		at.transport.read,
		at.presences.refusal,
	);
	const skipped =
		notHomes.length > 0
			? ` Not invited, since they name no other peer: ${notHomes.join(", ")}.`
			: "";
	return answer(
		`${said} Invited ${homes.map((one) => one.slice(1)).join(", ")}. ${notes.join(" ")}${skipped}${lately}`,
		{ groups: at.peer.groups, invited: homes, message },
	);
}

/** How many of a group's latest messages joining it shows. */
const LATELY = 10;

/** How much of each of those it shows. */
const LATELY_CHARS = 240;

/**
 * What was said in a group lately, oldest first, so a peer joining it
 * starts from where its talk stands rather than from silence.
 */
function saidLately(at: Local, group: string): string {
	const ids = at.transport.ids();
	const latest: string[] = [];
	for (let index = ids.length - 1; index >= 0; index--) {
		if (latest.length >= LATELY) break;
		const message = at.transport.read(ids[index] as string);
		if (!message?.to.includes(group)) continue;
		const whole = line(message).replace(/\s+/g, " ");
		latest.unshift(
			whole.length > LATELY_CHARS
				? `${whole.slice(0, LATELY_CHARS - 3)}...`
				: whole,
		);
	}
	return latest.length > 0
		? `\nSaid in ${group} lately, oldest first (mesh_read has each in full):\n${latest.join("\n")}`
		: "";
}

async function leave(at: Local, params: { group: string }): Promise<Answer> {
	const group = groupNamed(params.group);
	const left = group !== undefined && at.peer.leave(group);
	const everyone = await peers(at);
	const scoped = group !== undefined && at.peer.scopes.includes(group);
	const said = scoped
		? `${left ? `Left what this peer joined of ${group}, but it` : group} is one of this peer's scopes: its work puts it there, so it hears ${group} until it works on something else.`
		: left
			? `Left ${group}.`
			: `Not in ${params.group}, so nothing changed.`;
	return answer(`${said} ${groupsText(everyone, at.peer)}`, {
		groups: at.peer.groups,
	});
}

/**
 * The group a peer means to join. A bare name is a peer's address when
 * some peer goes by it, and otherwise a named group, since "harness"
 * typed without its # means #harness.
 */
function joinable(
	written: string,
	everyone: readonly Presence[],
): string | undefined {
	const group = groupNamed(written);
	const bare = !/^[#@]/.test(written.trim());
	if (!bare || group === undefined || !group.startsWith("@")) return group;
	const known = everyone.some((one) =>
		one.addresses.map(homeOf).includes(group),
	);
	return known ? group : groupNamed(`#${written.trim()}`);
}

function anyoneElseIn(
	group: string,
	everyone: readonly Presence[],
	peer: Peer,
): boolean {
	return everyone.some(
		(one) => one.session !== peer.session && hears(one.groups, group),
	);
}

/**
 * Every joined group with who is in it among the peers still there,
 * where this peer stands, and who joined groups but has since ended.
 */
function sameGroups(one: readonly string[], other: readonly string[]): boolean {
	return (
		one.length === other.length && one.every((group) => other.includes(group))
	);
}

function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function groupsText(standing: Census, peer: Peer): string {
	const members = new Map<string, string[]>();
	for (const one of standing.present) {
		const signature = one.addresses[0];
		if (!signature) continue;
		const groups = one.session === peer.session ? peer.groups : one.groups;
		for (const group of groups) {
			members.set(group, [...(members.get(group) ?? []), signature]);
		}
	}
	const lines = [...members.keys()]
		.sort()
		.map((group) => `${group}: ${members.get(group)?.join(", ")}`);
	const joined = peer.joined.filter((group) => !peer.scopes.includes(group));
	const standsIn = [
		peer.scopes.length > 0 ? `is in ${peer.scopes.join(", ")} by its work` : "",
		joined.length > 0 ? `has joined ${joined.join(", ")}` : "",
	].filter(Boolean);
	const own =
		standsIn.length > 0
			? `This peer ${standsIn.join(", and ")}; it is also in its home group and #machine.`
			: "This peer is in its home group and #machine only.";
	// An address a live session answers to again (a quest's peer restarted
	// under a new session) has not ended, so it is not listed as ended.
	const answering = new Set(
		standing.present.flatMap((one) => one.addresses.slice(0, 1)),
	);
	const ended = [
		...new Set(
			standing.gone
				.filter((one) => one.groups.length > 0 && one.addresses[0])
				.map((one) => one.addresses[0] as string)
				.filter((address) => !answering.has(address)),
		),
	];
	const gone =
		ended.length > 0
			? `\nEnded, so left out until restored: ${ended.join(", ")}.`
			: "";
	const stopping =
		peer.stops.length > 0
			? `\nStopped by this peer: ${peer.stops.map((one) => one.address).join(", ")}.`
			: "";
	const stops = stoppedBy(peer, standing.present);
	const stoppedHere = stops.length > 0 ? `\n${stopsText(stops)}` : "";
	const waiting = wantsText(standing.present);
	const more = `${gone}${stopping}${stoppedHere}${waiting}`;
	return lines.length > 0
		? `${own}\nGroups:\n${lines.join("\n")}${more}`
		: `${own} No other groups yet.${more}`;
}

/** How much of what a peer works on mesh_groups says, to name it. */
const WORK_CHARS = 100;

/** How long a step runs before mesh_groups says what it is. */
const STEP_SAID_AFTER_MS = 60_000;

/**
 * Every other peer still there, one line each: whether it is in a run,
 * and what it works on, so a peer can tell whom to ask without asking.
 */
function peersText(
	present: readonly Presence[],
	peer: Peer,
	now: number,
): string {
	const lines = present.flatMap((one) => {
		const address = one.addresses[0];
		if (one.session === peer.session || !address) return [];
		const work = one.worksOn.replace(/\s+/g, " ").trim();
		const cut =
			work.length > WORK_CHARS ? `${work.slice(0, WORK_CHARS - 3)}...` : work;
		const where = one.machine ? ` on ${one.machine}` : "";
		return [`${address}${where}, ${runText(one, now)}: ${cut}`];
	});
	return lines.length > 0 ? `\nPeers:\n${lines.join("\n")}` : "";
}

/**
 * Whether a peer is in a run and, once a step has gone on a minute, what
 * the step is and for how long. A single tool call that runs for hours
 * otherwise reads as a run that is merely busy, or as a stuck model
 * request, since the session's file says nothing until the call ends.
 */
function runText(one: Presence, now: number): string {
	if (one.state === "parked") return "parked";
	if (!one.busy) return "idle";
	const step = one.stepDetail;
	const lasted = step ? now - Date.parse(step.since) : Number.NaN;
	if (!step || !(lasted >= STEP_SAID_AFTER_MS)) return "busy";
	const span = lastedText(lasted);
	if (step.kind === "tool") return `busy, in ${step.name} for ${span}`;
	if (step.kind === "thinking") return `busy, thinking for ${span}`;
	return `busy, waiting on its person for ${span}`;
}

/**
 * The peers waiting on their person, so none is waited on as though it
 * were free to answer (see want.ts).
 */
function wantsText(present: readonly Presence[]): string {
	const lines = present.flatMap((one) =>
		one.wants && one.addresses[0]
			? [
					`${one.addresses[0]}: ${WANTING[one.wants.kind]} since ${clock({ at: one.wants.since })}: ${one.wants.said}`,
				]
			: [],
	);
	return lines.length > 0
		? `\nWaiting on their person:\n${lines.join("\n")}`
		: "";
}

/** A want's kind, as mesh_groups says it. */
const WANTING: Record<WantKind, string> = {
	question: "asked",
	approval: "held at an approval",
	blocked: "blocked",
};

/** The stops on this peer, said to it. */
function stopsText(stops: ReturnType<typeof stoppedBy>): string {
	return stops
		.map(
			({ stopper, stop }) =>
				`${stopper.addresses[0]} stopped this peer reaching it${stop.why ? ` (${stop.why})` : ""}: it sees what this peer sends as one line only.`,
		)
		.join(" ");
}

async function stop(
	at: Local,
	params: { peer: string; why?: string; lift?: boolean },
): Promise<Answer> {
	const everyone = at.presences.all();
	const home = groupNamed(params.peer);
	const address = home?.startsWith("@") ? home.slice(1) : undefined;
	if (!address || at.peer.addresses.includes(address)) {
		return answer(
			`${params.peer} is not another peer's address; give one as mesh_groups lists it, such as P9R1KI.`,
		);
	}
	const why = params.why?.trim();
	const stopped = everyone.find((one) => one.addresses.includes(address));
	// Whichever of its addresses it is named by, a peer has one stop.
	const standing = at.peer.stops.find(
		(one) =>
			one.address === address ||
			(stopped !== undefined && one.session === stopped.session),
	);
	if (params.lift) {
		if (!standing) {
			return answer(`${address} is not stopped, so nothing changed.`);
		}
		at.peer.lift(standing.address);
		tell(
			at,
			address,
			`${at.peer.signature} has lifted its stop on this peer, which may reach it again as any peer does.`,
		);
		return answer(`Lifted the stop on ${address}; it is told.`);
	}
	if (standing) return answer(`${address} is stopped already.`);
	const set = at.peer.stop({
		address,
		at: new Date().toISOString(),
		...(stopped ? { session: stopped.session } : {}),
		...(why ? { why } : {}),
	});
	if (!set) return answer(`${address} is stopped already.`);
	tell(
		at,
		address,
		`${at.peer.signature} has stopped this peer reaching it${why ? `: ${why}` : "."} Until it lifts the stop, it sees what this peer sends as one line only, and sends to its home group are refused. Do not work around it.`,
	);
	return answer(
		`Stopped ${address}: what it sends reaches this peer as one line only, its answers to this peer's questions included, until mesh_stop with lift. It is told${why ? ", with why" : ""}.`,
	);
}

async function end(at: Local, params: { peer: string }): Promise<Answer> {
	const home = groupNamed(params.peer);
	const address = home?.startsWith("@") ? home.slice(1) : params.peer.trim();
	const target = endTarget(
		at.peer.orchestrates,
		at.peer.session,
		address,
		at.presences.all(),
	);
	if ("refused" in target) return answer(`Nothing ended: ${target.refused}.`);
	const ended = await (at.endProcess ?? endByOwner)(
		target.owner,
		`mesh_end from ${at.peer.signature}`,
	);
	if (ended === "gone") {
		return answer(`${address} had already ended; nothing was signalled.`);
	}
	if (ended === "unsure") {
		if (target.owner.session)
			return answer(
				`Nothing ended: ${address}'s host did not confirm the close through its host control socket (unreachable, refused, or no longer the host its presence names), so it was left alone; a shared host is never signalled.`,
			);
		return answer(
			`Nothing ended: this machine can't tell whether pid ${target.owner.pid} is still ${address}'s pi, so it was left alone.`,
		);
	}
	if (target.owner.session)
		return answer(`Asked ${address}'s host to close only that conversation.`);
	return answer(
		`Asked ${address}'s pi (pid ${target.owner.pid}) to quit; its window closes with it.`,
	);
}

/**
 * Close a hosted conversation, here or through its host's control
 * socket, or signal a plain pi only while its recorded process identity
 * still matches.
 */
const endByOwner: EndProcess = async (owner, by) => {
	const standing = await tickedStanding(owner);
	if (standing === "gone") return "gone";
	if (standing === "unknown") return "unsure";
	if (owner.session !== undefined && !hostedHere(owner))
		return closeThroughHost(owner, by);
	try {
		await endSession(owner, `closed, asked by ${by}`);
		return "ended";
	} catch {
		// A failed local close is not known to have landed, and a hosted
		// owner must never be mistaken for a process safe to signal.
		return owner.session ? "unsure" : "gone";
	}
};

/** Say something to one peer's home group, as the mesh itself would. */
function tell(at: Local, address: string, text: string): void {
	const message = at.transport.send({
		from: at.peer.signature,
		to: [homeOf(address)],
		intent: "fyi",
		text,
		...senderIdentity(),
	});
	at.sent(message);
}

function answer(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
