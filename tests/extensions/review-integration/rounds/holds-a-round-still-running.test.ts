/**
 * A round still running is not one to collect.
 *
 * Collecting a round turns what its reviewers left on disk into
 * findings, and doing that under a reviewer still at work files its
 * findings twice, or closes a round seconds after it started. These
 * pin how the adapter tells a round still held, by a supervisor that
 * has not begun or one whose lease names a live process, from one
 * nobody holds any longer. Collecting a round nobody holds is in
 * collects-an-interrupted-round.test.ts beside this.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	heldByLiveSupervisor,
	whyNotYet,
} from "../../../../extensions/review-integration/reviewer.ts";
import type { ProcessFacts } from "../../../../lib/subagent/index.ts";
import {
	ReviewerArtifactsStore,
	WRAP_UP_SUFFIX,
} from "../../../../lib/subagent/index.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "collect-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const RUN = "council-20260806T120000000-000001";

describe("whyNotYet", () => {
	const NOBODY: ProcessFacts = {
		alive: () => false,
		startedAt: async () => undefined,
	};
	const HELD = { id: RUN, participants: [{ id: "hawk" }] };

	it("refuses while a reviewer is handed over and its supervisor has not begun", async () => {
		// The moments after start, when each reviewer's directory is there
		// and no supervisor has written its lease. Reading that as free let
		// a collect file nothing and a stop close a round seconds from
		// starting, and told a watching session the round was ready.
		const store = new ReviewerArtifactsStore(root);
		mkdirSync(store.paths(RUN, "hawk").reviewerDir, { recursive: true });

		expect(await whyNotYet(store, HELD, NOBODY, Date.now())).toContain(
			"has not begun",
		);
	});

	it("holds a reviewer whose supervisor begins while the round is being looked at", async () => {
		// The race CI caught. Hawk has been handed over and has no lease;
		// its supervisor writes one while owl, whose supervisor is gone,
		// is being asked about. Judged in two passes, hawk read as starting
		// when running was the question and as running when starting was,
		// and the round was called free with both of them still at work.
		const store = new ReviewerArtifactsStore(root);
		const now = Date.now();
		const LIVE = 4242;
		const DEAD = 1111;
		const born = now - 1_000;
		mkdirSync(store.paths(RUN, "hawk").reviewerDir, { recursive: true });
		const owl = store.paths(RUN, "owl");
		mkdirSync(owl.reviewerDir, { recursive: true });
		writeFileSync(
			owl.leasePath,
			JSON.stringify({
				supervisorPid: DEAD,
				supervisorStartedAt: born,
				updatedAt: new Date(now).toISOString(),
			}),
			"utf8",
		);
		const hawkBegins: ProcessFacts = {
			alive: (pid) => {
				if (pid === DEAD) {
					writeFileSync(
						store.paths(RUN, "hawk").leasePath,
						JSON.stringify({
							supervisorPid: LIVE,
							supervisorStartedAt: born,
							updatedAt: new Date(now).toISOString(),
						}),
						"utf8",
					);
				}
				return pid === LIVE;
			},
			startedAt: async (pid) => (pid === LIVE ? born : undefined),
		};

		expect(
			await whyNotYet(
				store,
				{ id: RUN, participants: [{ id: "hawk" }, { id: "owl" }] },
				hawkBegins,
				now,
			),
		).toBeDefined();
	});

	it("releases a round whose reviewer was handed over long ago and never begun", async () => {
		const store = new ReviewerArtifactsStore(root);
		mkdirSync(store.paths(RUN, "hawk").reviewerDir, { recursive: true });

		expect(
			await whyNotYet(store, HELD, NOBODY, Date.now() + 60 * 60_000),
		).toBeUndefined();
	});
});

describe("heldByLiveSupervisor", () => {
	/** Write the lease the supervisor keeps renewing while it runs. */
	function lease(
		store: ReviewerArtifactsStore,
		reviewerId: string,
		fields: Record<string, unknown>,
	): void {
		const paths = store.paths(RUN, reviewerId);
		mkdirSync(paths.reviewerDir, { recursive: true });
		writeFileSync(paths.leasePath, JSON.stringify(fields), "utf8");
	}

	const NOW = Date.parse("2026-08-06T12:00:00.000Z");
	const PID = 4242;
	const BORN = NOW - 5 * 60_000;

	/**
	 * Lease hawk to the supervisor PID was born as, last renewed
	 * `renewedAgoMs` before now, with anything `more` it says of itself.
	 */
	function leaseHawk(
		store: ReviewerArtifactsStore,
		renewedAgoMs: number,
		more: Record<string, unknown> = {},
	): void {
		lease(store, "hawk", {
			supervisorPid: PID,
			supervisorStartedAt: BORN,
			...more,
			updatedAt: new Date(NOW - renewedAgoMs).toISOString(),
		});
	}

	/** A machine wearing exactly one pid, which answers about that one. */
	function machine(options: {
		alive?: boolean;
		startedAt?: number | undefined;
	}): ProcessFacts {
		return {
			alive: (pid) => pid === PID && options.alive !== false,
			startedAt: async (pid) => (pid === PID ? options.startedAt : undefined),
		};
	}

	/** A machine that also keeps ticks and names its boot, as Linux does. */
	function ticking(options: {
		startedAt: number;
		startTicks: number;
		boot?: string;
	}) {
		return {
			...machine({ startedAt: options.startedAt }),
			bootId: () => options.boot ?? "boot-1",
			startTicks: async (pid: number) =>
				pid === PID ? options.startTicks : undefined,
		};
	}

	/** Who holds hawk's part of the round now, on `facts`'s machine. */
	function heldHawk(
		store: ReviewerArtifactsStore,
		facts: Parameters<typeof heldByLiveSupervisor>[3],
	): ReturnType<typeof heldByLiveSupervisor> {
		return heldByLiveSupervisor(store, RUN, ["hawk"], facts, NOW);
	}

	it("holds a round whose supervisor's start moved with a suspend, by its ticks", async () => {
		// After 100 suspends the boot time had moved four seconds, so the
		// start in milliseconds no longer matched, and a live supervisor
		// read as a stranger: its round was offered for collecting.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 2_000, {
			supervisorStartTicks: 812_345,
			bootId: "boot-1",
		});

		expect(
			await heldHawk(
				store,
				ticking({ startedAt: BORN + 4_000, startTicks: 812_345 }),
			),
		).toMatchObject({ reviewerId: "hawk", pid: PID });
	});

	it("releases a round whose ticks name another process, though its milliseconds match", async () => {
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 2_000, {
			supervisorStartTicks: 812_345,
			bootId: "boot-1",
		});

		expect(
			await heldHawk(store, ticking({ startedAt: BORN, startTicks: 900_000 })),
		).toBeUndefined();
		expect(
			await heldHawk(
				store,
				ticking({ startedAt: BORN, startTicks: 812_345, boot: "boot-2" }),
			),
		).toBeUndefined();
	});

	it("holds a round whose supervisor is the one the lease named", async () => {
		// Collecting under a live session files the findings of whoever
		// finished, then that session files them all again.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 2_000);

		expect(await heldHawk(store, machine({ startedAt: BORN }))).toMatchObject({
			reviewerId: "hawk",
			pid: PID,
		});
	});

	it("holds a round whose supervisor is wedged rather than gone", async () => {
		// The direction a heartbeat alone gets wrong. This supervisor has
		// not written for ten minutes and is still, provably, the process
		// the lease was written about: collecting out from under it is
		// the expensive mistake, so identity outranks silence.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 10 * 60_000);

		expect(await heldHawk(store, machine({ startedAt: BORN }))).toMatchObject({
			reviewerId: "hawk",
		});
	});

	it("releases a round whose pid the machine reissued", async () => {
		// The case that stopped this being a pid check. Nothing deletes a
		// lease, so a finished supervisor leaves one naming its number;
		// when the machine hands that number out again, a pid check
		// refuses the collect forever, and waiting does not help because
		// nothing will write that lease again.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 2_000);

		expect(
			await heldHawk(store, machine({ startedAt: NOW - 1_000 })),
		).toBeUndefined();
	});

	it("releases a round whose supervisor pid nothing is wearing", async () => {
		// The pid check on its own, with everything else pointing the
		// other way: fresh heartbeat, matching birth.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 0);

		expect(
			await heldHawk(store, machine({ alive: false, startedAt: BORN })),
		).toBeUndefined();
	});

	it("falls back to the heartbeat when nothing can identify a process", async () => {
		// A machine with no ps. The fallback fails open, so this pins the
		// one direction that matters: a lease nobody has renewed in ten
		// minutes stops holding the round.
		const store = new ReviewerArtifactsStore(root);
		leaseHawk(store, 10 * 60_000);

		expect(
			await heldHawk(store, machine({ startedAt: undefined })),
		).toBeUndefined();
	});

	it("holds a round whose only live lease is a wrap-up", async () => {
		// A wrap-up is a supervised run of its own, under its own id, and
		// it is the last thing still writing in a round that is nearly
		// over. Asking only the roster's ids reads no live lease and
		// calls the round free at the exact moment it is not.
		const store = new ReviewerArtifactsStore(root);
		lease(store, "hawk", {
			supervisorPid: PID,
			supervisorStartedAt: BORN,
			completedAt: new Date(NOW).toISOString(),
		});
		lease(store, `hawk${WRAP_UP_SUFFIX}`, {
			supervisorPid: PID,
			supervisorStartedAt: BORN,
			updatedAt: new Date(NOW).toISOString(),
		});

		expect(await heldHawk(store, machine({ startedAt: BORN }))).toMatchObject({
			reviewerId: `hawk${WRAP_UP_SUFFIX}`,
		});
	});

	it("releases a round whose supervisor said it had finished", async () => {
		const store = new ReviewerArtifactsStore(root);
		lease(store, "hawk", {
			supervisorPid: PID,
			supervisorStartedAt: BORN,
			updatedAt: new Date(NOW).toISOString(),
			completedAt: new Date(NOW).toISOString(),
		});

		expect(await heldHawk(store, machine({ startedAt: BORN }))).toBeUndefined();
	});

	it("releases a round with no lease at all", async () => {
		const store = new ReviewerArtifactsStore(root);

		expect(await heldHawk(store, machine({ startedAt: BORN }))).toBeUndefined();
	});
});
