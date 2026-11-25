/**
 * What this session's peer says it is doing: busy or listening, its
 * step, its usage, paused, parked or ended, and what it waits on its
 * person for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localPeer, STEP_MS } from "../../../../lib/mesh/peer.ts";
import {
	createPresences,
	type Presence,
} from "../../../../lib/mesh/presence.ts";
import { localDay, noUsage } from "../../../../lib/mesh/usage.ts";
import { wantId } from "../../../../lib/mesh/want.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	it("publishes only when something in its presence changed", () => {
		// Presence follows events, never a clock: a peer at rest writes nothing.
		const kept = createPresences(join(root, "presence"));
		const written: Presence[] = [];
		const presences = {
			...kept,
			publish: (one: Presence) => {
				written.push(one);
				kept.publish(one);
			},
		};
		const peer = localPeer({ ...surroundings(), presences });

		peer.refresh();
		peer.refresh();
		peer.setBusy(false);
		expect(written).toHaveLength(1);
		peer.setBusy(true);
		expect(written.map((one) => one.busy)).toEqual([false, true]);
		expect(kept.of(session)).toMatchObject({ busy: true });
	});

	it("names the file its holder wakes it on while it's parked, and not before", () => {
		// 8 November: a node steering a parked session found no wake in its
		// presence, only in the park marker, so it couldn't wake it (KP0L6A).
		const at = surroundings();
		const peer = localPeer(at);
		peer.refresh();
		expect(at.presences.of(session)).not.toHaveProperty("wake");

		peer.park("/run/user/1000/mycelium/work.held/54960192.wake");

		expect(at.presences.of(session)).toMatchObject({
			state: "parked",
			wake: "/run/user/1000/mycelium/work.held/54960192.wake",
		});
	});

	it("reads as up again once a park that failed part-way is taken back", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.park("/run/user/1000/mycelium/work.held/54960192.wake");

		peer.unpark();

		const presence = at.presences.of(session);
		expect(presence?.state).not.toBe("parked");
		expect(presence).not.toHaveProperty("wake");
		peer.end();
		expect(at.presences.of(session), "it ends as a session up").toHaveProperty(
			"ended",
		);
	});

	it("says when it ended for good, so a session put down reads apart from one that crashed", () => {
		// 15 November: health counted 24 sessions put down on purpose as
		// agents that died, since their presence read as a crash's (80ECO2).
		const at = {
			...surroundings(),
			now: () => Date.parse("2026-11-15T23:02:00Z"),
		};
		const peer = localPeer(at);
		peer.refresh();
		expect(at.presences.of(session), "a running peer").not.toHaveProperty(
			"ended",
		);

		peer.end();

		expect(at.presences.of(session)).toMatchObject({
			ended: "2026-11-15T23:02:00.000Z",
		});
	});

	it("says no end once parked, since a parked session is still there to wake", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.park();

		peer.end();

		expect(at.presences.of(session)).toMatchObject({ state: "parked" });
		expect(at.presences.of(session), "a parked peer").not.toHaveProperty(
			"ended",
		);
	});

	it("says what it is doing: since when a run began, and its step at most every 30 s", () => {
		let clock = Date.parse("2026-10-26T06:00:00Z");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const seen = () => at.presences.of(session);

		expect(seen()).toMatchObject({ state: "listening" });
		peer.setBusy(true);
		peer.setStep("bash");
		expect(seen()).toMatchObject({
			state: "busy",
			since: "2026-10-26T06:00:00.000Z",
			step: "bash",
		});

		clock += STEP_MS - 1;
		peer.setStep("edit");
		expect(seen()?.step).toBe("bash");
		clock += 1;
		peer.setStep("edit");
		expect(seen()?.step).toBe("edit");

		peer.setBusy(false);
		expect(seen()).toMatchObject({ state: "listening" });
		expect(seen()?.since).toBeUndefined();
		expect(seen()?.step).toBeUndefined();
	});

	it("says a step begun inside the window once the window ends, unless the run ended first", () => {
		// A long bash begun 5 s after a short read must not read as "read"
		// for the whole of it.
		vi.useFakeTimers();
		try {
			let clock = Date.parse("2026-10-26T06:00:00Z");
			const at = { ...surroundings(), now: () => clock };
			const peer = localPeer(at);
			const step = () => at.presences.of(session)?.step;

			peer.setBusy(true);
			peer.setStep("read");
			clock += 5_000;
			vi.advanceTimersByTime(5_000);
			peer.setStep("bash");
			expect(step()).toBe("read");

			clock += STEP_MS - 5_000;
			vi.advanceTimersByTime(STEP_MS - 5_000);
			expect(step()).toBe("bash");

			clock += 1_000;
			peer.setStep("edit");
			peer.setBusy(false);
			clock += STEP_MS;
			vi.advanceTimersByTime(STEP_MS);
			expect(step()).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says its step in full: the tool and what it is about, thinking, or waiting on its person", () => {
		vi.useFakeTimers();
		try {
			saysItsStepInFull();
		} finally {
			vi.useRealTimers();
		}
	});

	const saysItsStepInFull = () => {
		let clock = Date.parse("2026-11-06T22:00:00Z");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const seen = () => at.presences.of(session);

		peer.setBusy(true);
		peer.setThinking();
		expect(seen()).toMatchObject({
			step: "thinking",
			stepDetail: {
				kind: "thinking",
				name: "",
				detail: "",
				since: "2026-11-06T22:00:00.000Z",
			},
		});

		// Begun inside the window, it is said when the window ends, with
		// the time it began rather than the time it was said.
		clock += 10_000;
		vi.advanceTimersByTime(10_000);
		peer.setStep("bash", "pnpm check");
		expect(seen()?.stepDetail?.kind).toBe("thinking");
		clock += STEP_MS - 10_000;
		vi.advanceTimersByTime(STEP_MS - 10_000);
		expect(seen()).toMatchObject({
			step: "bash",
			stepDetail: {
				kind: "tool",
				name: "bash",
				detail: "pnpm check",
				since: "2026-11-06T22:00:10.000Z",
			},
		});

		peer.want({
			id: wantId("approval", "2026-11-06T22:01:00.000Z"),
			kind: "approval",
			since: "2026-11-06T22:01:00.000Z",
			said: "git push origin main",
		});
		expect(seen()).toMatchObject({
			step: "bash",
			stepDetail: {
				kind: "waiting",
				name: "approval",
				detail: "git push origin main",
				since: "2026-11-06T22:01:00.000Z",
			},
		});

		peer.setBusy(false);
		expect(seen()?.stepDetail).toBeUndefined();
	};

	it("says its usage with the next presence it writes, and carries today's into its next start", () => {
		let clock = Date.parse("2026-11-06T22:00:00");
		const at = { ...surroundings(), now: () => clock };
		const peer = localPeer(at);
		const usage = {
			...noUsage(localDay(new Date(clock))),
			turns: { today: 3 },
			"pi.cost.usd": { last: 0.5, today: 1.25 },
		};

		peer.setBusy(true);
		peer.setUsage(usage);
		expect(at.presences.of(session)?.usage).toBeUndefined();
		peer.setBusy(false);
		expect(at.presences.of(session)?.usage).toEqual(usage);

		expect(localPeer(at).usage).toEqual(usage);

		// Past midnight today's counts start afresh, keeping only a last call.
		clock = Date.parse("2026-11-07T00:01:00");
		expect(localPeer(at).usage).toEqual(noUsage("2026-11-07"));
	});

	it("is paused over all else, and still paused after a reload", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.setBusy(true);
		peer.setPaused(true);
		expect(at.presences.of(session)?.state).toBe("paused");

		const reloaded = localPeer(at);
		expect(reloaded.paused, "the peer is still paused after a reload").toBe(
			true,
		);
		reloaded.setPaused(false);
		expect(at.presences.of(session)?.state).toBe("listening");
	});

	it("is waiting when idle with a want standing, and busy while it runs", () => {
		const at = surroundings();
		const peer = localPeer(at);
		peer.want({
			id: wantId("question", "2026-10-26T06:00:00Z"),
			kind: "question",
			said: "Which launcher?",
			since: "2026-10-26T06:00:00Z",
		});

		expect(at.presences.of(session)?.state).toBe("waiting");
		peer.setBusy(true);
		expect(at.presences.of(session)?.state).toBe("busy");
	});

	it("says what it waits on its person for, longest first, until each is settled", () => {
		const peer = localPeer(surroundings());
		const asked = {
			id: wantId("question", "2026-10-22T08:00:00.000Z"),
			kind: "question" as const,
			since: "2026-10-22T08:00:00.000Z",
			said: "Which launcher?",
		};
		const held = {
			id: wantId("approval", "2026-10-22T07:50:00.000Z"),
			kind: "approval" as const,
			since: "2026-10-22T07:50:00.000Z",
			said: "Push to main?",
		};
		const kept = () => surroundings().presences.of(session)?.wants;

		peer.want(asked);
		expect(kept()).toEqual(asked);
		peer.want(held);
		expect(kept()).toEqual(held);
		expect(peer.settle("approval"), "the standing approval is settled").toBe(
			true,
		);
		expect(kept()).toEqual(asked);
		expect(peer.settle("approval"), "no approval is left to settle").toBe(
			false,
		);
		expect(peer.settle("question"), "the standing question is settled").toBe(
			true,
		);
		expect(kept()).toBeUndefined();
	});

	it("waits on nothing after a start, whatever its presence said", () => {
		const peer = localPeer(surroundings());
		peer.want({
			id: wantId("blocked", "2026-10-22T08:00:00.000Z"),
			kind: "blocked",
			since: "2026-10-22T08:00:00.000Z",
			said: "Blocked: needs Joel's say on the launcher",
		});

		const again = localPeer(surroundings());

		expect(again.wants).toBeUndefined();
		expect(surroundings().presences.of(session)?.wants).toBeUndefined();
	});
});
