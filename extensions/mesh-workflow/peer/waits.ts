/**
 * The holds a peer waits on and what it raised for the person: asked about
 * on a clock while any stands, and told once settled.
 */

import { NOTED } from "../delivery.ts";
import { settledText } from "../wait.ts";
import type { MeshState } from "./mesh.ts";

/** The clocks over what this peer waits on. */
export function createWaits(m: MeshState) {
	/** Whether the holds waited on still stand, asked while any is. */
	const checkWaits = async () => {
		const ends = await m.leasing.lapsed().catch(() => []);
		for (const end of ends) m.resumes?.add(end);
		if (!m.own?.leases.some((lease) => lease.kind === "wait")) {
			clearInterval(m.waitClock);
			m.waitClock = undefined;
		}
	};
	/**
	 * Tell this session what it raised for the person has settled: a
	 * turn of its own when idle, since a run that ended Blocked on him
	 * has nothing else to wake it, and after the run under way if not.
	 */
	const tellSettled = () => {
		if (!m.settleWatch || !m.ctx) return;
		let gone: ReturnType<typeof m.settleWatch.settled>;
		let idle: boolean;
		try {
			gone = m.settleWatch.settled();
			idle = m.ctx.isIdle?.() ?? false;
		} catch {
			// A file being replaced or a stale context: the next tick looks again.
			return;
		}
		if (!m.settleWatch.watching()) {
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
		m.settleClock = setInterval(tellSettled, m.waitCheckMs);
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
