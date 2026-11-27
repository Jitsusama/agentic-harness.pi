/**
 * A host's children, put together: the routes a child's conversation
 * answers at, the supervisor that starts and watches each child, and the
 * policy that says which conversations move. The backend asks it to wake,
 * open and resume in children; the server routes by its routes.
 *
 * A child that ends parked leaves its conversation held and resting, so
 * the host watches its wake again (the engine's restsParked) and a wake
 * starts a child for it anew. No process runs for a parked conversation.
 * One whose child went mid-turn is woken at once instead, so a turn its
 * child was killed in carries on as a host's restart carries one on.
 */

import type { RosterEntry } from "../../lib/core/session/roster.ts";
import type { BackendChildren } from "./backend.ts";
import type { ChildPolicy } from "./child-policy.ts";
import { askOnce, reach } from "./child-requests.ts";
import {
	type ChildSupervisor,
	childSupervisor,
	type KeptRoster,
} from "./child-supervisor.ts";
import type { Units } from "./child-units.ts";
import type { ChildEnding } from "./child-watch.ts";
import { type HeldChildren, heldChildren, passedOn } from "./children.ts";
import { hostRefusal } from "./dispatch.ts";
import type { ControlRequest } from "./protocol.ts";
import { versionsMove } from "./what-starts.ts";

/**
 * How long after one whose child went mid-turn is woken a second such
 * ending leaves it resting, so a turn that kills its child each time
 * starts no child after child.
 */
export const WOKEN_AGAIN_AFTER_MS = 10 * 60_000;

/** A host's children, as the backend, the server and its stop use them. */
export interface HostedChildren {
	/** What the backend asks to wake, open and resume in children. */
	readonly backend: BackendChildren;
	/** Where each conversation a child runs answers. */
	readonly routes: HeldChildren;
	/** Take up every child an earlier host left running. */
	adopt(): Promise<number>;
	/**
	 * Stop watching children and the policy, leaving each child running
	 * but an untaken warm spare, which runs no conversation and is stopped.
	 */
	close(): void;
}

/** Put a host's children together over its roster and engine. */
export function hostChildren(options: {
	key: string;
	folder: string;
	units: Units;
	policy: ChildPolicy;
	roster: KeptRoster;
	/** Rest a conversation parked, watching its wake: the engine's. */
	restsParked?: (entry: RosterEntry) => boolean;
	/**
	 * Rest one whose child was given up, writing its marker, answering
	 * nothing, or why it can't: the engine's.
	 */
	restGivenUp?: (entry: RosterEntry) => string | undefined;
	report: (error: unknown) => void;
	say?: (line: string) => void;
	/** Wake a held conversation, as a message to it does: the backend's. */
	wake?: (sessionId: string) => Promise<void>;
	/** For tests: the clock a wake's spacing is read by. */
	now?: () => number;
	/** A child's conversation became another, as its supervisor heard. */
	became?: (previousId: string, nextId: string) => void;
	/** For tests: the supervisor's own timings. */
	timings?: Pick<
		Parameters<typeof childSupervisor>[0],
		"listensWithinMs" | "answersWithinMs" | "exitsWithinMs"
	>;
}): HostedChildren {
	const routes = heldChildren();
	const { roster, policy, report } = options;
	const supervisor: ChildSupervisor = childSupervisor({
		key: options.key,
		folder: options.folder,
		units: options.units,
		routes,
		roster,
		report,
		...(options.say ? { say: options.say } : {}),
		spares: () => policy.spares?.() ?? false,
		spareMoved: versionsMove(),
		ended: (sessionId, why, busy) => {
			rest(sessionId, why);
			if (why === "failed" && busy) wakeCutOff(sessionId);
		},
		// Given up before it ran there, so it never parked: still held.
		gaveUp: (sessionId) => restGivenUp(sessionId),
		...(options.became ? { became: options.became } : {}),
		...options.timings,
	});

	// One left parked, or whose child failed, is still held: the host
	// watches its wake again so a message or a window brings it back.
	// One restsParked declines, as one with no marker from this boot,
	// rests as given up, which writes the marker a park writes, or says
	// why it can't: on 23 November two children ended parked that
	// restsParked declined, and a hub slept unwatched for 19 minutes
	// until a window came.
	function rest(sessionId: string, why: ChildEnding): void {
		if (why !== "parked" && why !== "failed") return;
		const entry = roster.entries().find((held) => held.sessionId === sessionId);
		if (!entry) return;
		try {
			if (options.restsParked?.(entry)) return;
			const refused = options.restGivenUp
				? options.restGivenUp(entry)
				: "this engine rests none given up";
			if (refused !== undefined)
				options.say?.(
					`${sessionId}: its child ended ${why}, and nothing watches its wake until it is asked for, as ${refused}`,
				);
		} catch (error) {
			report(error);
		}
	}

	// A child that failed while busy, as one killed mid-turn does, left
	// words or a run nobody answered. Rested, it waited for a window or a
	// message, though a host's own restart carries every such run on. It
	// is woken at once, as a message wakes one, unless one woken so within
	// WOKEN_AGAIN_AFTER_MS failed the same way. A child that says it failed
	// while busy is woken too, since no word says which turn it left.
	const wokenAt = new Map<string, number>();
	const now = options.now ?? Date.now;
	function wakeCutOff(sessionId: string): void {
		const { wake } = options;
		if (!wake) return;
		const at = now();
		const last = wokenAt.get(sessionId);
		if (last !== undefined && at - last < WOKEN_AGAIN_AFTER_MS) {
			options.say?.(
				`${sessionId}: its child failed mid-turn again within ${WOKEN_AGAIN_AFTER_MS / 60_000} minutes of its last wake, so it rests until it is asked for`,
			);
			return;
		}
		wokenAt.set(sessionId, at);
		options.say?.(
			`${sessionId}: its child failed mid-turn, so it is woken to carry the turn on`,
		);
		// Said, not reported: a host stopping refuses every wake, as it should.
		wake(sessionId).catch((error: unknown) =>
			options.say?.(
				`${sessionId}: its wake after its child failed mid-turn didn't land: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	// One whose child was given up never parked, so restsParked would
	// decline it: it rests as given up, its marker written as a park's.
	function restGivenUp(sessionId: string): void {
		const entry = roster.entries().find((held) => held.sessionId === sessionId);
		if (!entry) return;
		try {
			const refused = options.restGivenUp
				? options.restGivenUp(entry)
				: "this engine rests none given up";
			if (refused !== undefined)
				options.say?.(
					`${sessionId}: its child was given up, and nothing watches its wake until it is asked for, as ${refused}`,
				);
		} catch (error) {
			report(error);
		}
	}

	// The policy moved it, so a child that can't start says so: on a
	// machine with no child unit, systemd's own refusal names no policy.
	async function resumed(entry: RosterEntry, woken: boolean, bounded = false) {
		try {
			return await supervisor.resume(entry, woken, bounded);
		} catch (error) {
			throw new Error(
				`${entry.sessionId} moves to a process of its own, as children.json says, which didn't start: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	// Asked once of the child, as the server asks a routed request.
	async function ask(sessionId: string, request: ControlRequest) {
		const route = routes.routeOf(sessionId);
		if (!route) throw new Error(`Conversation is not hosted: ${sessionId}`);
		const reply = await askOnce(
			await reach(route.socket),
			`${JSON.stringify(passedOn(request, route))}\n`,
			request.id,
			report,
		);
		if (!reply.ok) throw hostRefusal(reply.error.code, reply.error.message);
		return reply.result;
	}

	return {
		backend: {
			moves: (sessionId) => policy.moves(sessionId),
			opens: () => policy.opens(),
			running: (sessionId) =>
				routes.listed().find((held) => held.sessionId === sessionId),
			resume: resumed,
			hurry: (sessionId) => supervisor.hurry(sessionId),
			giveUp: (sessionId) => supervisor.giveUp(sessionId),
			begin: (request, taken) => supervisor.begin(request, taken),
			ask,
			left: (sessionId) => supervisor.left(sessionId),
		},
		routes,
		adopt: () => supervisor.adopt(),
		close() {
			supervisor.close();
			policy.close();
		},
	};
}
