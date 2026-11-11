/**
 * The session's tree broker, and the built-in provider under it.
 *
 * Caching belongs here rather than in the library, the way it
 * does for the review engine: the library builds a broker from
 * whatever it is handed, and the extension owns how long one
 * lives.
 *
 * The roster is passed as a function rather than an array, which
 * matters more than it looks. Providers register over the bus and
 * load order between extensions is nobody's choice, so a broker
 * that snapshotted its roster would never consult a provider that
 * registered later. That bug shipped once already, in the broker's
 * own first version.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Exec, spawnExec } from "../../lib/core/exec/index.ts";
import { sessionSlot } from "../../lib/core/session/index.ts";
import {
	createTreeBroker,
	type TreeBroker,
} from "../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../lib/core/work/memory.ts";
import {
	type Objection,
	type PublishIntent,
	WORK_PUBLISH_CHECK,
} from "../../lib/core/work/objection.ts";
import { createGitTreeProvider } from "../../lib/core/work/providers/git.ts";
import {
	listTreeProviders,
	registerTreeProvider,
} from "../../lib/core/work/register.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	QUEUED_LIMIT_MS,
	queuedExec,
} from "../../lib/internal/priority/queued-exec.ts";
import { gitRules } from "../../lib/internal/sandbox.ts";
import { guardedExec } from "../../lib/internal/tree-git.ts";
import { unattendedExec } from "../../lib/internal/unattended-exec.ts";
import { cutTreeDir, treeRecordDir } from "../../lib/internal/work-records.ts";
import { createFleetLedger } from "../../lib/subagent/fleet.ts";

/** Where trees this package cuts are put. */
export function treeDir(): string {
	return cutTreeDir();
}

/**
 * Register the tree providers this package ships. Idempotent,
 * since the registry survives module reimport but not a reload.
 *
 * Their git runs unattended rather than through the host's exec, which
 * shares pi's terminal: a passphrase or credential prompt there is drawn
 * over pi's interface and waits for keys that never reach it. A call
 * that can be stopped gets git carrying its signal, so Escape ends git
 * itself rather than only the promise waiting on it. Heavy work, as a
 * push or fetch of World, waits its turn in the machine's queue as the
 * bash tool's does, on a clock that counts the wait.
 */
export function registerBuiltinTreeProviders(_pi: ExtensionAPI): void {
	registerTreeProvider(
		createGitTreeProvider({
			exec: treeExec(),
			execFor: treeExec,
			stateDir: treeDir(),
		}),
	);
}

/**
 * The tree provider's git: unattended, queued when it is heavy, and in
 * either case held to the folders it may run in (`tree-git.ts`).
 */
function treeExec(signal?: AbortSignal): Exec {
	return queuedExec(
		unattendedExec(signal),
		guardedExec(
			spawnExec({
				...(signal ? { signal } : {}),
				timeoutMs: QUEUED_LIMIT_MS,
			}),
			gitRules,
		),
	);
}

/**
 * One conversation's broker and the pi sessions each tree it takes up
 * names: its own, and in a subagent the session that ran its fleet.
 *
 * Kept in a session slot rather than module state, since a host runs
 * several conversations in one process and a tree taken up by A must
 * not name B because B started last. On plain pi the slot is the one
 * process symbol it always was.
 */
interface BrokerState {
	sessions: readonly string[];
	broker?: TreeBroker;
}

const BROKER_STATE = "agentic-harness.work.broker.v1";

/** This conversation's state, by explicit id or the ambient session. */
function state(id?: string): BrokerState {
	return sessionSlot<BrokerState>(BROKER_STATE, id, () => ({ sessions: [] }));
}

/**
 * Say which pi session this process now runs, for the trees it takes up.
 *
 * A subagent's own session ends with its job, while the session that ran
 * it goes on and may send another job back into the same tree, as a
 * lane does; so its trees name that session too, read from the fleet's
 * record by the run id the supervisor hands every job.
 */
export async function treesHeldBySession(
	id: string | undefined,
	runId: string | undefined = process.env.SUBAGENT_RUN_ID,
): Promise<void> {
	const ours = state(id);
	ours.sessions = id === undefined ? [] : [id];
	if (runId === undefined) return;
	try {
		const { runs } = await createFleetLedger(
			join(stateDir("subagent-workflow"), "fleets"),
		).everyFleet();
		const ran = runs.find((one) => one.id === runId)?.session;
		if (ran !== undefined && ran !== id)
			ours.sessions = [...ours.sessions, ran];
	} catch {
		// A ledger that won't read leaves the trees naming this session
		// alone, as they did before subagents' trees named their fleet's.
	}
}

/** The session's broker, built on first use. */
export function treeBroker(): TreeBroker {
	const ours = state();
	if (!ours.broker) {
		ours.broker = createTreeBroker({
			providers: () => listTreeProviders(),
			// Given a memory here and nowhere else, because this is the one
			// broker that outlives nothing and needs to: a session ends with its
			// trees still on disk, and without this the next one cannot see
			// them, cannot push what is committed in them, and cannot release
			// them either.
			memory: createTreeMemory(treeRecordDir(), {
				sessions: () => ours.sessions,
			}),
		});
	}
	return ours.broker;
}

/** Drop this conversation's cached broker, so its next call rebuilds it. */
export function forgetTreeBroker(id?: string): void {
	state(id).broker = undefined;
}

/**
 * How long to wait for anybody to object to a publish.
 *
 * A listener has to reach a backend to answer, so this cannot be instant. It is
 * short because the failure mode of waiting is worse than the failure mode of
 * not: a push that hangs looks broken, while a push that goes ahead is what
 * would have happened anyway without the check.
 */
const OBJECTION_GRACE_MS = 4000;

/**
 * Ask whether anybody objects to publishing, and collect what comes back.
 *
 * Advisory on purpose. A listener that throws, hangs or is not there does not
 * stop a push, because a working layer that stops working when an unrelated
 * extension has a bad day is worse than one that occasionally publishes
 * something it might have been warned about.
 *
 * The wait is bounded for the same reason. Nothing is required to answer, so
 * there is no completion to wait for, only a grace period.
 */
export async function objectionsTo(
	pi: ExtensionAPI,
	intent: PublishIntent,
): Promise<readonly Objection[]> {
	const objections: Objection[] = [];
	const pending: Promise<unknown>[] = [];
	try {
		pi.events.emit(WORK_PUBLISH_CHECK, {
			intent,
			object(objection: Objection) {
				objections.push(objection);
			},
			// A listener that needs to reach a backend hands back its promise,
			// so the wait is as long as the answer takes rather than a guess.
			waitFor(work: Promise<unknown>) {
				pending.push(work);
			},
		});
	} catch {
		// A throwing listener is that listener's problem. It does not get to
		// decide whether this push happens.
		return objections;
	}
	if (pending.length > 0) {
		await Promise.race([
			Promise.allSettled(pending),
			new Promise((done) => setTimeout(done, OBJECTION_GRACE_MS)),
		]);
	}
	return objections;
}
