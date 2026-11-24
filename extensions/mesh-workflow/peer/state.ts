/**
 * A peer's state as the extension loads: its transport, presences, leases
 * and the helpers that pause, move and talk for it, before any session
 * starts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../../lib/core/session/host.ts";
import { sessionCwd } from "../../../lib/core/session/index.ts";
import { endConversation } from "../../../lib/core/session/owner.ts";
import { stoppingFromOutside } from "../../../lib/internal/away/state.ts";
import {
	type CarryHold,
	carryUnderWay,
	holdForCarry,
} from "../../../lib/internal/carry/under-way.ts";
import { machineBooted } from "../../../lib/internal/machine/booted.ts";
import { everyRealmsDir } from "../../../lib/internal/paths.ts";
import { withQuestLock } from "../../../lib/internal/quest/io.ts";
import { createReloadHold } from "../../../lib/internal/reload/hold.ts";
import { sandboxName } from "../../../lib/internal/sandbox/sandbox.ts";
import { carriedEnvironment } from "../../../lib/internal/session/carried-environment.ts";
import {
	forgetUntrusted,
	leaveUntrusted,
} from "../../../lib/internal/session/carried-trust.ts";
import {
	CUT_OFF_ENTRY,
	cutByMove,
} from "../../../lib/internal/session/cut-off-record.ts";
import type { SessionEvent } from "../../../lib/internal/session/events.ts";
import type { Landing } from "../../../lib/internal/session/landings.ts";
import { writeMoveNote } from "../../../lib/internal/session/move.ts";
import { moveHolder } from "../../../lib/internal/session/move-waiting.ts";
import { sayWriteFailed } from "../../../lib/internal/write-whole.ts";
import { findJobHost } from "../../../lib/jobs/host.ts";
import { loadedQuest } from "../../../lib/mesh/address.ts";
import type { Crossings } from "../../../lib/mesh/crossing.ts";
import { createDamper } from "../../../lib/mesh/damping.ts";
import { releaseThroughHost } from "../../../lib/mesh/host-close.ts";
import { createBoard, type LeaseEvent } from "../../../lib/mesh/lease.ts";
import { senderIdentity } from "../../../lib/mesh/message.ts";
import { createAwaiting, createOwing } from "../../../lib/mesh/owed.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { createReadFront } from "../../../lib/mesh/reading.ts";
import { heedingNoReceptor } from "../../../lib/mesh/receptor.ts";
import {
	SWEEP_EVERY_MS,
	SWEPT_STAMP,
	sweeper,
} from "../../../lib/mesh/retention.ts";
import { inboxOf } from "../../../lib/mesh/steer.ts";
import { toldIn } from "../../../lib/mesh/told.ts";
import {
	folderTransport,
	type Transport,
} from "../../../lib/mesh/transport.ts";
import type { Want, WantKind } from "../../../lib/mesh/want.ts";
import {
	createWorkerLink,
	keptIn,
	presentedPresences,
	refusalText,
	relayedTransport,
	type WorkerLink,
	workerSocket,
} from "../../../lib/mesh/worker-link.ts";
import type { Settling } from "../acts.ts";
import { CARRY_NOTE, carryThisSession } from "../carrying.ts";
import { WORKER_REFUSED } from "../delivery.ts";
import { createGlances } from "../glances.ts";
import { handOverOf } from "../in-place.ts";
import { createLeasing, queueKept, type TakenCall } from "../leases.ts";
import { createMoving, holdsOf, moveNoteOf } from "../moving.ts";
import {
	createOrderedCarrying,
	orderedHolds,
	refuseInHandover,
} from "../ordered-carry.ts";
import { createPausing, RESUMED_TEXT } from "../pausing.ts";
import { createTalks } from "../talks.ts";
import type { HubTiming } from "../tools/above.ts";
import { type Waiting, watchSettling } from "../wait.ts";
import type { Left, MeshPaths, MeshState } from "./mesh.ts";
import { createWaits } from "./waits.ts";

/** The state one peer starts with, on the mesh at these paths. */
export function createState(
	pi: ExtensionAPI,
	paths: MeshPaths,
	env: NodeJS.ProcessEnv,
	settling: Settling,
	waitCheckMs: number,
	lookAgainMs: number,
	hubTiming: HubTiming = {},
): MeshState {
	const messages = join(paths.mesh, "messages");
	const local = folderTransport(messages);
	// On a machine that keeps no mesh of its own, the node behind its worker
	// socket carries what is sent and heard (lib/mesh/worker-link.ts).
	const workerLink = workerLinkFor(pi, env, messages, local);
	// Everything here reads a receptor's name as nothing, but delivery and
	// mesh_read, which ask the node to vouch for it (lib/mesh/receptor.ts).
	const { transport, asWritten, asWrittenOff } = heedingNoReceptor(
		workerLink ? relayedTransport(local, workerLink) : local,
	);
	// A host writes presence and leases off its thread; one that can't
	// land is said once in the session's log and the host's journal, and
	// written again.
	const failed = sayWriteFailed((type, data) => pi.appendEntry(type, data));
	const kept = createPresences(join(paths.mesh, "presence"), { failed });
	const presences = workerLink ? presentedPresences(kept, workerLink) : kept;
	const glances = createGlances();
	const damper = createDamper();
	const board = createBoard(join(paths.mesh, "leases"), { failed });
	const crossings: Crossings = {
		others: () =>
			everyRealmsDir("state", "mesh-workflow")
				.filter((dir) => dir !== paths.mesh && existsSync(dir))
				.map((dir) => ({
					dir,
					transport: folderTransport(join(dir, "messages")),
				})),
		notes: join(paths.mesh, "crossings"),
		...senderIdentity(),
	};
	// Lets go of what is past its time, at most hourly on the machine,
	// off the turn: every conversation a host starts makes one of these.
	const tidy = sweeper(
		{
			transport,
			presences,
			board,
			...(paths.steer !== undefined ? { inboxes: paths.steer } : {}),
			needs: paths.mesh,
		},
		SWEEP_EVERY_MS,
		Date.now,
		join(paths.mesh, SWEPT_STAMP),
	);
	// Heavy work that ended before this runtime had its leases to release.
	const unowned: LeaseEvent[] = [];
	// Bash calls taken up from a restart or a move before it had its leases.
	const takenUnowned: TakenCall[] = [];
	// Background jobs judged waits by their whole command (leases/heavy-calls.ts).
	const waitingCalls = new Map<string, string>();
	const leasing = createLeasing({
		board,
		presences,
		transport,
		own: () => m.own,
		peer: () => m.peer,
		sent: (message) => seen.add(message.id),
		queueKept: () => queueKept(env),
		booted: () => machineBooted(),
		told: toldIn(join(paths.mesh, "told")),
	});
	// Messages other peers have answered, so a question to the machine
	// that one peer took up starts no turn of the rest. A question that
	// asks each peer is answered for this one only by its own reply.
	const answered = new Set<string>();
	// Questions this peer left to the peer answering them, by id, kept
	// until answered so one let go reaches this peer after all.
	const left = new Map<string, Left>();
	// Answers this peer owes and is owed, so a question put to it is
	// asked again and one it put is said to be stuck (lib/mesh/owed.ts).
	const owing = createOwing();
	const awaiting = createAwaiting();
	// What this session's quest has waiting on the person (wait.ts).
	const waiting: Waiting | undefined = paths.waiting
		? {
				folder: paths.waiting,
				quest: () =>
					m.peer ? loadedQuest(m.peer.session, paths.sessions) : undefined,
				window: () =>
					m.peer ? presences.of(m.peer.session)?.title : undefined,
				owner: () =>
					m.peer
						? {
								session: m.peer.session,
								address: m.peer.signature,
								// Fenced by any name, the stage's default included.
								sandbox: sandboxName() ? "strict" : "none",
							}
						: undefined,
				locked: <T>(quest: string, change: () => T): T => {
					const dir = join(paths.quests, quest);
					return existsSync(dir) ? withQuestLock(dir, change) : change();
				},
				heard: (items) => {
					settleWatch?.heard(items);
					waits.watchSettled();
				},
			}
		: undefined;
	// What this session raised for the person, heard when it settles.
	const settleWatch = waiting ? watchSettling(waiting) : undefined;
	const wanting = new Map<WantKind, Want>();
	const unlanded: Landing[] = [];
	const undone: SessionEvent[] = [];
	// Every id already looked at, so a watcher that reports one twice,
	// as inotify does for a rename, is handed over once.
	const seen = new Set<string>();
	const unjudgedSaid = new Set<string>();
	// A turn a note would start waits for a reload that is waiting: the
	// note is said now, without it, and the landing starts it (hold.ts).
	const holdTurn = createReloadHold();
	// What became of each steer that asked to be followed (talks.ts).
	const talks = createTalks({
		session: () => m.peer?.session ?? "",
		inboxes: () =>
			m.steerRoot === undefined
				? []
				: (m.peer?.addresses ?? []).map((address) =>
						inboxOf(m.steerRoot ?? "", address),
					),
	});
	// The session's id, or its peer's while its context has gone stale,
	// whose every read throws: a carry, its refusal and what is said of
	// them go on without the context.
	const sessionOf = (): string | undefined => {
		try {
			return m.ctx?.sessionManager.getSessionId() ?? m.peer?.session;
		} catch {
			// Stale: the peer was named for the same session.
			return m.peer?.session;
		}
	};
	// Said on screen where there is one; a stale screen says nothing, and
	// never stops what saying it went with.
	const notify = (text: string, type: "info" | "warning") => {
		try {
			if (m.ctx?.hasUI) m.ctx.ui.notify(text, type);
		} catch {
			// A stale context's screen is gone; the journal keeps what matters.
		}
	};
	// A host's standard error is its journal; plain pi's window said it.
	const journal = (text: string) => {
		if (!hosted()) return;
		process.stderr.write(`pausing ${sessionOf() ?? "unknown"}: ${text}\n`);
	};
	// A carry that outlives its hold is said, so the park that may end it
	// next isn't taken for an ordinary one. Called from a bare timer, it
	// never throws: a host would end every conversation for a warning.
	// One that carried says its close never landed, as a failed host close
	// leaves it, since a second carry would now write its work again.
	const lapsed = (hold: CarryHold, carried: boolean) => {
		const text = carried
			? `a carry to ${hold.to} carried, but this session's close never landed in its whole time, so it lets the session go; a park, a restart or a second carry may now go, and a second carry would write its work again.`
			: `a carry to ${hold.to} has held this session its whole time and lets it go; a park, a restart or a second carry may now go beside it.`;
		try {
			journal(text);
		} catch {
			// A journal that can't be written leaves the screen to say it.
		}
		notify(text, "warning");
	};
	// The hold an ordered carry took at its order, which its own looks at
	// what holds the session set aside.
	let orderedHold: CarryHold | undefined;
	// Pause, Resume, Stop, Close and Carry from outside the window (pausing.ts).
	const pausing = createPausing({
		now: Date.now,
		idle: () => m.ctx?.isIdle?.() ?? true,
		abort: () => {
			// Stopped from outside, not by the person: away mode stays on.
			// The inbox watch runs outside any hosted dispatch, so the mark
			// names this session; with no session there is no run to stop.
			if (!m.ctx) return;
			stoppingFromOutside(m.ctx);
			m.ctx.abort?.();
		},
		paused: () => m.peer?.paused ?? false,
		setPaused: (paused) => m.peer?.setPaused(paused),
		carryOn: () => pi.sendUserMessage(RESUMED_TEXT),
		tell: (text) => notify(text, "info"),
		journal,
		// Plain pi waits until it is idle, so the run just ended winds down
		// first; a host closes it as a Close over its socket does.
		close: (by, failed, closed) => {
			if (m.ctx) endConversation(m.ctx, by, failed, closed);
			else if (failed) throw new Error("the session has no context to close");
		},
		carry: async (to) => {
			if (!m.ctx) throw new Error("the session isn't there to carry.");
			await carryThisSession(m.ctx, to, { timing: { lapsed } });
		},
		carryUnderWay: () => {
			const session = sessionOf();
			return session === undefined ? undefined : carryUnderWay(session);
		},
	});
	// A host's conversation has no window of its own to hand over.
	const handOver = () =>
		m.ctx?.hasUI && m.peer && m.hostKey === undefined
			? handOverOf({
					env,
					pid: senderIdentity().pid,
					args: process.argv.slice(2),
					session: m.peer.session,
					sessionFile: m.ctx.sessionManager.getSessionFile(),
				})
			: undefined;
	// A carry its orchestrator ordered through the node, or the node chose
	// (ordered-carry.ts).
	const ordering = createOrderedCarrying({
		idle: () => m.ctx?.isIdle?.() ?? true,
		abort: () => {
			// Ended from outside, as Pause ends a run: away mode stays on.
			if (!m.ctx) return;
			stoppingFromOutside(m.ctx);
			m.ctx.abort?.();
		},
		holds: (runEnded) =>
			orderedHolds(
				{
					ctx: m.ctx,
					events: pi.events,
					prompts: m.prompts,
					board,
					session: m.peer?.session ?? "",
					ownCarry: orderedHold,
				},
				runEnded,
			),
		hold: (to) => {
			const hold = holdForCarry(sessionOf() ?? "", to, { lapsed });
			orderedHold = hold;
			return {
				release: () => {
					hold.release();
					if (orderedHold === hold) orderedHold = undefined;
				},
				carried: () => hold.carried(),
			};
		},
		carry: async (to) => {
			if (!m.ctx) throw new Error("the session isn't there to carry.");
			await carryThisSession(m.ctx, to, {
				...(orderedHold ? { hold: orderedHold } : { timing: { lapsed } }),
			});
		},
		refuse: async (why, at) => {
			if (!m.peer) throw new Error("the session isn't on the mesh yet");
			await refuseInHandover(m.peer.session, why, at);
		},
		tell: (text) => notify(text, "info"),
		// Another carry than this ordering's own, as a person's Carry is.
		carrying: () => {
			const session = sessionOf();
			return (
				session !== undefined &&
				carryUnderWay(session, orderedHold ? { except: orderedHold } : {}) !==
					undefined
			);
		},
		close: (by, failed, closed) => {
			if (!m.ctx) throw new Error("the session has no context to close");
			endConversation(m.ctx, by, failed, closed);
		},
		carryOn: (text) => pi.sendUserMessage(text),
		// Every job still running; the carry names only those that read as
		// waits, since a fleet or a round is carried rather than stopped, so
		// only a shell job's label is read when its command wasn't kept.
		stopping: () => {
			const waits = new Set(waitingCalls.values());
			return (findJobHost(pi.events)?.running?.() ?? []).map((job) => ({
				label: job.label,
				waits: job.kind === "shell" ? waits.has(job.id) || undefined : false,
			}));
		},
		// Idle, pi writes it into the log at once, so the log carries it.
		note: (text) =>
			pi.sendMessage(
				{ customType: CARRY_NOTE, content: text, display: true },
				{ triggerTurn: false },
			),
	});
	// The hold this window's moves keep on a session's reload, which knows
	// the session it holds, so a stop lets go of that one after its peer
	// has gone.
	const reloadHold = moveHolder();
	// Move into a host or out of one, from outside the window (moving.ts).
	const moving = createMoving({
		holdReloads: (to) => reloadHold.hold(m.peer?.session, to),
		letReloadsGo: () => reloadHold.letGo(),
		holds: () => holdsOf(m.ctx, pi.events, m.prompts),
		hosted: () => m.hostKey !== undefined,
		moving: () => m.peer?.moving,
		setMoving: (one) => m.peer?.setMoving(one),
		calledOff: (off) => m.peer?.callOffMove(off),
		note: (to) => {
			if (!m.ctx || !m.peer)
				throw new Error("the session isn't there to move.");
			const said = presences.of(m.peer.session);
			const quest = said?.quest;
			const pid = said?.owner?.pid;
			if (pid === undefined)
				throw new Error("its presence names no owner to watch end.");
			const title = m.ctx.sessionManager.getSessionName();
			// The fence and spawner go with it, as a holder's restart takes them.
			const carried = carriedEnvironment(env);
			writeMoveNote(
				moveNoteOf(
					m.ctx,
					{
						session: m.peer.session,
						cwd: sessionCwd(m.ctx),
						addresses: m.peer.addresses,
						...(quest ? { quest } : {}),
						...(title ? { title } : {}),
						...(m.hostKey ? { from: m.hostKey } : {}),
						pid,
						...(carried ? { env: carried } : {}),
					},
					to,
				),
			);
			// What its host decided of the folder goes with it to plain pi.
			if (to === "pi" && m.ctx.isProjectTrusted())
				forgetUntrusted(m.peer.session);
			else if (to === "pi") leaveUntrusted(m.peer.session, sessionCwd(m.ctx));
		},
		handOver,
		keyedAt: () => m.keyedAt,
		tell: (text) => {
			if (m.ctx?.hasUI) m.ctx.ui.notify(text, "info");
		},
		close: (by) => {
			if (m.ctx) endConversation(m.ctx, by);
		},
		// Through its host, so a window viewing it carries on as plain pi.
		release: async (by) => {
			const owner = m.peer ? presences.of(m.peer.session)?.owner : undefined;
			return (
				owner !== undefined && (await releaseThroughHost(owner, by)) === "ended"
			);
		},
		// Plain pi reads the record on its return and carries the run on.
		cutRun: (by) => {
			if (!m.ctx || m.hostKey === undefined) return;
			pi.appendEntry(CUT_OFF_ENTRY, cutByMove(by, Date.now()));
			stoppingFromOutside(m.ctx);
			m.ctx.abort?.();
		},
	});
	const m: MeshState = {
		pi,
		paths,
		env,
		settling,
		waitCheckMs,
		lookAgainMs,
		hubTiming,
		transport,
		asWritten,
		asWrittenOff,
		presences,
		workerLink,
		glances,
		damper,
		board,
		crossings,
		tidy,
		unowned,
		takenUnowned,
		waitingCalls,
		leasing,
		answered,
		left,
		owing,
		awaiting,
		waiting,
		settleWatch,
		wanting,
		unlanded,
		undone,
		seen,
		unjudgedSaid,
		holdTurn,
		talks,
		pausing,
		handOver,
		ordering,
		moving,
		own: undefined,
		live: undefined,
		untellAwaited: undefined,
		flows: Promise.resolve([]),
		unhearPresent: undefined,
		leftTo: undefined,
		signed: undefined,
		resumes: undefined,
		waitClock: undefined,
		acts: undefined,
		ctx: undefined,
		peer: undefined,
		quiet: false,
		keptOff: 0,
		woken: false,
		startCaughtUp: false,
		turnAsked: false,
		handedNow: 0,
		call: undefined,
		hideWants: undefined,
		settleClock: undefined,
		onNoModelUntold: undefined,
		toldOnNoModel: false,
		endingsUntold: [],
		classifier: undefined,
		stopWatching: undefined,
		caughtUpFrom: undefined,
		front: createReadFront(),
		lookClock: undefined,
		hub: undefined,
		looksClock: undefined,
		steering: undefined,
		steerRoot: undefined,
		restartAsked: undefined,
		prompts: 0,
		keyedAt: Number.NEGATIVE_INFINITY,
		unhearKeys: undefined,
		hostKey: undefined,
	};
	const waits = createWaits(m);
	return m;
}

/**
 * The link to the node's worker socket where the machine names one, each
 * message it hears kept in the folder at `messages`, and each refusal
 * shown without starting a turn; none where it names none.
 */
function workerLinkFor(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv,
	messages: string,
	local: Transport,
): WorkerLink | undefined {
	const socket = workerSocket(env);
	if (socket === undefined) return undefined;
	return createWorkerLink({
		socket,
		keep: keptIn(messages),
		// The session's own sends are kept here before the node has them,
		// so the link takes up from what it heard from others, or read.
		held: () => local.recentIds(),
		lastRead: (addresses) => local.lastRead(addresses),
		refused: (refusal) =>
			pi.sendMessage(
				{
					customType: WORKER_REFUSED,
					content: refusalText(refusal),
					display: true,
				},
				{ triggerTurn: false },
			),
	});
}
