import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "../../../../lib/internal/quest/process-liveness";
import {
	buildLivenessSnapshot,
	deriveLiveness,
	type LivenessSnapshot,
} from "../../../../lib/internal/quest/session-liveness";
import type { QuestSession } from "../../../../lib/quest/types";
import type {
	TerminalProbe,
	TerminalSessionHandle,
} from "../../../../lib/terminal/index";

const NOW = new Date("2026-06-04T12:00:00.000Z");
const RECENT = "2026-06-04T11:58:00.000Z";
const STALE = "2026-06-04T10:00:00.000Z";

function snapshot(over: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
	return {
		now: NOW,
		activity: new Map(),
		observations: new Map(),
		conflicted: new Set(),
		...over,
	};
}

const WITH_PROCESS: QuestSession = {
	id: "p1",
	status: "active",
	process: { hostId: "host-a", pid: 100, startToken: "tok" },
};
const WITH_PANE: QuestSession = {
	id: "t1",
	status: "active",
	terminal: { driverId: "wezterm", value: "5", scope: "/sock" },
};

describe("deriveLiveness over a snapshot", () => {
	it("reports detached first, even when a process matches", () => {
		const s: QuestSession = { ...WITH_PROCESS, status: "detached" };
		const snap = snapshot({
			observations: new Map([["p1", { process: "matching" }]]),
			activity: new Map([["p1", RECENT]]),
		});
		const view = deriveLiveness(s, snap);
		expect(view.liveness).toBe("detached");
		expect(view.lastActivity).toBe(RECENT);
	});

	it("reports conflicted when the snapshot marks the session conflicted", () => {
		const snap = snapshot({
			conflicted: new Set(["p1"]),
			observations: new Map([["p1", { process: "matching" }]]),
		});
		expect(deriveLiveness(WITH_PROCESS, snap).liveness).toBe("conflicted");
	});

	it("reports live when the process matches", () => {
		const snap = snapshot({
			observations: new Map([["p1", { process: "matching" }]]),
		});
		expect(deriveLiveness(WITH_PROCESS, snap).liveness).toBe("live");
	});

	it("reports dead when the process is gone, even with a stale open pane", () => {
		const s: QuestSession = { ...WITH_PROCESS, terminal: WITH_PANE.terminal };
		const snap = snapshot({
			observations: new Map([["p1", { process: "gone", pane: "present" }]]),
		});
		expect(deriveLiveness(s, snap).liveness).toBe("dead");
	});

	it("reports live for a present pane when the process is unknown", () => {
		const snap = snapshot({
			observations: new Map([["t1", { pane: "present" }]]),
		});
		expect(deriveLiveness(WITH_PANE, snap).liveness).toBe("live");
	});

	it("reports dead for an absent pane the probe could observe", () => {
		const snap = snapshot({
			observations: new Map([["t1", { pane: "absent" }]]),
		});
		expect(deriveLiveness(WITH_PANE, snap).liveness).toBe("dead");
	});

	it("reports unknown when every observation is unknown", () => {
		const snap = snapshot({
			observations: new Map([["t1", { pane: "unknown" }]]),
		});
		expect(deriveLiveness(WITH_PANE, snap).liveness).toBe("unknown");
	});

	it("falls back to recency for an identity-less record", () => {
		const legacy: QuestSession = { id: "L", status: "active" };
		expect(
			deriveLiveness(legacy, snapshot({ activity: new Map([["L", RECENT]]) }))
				.liveness,
		).toBe("live");
		expect(
			deriveLiveness(legacy, snapshot({ activity: new Map([["L", STALE]]) }))
				.liveness,
		).toBe("idle");
		expect(deriveLiveness(legacy, snapshot()).liveness).toBe("dead");
	});
});

describe("buildLivenessSnapshot", () => {
	it("probes each identity once and records the observations", async () => {
		const sessions: QuestSession[] = [WITH_PROCESS, WITH_PANE];
		const probedProcesses: ProcessIdentity[] = [];
		const probedHandles: TerminalSessionHandle[][] = [];
		const snap = await buildLivenessSnapshot(sessions, {
			now: NOW,
			activityOf: (id) => (id === "p1" ? RECENT : undefined),
			probeProcess: (id) => {
				probedProcesses.push(id);
				return "matching";
			},
			probeTerminals: async (handles) => {
				probedHandles.push([...handles]);
				const out = new Map<string, TerminalProbe>();
				for (const h of handles) out.set(h.value, "present");
				return out;
			},
		});
		expect(probedProcesses).toEqual([WITH_PROCESS.process]);
		expect(probedHandles).toHaveLength(1);
		expect(probedHandles[0][0].value).toBe("5");
		expect(snap.activity.get("p1")).toBe(RECENT);
		expect(snap.observations.get("p1")).toEqual({ process: "matching" });
		expect(snap.observations.get("t1")).toEqual({ pane: "present" });
		// A snapshot feeds derivation directly.
		expect(deriveLiveness(WITH_PROCESS, snap).liveness).toBe("live");
		expect(deriveLiveness(WITH_PANE, snap).liveness).toBe("live");
	});

	it("carries the terminal host from the session's process identity", async () => {
		const s: QuestSession = {
			id: "x",
			status: "active",
			process: { hostId: "host-z", pid: 1, startToken: "t" },
			terminal: { driverId: "wezterm", value: "9", scope: "/s" },
		};
		let seenHost: string | undefined;
		await buildLivenessSnapshot([s], {
			now: NOW,
			activityOf: () => undefined,
			probeProcess: () => "unknown",
			probeTerminals: async (handles) => {
				seenHost = handles[0]?.hostId;
				return new Map();
			},
		});
		expect(seenHost).toBe("host-z");
	});
});
