/**
 * A host's children, put together: the routes a child's conversation
 * answers at, the supervisor that starts and watches each child, and the
 * policy that says which conversations move. The backend asks it to wake,
 * open and resume in children; the server routes by its routes.
 *
 * A child that ends parked leaves its conversation held and resting, so
 * the host watches its wake again (the engine's restsParked) and a wake
 * starts a child for it anew. No process runs for a parked conversation.
 */

import type { RosterEntry } from "../../lib/core/session/roster.ts";
import type { BackendChildren } from "./backend.ts";
import type { ChildPolicy } from "./child-policy.ts";
import {
	type ChildSupervisor,
	childSupervisor,
	type KeptRoster,
} from "./child-supervisor.ts";
import type { Units } from "./child-units.ts";
import type { ChildEnding } from "./child-watch.ts";
import { type HeldChildren, heldChildren } from "./children.ts";

/** A host's children, as the backend, the server and its stop use them. */
export interface HostedChildren {
	/** What the backend asks to wake, open and resume in children. */
	readonly backend: BackendChildren;
	/** Where each conversation a child runs answers. */
	readonly routes: HeldChildren;
	/** Take up every child an earlier host left running. */
	adopt(): Promise<number>;
	/** Stop watching children and the policy, leaving each child running. */
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
	report: (error: unknown) => void;
	say?: (line: string) => void;
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
		ended: (sessionId, why) => rest(sessionId, why),
		...options.timings,
	});

	// One left parked, or whose child failed, is still held: the host
	// watches its wake again so a message or a window brings it back.
	function rest(sessionId: string, why: ChildEnding): void {
		if (why !== "parked" && why !== "failed") return;
		const entry = roster
			.entries()
			.find((held) => held.sessionId === sessionId);
		if (!entry) return;
		try {
			if (!options.restsParked?.(entry))
				options.say?.(
					`${sessionId}: its child ended ${why}, and nothing watches its wake until it is asked for`,
				);
		} catch (error) {
			report(error);
		}
	}

	return {
		backend: {
			moves: (sessionId) => policy.moves(sessionId),
			opens: () => policy.opens(),
			running: (sessionId) =>
				routes.listed().find((held) => held.sessionId === sessionId),
			resume: (entry, woken) => supervisor.resume(entry, woken),
			begin: (request) => supervisor.begin(request),
		},
		routes,
		adopt: () => supervisor.adopt(),
		close() {
			supervisor.close();
			policy.close();
		},
	};
}
