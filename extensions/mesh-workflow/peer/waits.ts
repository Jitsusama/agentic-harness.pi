/**
 * The holds a peer waits on and what it raised for the person: asked about
 * on a clock while any stands, and told once settled.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { NOTED } from "../delivery.ts";
import type { HoldEnd } from "../leases.ts";
import { settledText } from "../wait.ts";
import type { MeshState } from "./mesh.ts";

/** What the clocks over this peer's waits read and set. */
export type WaitsOn = Pick<
	MeshState,
	"settleWatch" | "waitClock" | "settleClock" | "turnAsked" | "waitCheckMs"
> & {
	readonly pi: Pick<ExtensionAPI, "sendMessage">;
	readonly ctx: Pick<ExtensionContext, "isIdle"> | undefined;
	readonly pausing: { readonly paused: boolean };
	readonly leasing: Pick<MeshState["leasing"], "lapsed" | "resumed">;
	readonly own: Pick<NonNullable<MeshState["own"]>, "leases"> | undefined;
	readonly resumes: Pick<NonNullable<MeshState["resumes"]>, "add"> | undefined;
};

/**
 * Carry on from a hold that is over once this peer's turn on it comes,
 * `end.after` from now, letting go of its wait then: every waiter of a
 * hold hears its end within seconds, so without turns they all started
 * at once (load 99 after the hold of 24 November, 10:40). A run under
 * way is told then too, as a note, and starts nothing.
 */
export function resumeInTurn(
	m: Pick<WaitsOn, "leasing" | "resumes">,
	end: HoldEnd,
): void {
	const turn = setTimeout(() => {
		try {
			m.leasing.resumed(end);
		} catch {
			// The board is being replaced or gone with the session: the wait
			// lapses with its hold, and the turn below still comes.
		}
		// Read as the turn comes, since a session that ended in between
		// stopped its own and a new start made another.
		m.resumes?.add(end);
	}, end.after);
	// A turn to come never keeps a pi running that is otherwise done.
	turn.unref?.();
}

/** The clocks over what this peer waits on. */
export function createWaits(m: WaitsOn) {
	/** Whether the holds waited on still stand, asked while any is. */
	const checkWaits = async () => {
		const ends = await m.leasing.lapsed().catch(() => []);
		for (const end of ends) resumeInTurn(m, end);
		if (!m.own?.leases.some((lease) => lease.kind === "wait")) {
			clearInterval(m.waitClock);
			m.waitClock = undefined;
		}
	};
	/**
	 * Tell this session what it raised for the person has settled: a
	 * turn of its own when idle, since a run that ended Blocked on him
	 * has nothing else to wake it, and after the run under way if not.
	 * It reads off the thread: a host ticks it each minute for every
	 * conversation that raised something.
	 */
	const tellSettled = async () => {
		const watch = m.settleWatch;
		const clock = m.settleClock;
		if (!watch || !clock || !m.ctx) return;
		let gone: Awaited<ReturnType<typeof watch.settledOff>>;
		let idle: boolean;
		try {
			gone = await watch.settledOff();
			// The session went while it read: shutdown clears the clock, and a
			// new start replaces it.
			if (m.settleClock !== clock || !m.ctx) return;
			idle = m.ctx.isIdle?.() ?? false;
		} catch {
			// A file being replaced or a stale context: the next tick looks again.
			return;
		}
		if (!watch.watching()) {
			clearInterval(m.settleClock);
			m.settleClock = undefined;
		}
		if (gone.length === 0) return;
		const message = {
			customType: NOTED,
			content: settledText(gone),
			display: true,
		};
		if (!idle) {
			m.pi.sendMessage(message, { deliverAs: "followUp" });
			return;
		}
		const turn = !m.turnAsked && !m.pausing.paused;
		if (turn) m.turnAsked = true;
		m.pi.sendMessage(message, { triggerTurn: turn });
	};
	const watchSettled = () => {
		if (m.settleClock || !m.settleWatch?.watching()) return;
		m.settleClock = setInterval(() => void tellSettled(), m.waitCheckMs);
		m.settleClock.unref?.();
	};

	const watchWaits = () => {
		if (m.waitClock || !m.own?.leases.some((lease) => lease.kind === "wait")) {
			return;
		}
		m.waitClock = setInterval(() => void checkWaits(), m.waitCheckMs);
		m.waitClock.unref?.();
	};

	return { checkWaits, tellSettled, watchSettled, watchWaits };
}

/** What createWaits gives the modules after it. */
export type Waits = ReturnType<typeof createWaits>;
