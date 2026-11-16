/**
 * A session starting as a peer: its presence, leases and clocks, a fresh
 * watch on the mesh, and a catch-up on what it missed.
 */

import {
	type FoundClassifier,
	findClassifier,
} from "../../../lib/classifier/jev.ts";
import {
	hosted,
	sessionCwd,
	sessionEnv,
	sessionKeyOf,
	sessionOwner,
} from "../../../lib/core/session/index.ts";
import { tellAwaited } from "../../../lib/internal/priority/awaited.ts";
import { isPersonWords } from "../../../lib/internal/session/driven.ts";
import { sessionLeft } from "../../../lib/internal/session/left.ts";
import { carriedBy } from "../../../lib/internal/session/rollover.ts";
import { showWants } from "../../../lib/internal/session/wants.ts";
import { writerHold } from "../../../lib/internal/session/writer-hold.ts";
import { singleFlight } from "../../../lib/internal/single-flight.ts";
import { loadedQuest } from "../../../lib/mesh/address.ts";
import { MESH_SESSION_ENV } from "../../../lib/mesh/hand.ts";
import { landingKeeper } from "../../../lib/mesh/landing-history.ts";
import { carryLeases, ownLeases } from "../../../lib/mesh/lease.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { nodeSocket } from "../../../lib/mesh/node.ts";
import { localPeer } from "../../../lib/mesh/peer.ts";
import { questEnded, windowTitle } from "../../../lib/mesh/presence.ts";
import { keepPresent, whenPresent } from "../../../lib/mesh/present.ts";
import { createReadFront, seenAtStart } from "../../../lib/mesh/reading.ts";
import { usageFromLog } from "../../../lib/mesh/usage.ts";
import { identifyCurrentTerminal } from "../../../lib/terminal/resolve.ts";
import type { TerminalSessionHandle } from "../../../lib/terminal/types.ts";
import { createActs } from "../acts.ts";
import { type Entry, handedIn, leftToIn, saidIn } from "../glances.ts";
import { hostedPresence } from "../in-place.ts";
import { fenceKindOf } from "../ordered-carry.ts";
import { keptOffIn, quietIn } from "../quiet.ts";
import { markOwnerRunning, settleFromVerdicts } from "../wait.ts";
import type { Handing } from "./handing.ts";
import type { Hearing } from "./hearing.ts";
import type { HeavyWork } from "./heavy.ts";
import { keepLooksFor, LOOKS_CHECK_MS } from "./looks.ts";
import {
	isEphemeral,
	MESH_CLASSIFIER_ENV,
	MESH_ENV,
	type MeshState,
} from "./mesh.ts";
import type { Steerer } from "./steerer.ts";
import type { Waits } from "./waits.ts";

/**
 * How far back a peer that has never read anything catches up.
 *
 * An hour rather than everything: what was said before then was said
 * to peers that were there, and a new one handed a day of other peers'
 * coordination has nothing to do with it but read it.
 */
const FIRST_CATCH_UP_MS = 60 * 60 * 1000;

/** The name the mesh carries its peer's session under across a rollover. */
export const CARRY_NAME = "mesh";

/** The session a rolled-over log carried on from, as the mesh carried it. */
/**
 * Where the node serves, read from `env` alone. Made out here because
 * the connection keeps it past this load, and a closure made in
 * session_start would keep that session and its harness with it.
 */
function nodeAt(env: NodeJS.ProcessEnv): () => string | undefined {
	return () => nodeSocket(env);
}

function previousSession(carried: unknown): string | undefined {
	const session = (carried as { session?: unknown } | undefined)?.session;
	return typeof session === "string" && session !== "" ? session : undefined;
}

/**
 * The terminal window this session runs in, for its presence, or nothing
 * when no driver names one. A driver that fails to say costs only the
 * field: the desktop then finds this peer by its title, as before.
 */
function terminalOf(): { terminal?: TerminalSessionHandle } {
	try {
		const terminal = identifyCurrentTerminal();
		return terminal ? { terminal } : {};
	} catch {
		return {};
	}
}

/** Make this peer anew as each session starts. */
export function onSessionStart(
	m: MeshState,
	f: Waits & Handing & Steerer & Hearing & HeavyWork,
) {
	m.pi.on("session_start", async (_event, started) => {
		if (isEphemeral(started.sessionManager) || m.env[MESH_ENV] === "off") {
			return;
		}
		// A session this process rolled away from, started again, is no
		// peer: on 3 November one caught up on 13 messages the live
		// session it had become never got (lib/internal/session/left.ts).
		if (sessionLeft(started.sessionManager.getSessionId())) return;
		// A plain pi on a log a host holds ends at once, and its peer is
		// the host's: on 10 November one wrote its pid over it.
		if (!hosted() && (await writerHold(started.sessionManager.getSessionId())))
			return;
		m.ctx = started;
		m.unhearKeys?.();
		m.unhearKeys = started.hasUI
			? started.ui.onTerminalInput(() => {
					m.keyedAt = Date.now();
					return undefined;
				})
			: undefined;
		m.startCaughtUp = false;
		m.turnAsked = false;
		m.handedNow = 0;
		// The node hears this process end the moment it does, crash or
		// not; a reload keeps the one connection it already holds.
		keepPresent(nodeAt(m.env));
		f.askFlows();
		m.unhearPresent?.();
		m.unhearPresent = whenPresent(f.askFlows);
		// Named on its presence so others can ask the machine whether this
		// peer is still there; a peer the machine will not name is taken
		// as there, which only costs a sender a line.
		const owner = await sessionOwner(started).catch(() => undefined);
		const branch = (started.sessionManager.getBranch?.() ??
			[]) as readonly Entry[];
		const session = sessionKeyOf(started);
		// A log rolled over into a fresh one carries on as the same peer.
		const previous = previousSession(carriedBy(branch, CARRY_NAME));
		if (previous) carryLeases(m.board, previous, session);
		await f.countLive();
		m.untellAwaited?.();
		m.untellAwaited = tellAwaited(f.awaited);
		// Said already before a reload is not said again.
		m.leftTo = leftToIn(branch);
		m.quiet = quietIn(branch);
		m.keptOff = keptOffIn(branch);
		f.showQuiet();
		m.signed = undefined;
		const host = hosted();
		m.hostKey = host?.key;
		m.peer = localPeer({
			live: () => m.live,
			session,
			cwd: sessionCwd(started),
			records: m.paths,
			presences: m.presences,
			// Read at each publish, so the desktop matches this peer's
			// window by its exact title after a quest renames the session.
			title: () =>
				windowTitle(
					started.sessionManager.getSessionName(),
					started.sessionManager.getCwd(),
				),
			...(owner ? { owner } : {}),
			...(host
				? {
						hosted: hostedPresence(
							host.key,
							session,
							started.sessionManager.getSessionFile(),
							m.env,
						),
					}
				: {}),
			...(previous ? { previous } : {}),
			...terminalOf(),
			// Kept a month past the presence, for the desktop's Landed.
			history: landingKeeper(m.paths.mesh),
			// Which mycelium matches against the machine it carries to.
			fence: fenceKindOf(m.env),
		});
		for (const want of m.wanting.values()) m.peer.want(want);
		// A move asked before a reload goes on waiting for the session.
		if (m.peer.moving) m.moving.look();
		// Read from the log pi holds, so the cutover need read no log.
		if (branch.some(isPersonWords)) m.peer.setDriven();
		// Today's usage, carried in its last presence or counted from its log.
		if (!m.peer.usage) {
			m.peer.setUsage(usageFromLog(branch, new Date()));
		}
		m.hideWants?.();
		m.hideWants = showWants();
		for (const landing of m.unlanded.splice(0)) m.peer.landed(landing);
		for (const event of m.undone.splice(0)) m.peer.did(event);
		if (m.onNoModelUntold) f.tellNoModel(m.onNoModelUntold);
		if (m.waiting) {
			settleFromVerdicts(m.waiting);
			markOwnerRunning(m.waiting, true);
			// The first look learns what waits; what settles after is told.
			try {
				m.settleWatch?.settled();
			} catch {
				// A file being replaced: the next change this session makes looks again.
			}
			f.watchSettled();
		}
		// Named to whatever this process starts, so a subagent knows whose
		// hands it is.
		if (hosted()) sessionEnv(started).set(MESH_SESSION_ENV, m.peer.session);
		else m.env[MESH_SESSION_ENV] = m.peer.session;
		m.glances.recover(branch);
		m.damper.recover(saidIn(branch));
		m.acts?.stop();
		m.acts = createActs(m.peer.session, m.settling, (waiting) => {
			void f.settled(waiting);
		});
		m.resumes?.stop();
		m.resumes = createActs(m.peer.session, m.settling, f.resumed);
		// Its holds and waits outlive a reload; what a run claimed does not.
		m.own = ownLeases(m.board, m.peer.session);
		// Restored after a reboot, nothing it claimed is under way.
		m.leasing.forgetEarlierBoots();
		for (const event of m.unowned.splice(0)) f.claim(event);
		for (const [toolCallId, label] of m.takenUnowned.splice(0))
			f.heavyCalls.called(toolCallId, label);
		clearInterval(m.waitClock);
		m.waitClock = undefined;
		f.watchWaits();
		// Looked for once a session, not once a message, and not waited
		// on: a message judged before it is found waits for it, briefly.
		m.classifier = findClassifier(
			started,
			m.env[MESH_CLASSIFIER_ENV],
			MESH_CLASSIFIER_ENV,
		).catch(
			(error): FoundClassifier => ({
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			}),
		);
		// A peer reads afresh: what another session took is not this one's,
		// and what this one handed over before a reload its entries say.
		m.seen.clear();
		m.left.clear();
		for (const id of handedIn(branch)) m.seen.add(id);
		m.front = createReadFront();
		// Watching before looking, so what lands between the two is heard
		// by one of them, and seen keeps it to once.
		m.stopWatching?.();
		m.stopWatching = undefined;
		try {
			m.stopWatching = m.transport.watch((id) => {
				const message = f.take(id);
				if (message) void f.route([message]);
			});
		} catch (error) {
			// A transport that cannot be watched leaves this peer slow to
			// hear, which nothing else would show.
			if (started.hasUI) {
				started.ui.notify(
					`Mesh: cannot watch for messages (${error instanceof Error ? error.message : String(error)}), so this session looks for them once a minute instead.`,
					"warning",
				);
			}
		}
		clearInterval(m.lookClock);
		m.lookClock = setInterval(f.lookAgain, m.lookAgainMs);
		m.lookClock.unref?.();
		clearInterval(m.looksClock);
		const looksDir = m.paths.looks;
		if (looksDir) {
			const asking = m.peer.session;
			const questsDir = m.paths.quests;
			// A tick that comes while the last still reads is passed over.
			const keeping = singleFlight<string, void>();
			m.looksClock = setInterval(() => {
				const quest = loadedQuest(asking, m.paths.sessions);
				const owner = { session: asking, ...(quest ? { quest } : {}) };
				// A quest ended in another session, or before this one began.
				const ended = (one: string) => questEnded(questsDir, one);
				keeping(looksDir, () =>
					keepLooksFor(m.pi, looksDir, owner, ended),
				).catch(() => {
					// The looks unreadable now: kept again on the next tick.
				});
				// Asks a session of this quest left as it ended come here, so
				// Needs You sends the person to one that runs.
				if (m.waiting) markOwnerRunning(m.waiting, true);
			}, LOOKS_CHECK_MS);
			m.looksClock.unref?.();
		}
		const since =
			m.transport.lastRead(m.peer.addresses) ??
			`${Date.now() - FIRST_CATCH_UP_MS}`;
		m.caughtUpFrom = since;
		for (const id of seenAtStart(m.transport, since)) m.seen.add(id);
		const missed: Message[] = [];
		// Only the days a message after `since` can rest in: listing every
		// day's folder took 325 ms of a wake on 15 November, for ids then
		// passed by as read. What rests in the days before is never taken,
		// since a watcher and the minute's look list only the top.
		for (const id of m.transport.idsFromDayOf(since)) {
			if (id <= since) continue;
			const message = f.take(id);
			if (message) missed.push(message);
		}
		void f.route(missed, true).finally(() => {
			m.startCaughtUp = true;
			f.readWhatWaited();
		});
		f.steer(m.paths.steer);
		f.identity();
		void m.tidy();
		if (started.hasUI) {
			const groups =
				m.peer.groups.length > 0 ? `, in ${m.peer.groups.join(", ")}` : "";
			started.ui.notify(
				`Mesh: this peer is ${m.peer.addresses.join(" or ")}${groups}`,
				"info",
			);
		}
	});
}
