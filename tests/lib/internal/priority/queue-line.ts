/**
 * What the queue's rule tests share: a fixed now, a roomy and a busy
 * machine, and a waiting build to vary.
 */

import {
	type Job,
	MOST_CPU_PRESSURE_BESIDE_VMS,
} from "../../../../lib/internal/priority/queue.ts";

/** The moment every rule test is read at. */
export const NOW = Date.parse("2026-10-22T16:00:00Z");
/** A machine with memory free and no pressure. */
export const ROOMY = {
	availableGib: 40,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 0,
};
/** A roomy machine whose CPU pressure is at the most beside VMs. */
export const BUSY = { ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS };

/** A build waiting a minute, with `over` laid over it. */
export function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "nix build",
		owner: { session: "s", pid: 1 },
		since: new Date(NOW - 60_000).toISOString(),
		cappable: true,
		...over,
	};
}

/** When a job started `ms` before {@link NOW}. */
export const startedAgo = (ms: number) => new Date(NOW - ms).toISOString();
