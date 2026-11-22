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
import { sayWriteFailed } from "../../../lib/internal/write-whole.ts";
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
import { folderTransport } from "../../../lib/mesh/transport.ts";
import type { Want, WantKind } from "../../../lib/mesh/want.ts";
import type { Settling } from "../acts.ts";
import { carryThisSession } from "../carrying.ts";
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
	// Everything here reads a receptor's name as nothing, but delivery and
	// mesh_read, which ask the node to vouch for it (lib/mesh/receptor.ts).
	const { transport, asWritten, asWrittenOff } = heedingNoReceptor(
		folderTransport(join(paths.mesh, "messages")),
	);
	// A host writes presence and leases off its thread; one that can't
	// land is said once in the session's log and the host's journal, and
	// written again.
	const failed = sayWriteFailed((type, data) => pi.appendEntry(type, data));
	const presences = createPresences(join(paths.mesh, "presence"), { failed });
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
		tell: (text) => {
			if (m.ctx?.hasUI) m.ctx.ui.notify(text, "info");
		},
		// A host's standard error is its journal; plain pi's window said it.
		journal: (text) => {
			if (!hosted()) return;
			const session = m.ctx?.sessionManager.getSessionId() ?? "unknown";
			process.stderr.write(`pausing ${session}: ${text}\n`);
		},
		// Plain pi waits until it is idle, so the run just ended winds down
		// first; a host closes it as a Close over its socket does.
		close: (by) => {
			if (m.ctx) endConversation(m.ctx, by);
		},
		carry: async (to) => {
			if (!m.ctx) throw new Error("the session isn't there to carry.");
			await carryThisSession(m.ctx, to);
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
				},
				runEnded,
			),
		carry: async (to) => {
			if (!m.ctx) throw new Error("the session isn't there to carry.");
			await carryThisSession(m.ctx, to);
		},
		refuse: async (why, at) => {
			if (!m.peer) throw new Error("the session isn't on the mesh yet");
			await refuseInHandover(m.peer.session, why, at);
		},
		tell: (text) => {
			if (m.ctx?.hasUI) m.ctx.ui.notify(text, "info");
		},
		close: (by) => {
			if (m.ctx) endConversation(m.ctx, by);
		},
		carryOn: (text) => pi.sendUserMessage(text),
	});
	// Move into a host or out of one, from outside the window (moving.ts).
	const moving = createMoving({
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
		glances,
		damper,
		board,
		crossings,
		tidy,
		unowned,
		takenUnowned,
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
