/**
 * A fleet's transcripts are not reclaimed while nobody has read them.
 *
 * A fleet's answers exist in two places: the tool result handed to
 * the session that asked, and the transcripts on disk. When the
 * session dies mid-fleet the first never happens, so the second is
 * the only copy, and until the ledger existed nothing said so: the
 * sweep saw run directories of the ordinary age and took them.
 *
 * The review side learned this the expensive way, over five councils
 * and a first fix that was backwards. Everything here is the same
 * argument one layer down, so the cases are deliberately the same
 * cases.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFleetLedger } from "../../../lib/subagent/fleet.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/index.ts";
import { systemFacts } from "../../../lib/subagent/lease.ts";
import { noSuchProcess } from "../../support/processes.ts";
import { said, holdFleetState, stateDir, staleFleet, alsoOrphaned, DAY_MS, holdTheClock, finished, age, aboutFleets, NEW, CAME_BACK, startSession, recordOf } from "./fleet-session.ts";

// A state directory of its own, and a screen whose notices are kept.
holdFleetState();

describe("the fleet retention sweep", () => {
	it("reclaims a fleet somebody has been handed", async () => {
		// The other side of everything below. Without it a sweep that
		// never ran would pass every case here, since one that deletes
		// nothing also destroys nothing.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-done",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		await ledger.settle("fleet-done");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() =>
			expect(existsSync(transcripts), `${transcripts} is removed`).toBe(false),
		);
	});

	it("keeps a fleet nobody has collected, however old", async () => {
		// The one that matters. An open fleet is one whose session did
		// not live to hand it back, so these transcripts are the only
		// copy of what was paid for, and no clock makes that untrue.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-orphan",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		const transcripts = staleFleet("fleet-orphan");
		await age(transcripts);
		// Waited on the other one going, so this is not merely a sweep
		// that had not started yet.
		const other = staleFleet("fleet-nobody-recorded");
		await age(other);

		await startSession();
		await vi.waitFor(() =>
			expect(existsSync(other), `${other} is removed`).toBe(false),
		);
		expect(existsSync(transcripts), `${transcripts} is kept`).toBe(true);
	});

	it("forgets a settled record once its transcripts have gone", async () => {
		// The seam that makes the ledger's own window real. Without the
		// call, `fleets/` is the unbounded thing the ledger was built to
		// bound: one small file per fleet ever dispatched, all of them
		// read at every session start, long after what they point at
		// has been reclaimed.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-ancient",
			startedAt: "2019-01-01T00:00:00.000Z",
			jobs: ["one"],
		});
		await ledger.settle("fleet-ancient");
		const record = join(stateDir("fleets"), "fleet-ancient.json");
		const old = JSON.parse(readFileSync(record, "utf8"));
		writeFileSync(
			record,
			JSON.stringify({ ...old, settledAt: "2019-01-01T00:00:00.000Z" }),
			"utf8",
		);

		await startSession();

		await vi.waitFor(() =>
			expect(existsSync(record), `${record} is removed`).toBe(false),
		);
	});

	it("declines the sweep when the fleet ledger will not read", async () => {
		// An empty protect set is not the cautious reading of a ledger
		// that will not open, it is the destructive one: every fleet
		// that finished on disk then looks like one nobody needs.
		mkdirSync(stateDir("fleets"), { recursive: true });
		writeFileSync(stateDir("fleets", "torn.json"), "{ not json", "utf8");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("will not be swept"));
			expect(about).toHaveLength(1);
			expect(about[0]).toContain("torn.json");
			expect(about[0]).toContain("every session");
		});
		expect(existsSync(transcripts), `${transcripts} is kept`).toBe(true);
	});

	it("cuts off the fleets whose session has gone, and says nothing", async () => {
		// What 2026-10-21 needed: nine fleets from sessions killed by
		// earlier reboots, warned about at every session start because a
		// note rebuilt by each session kept losing them. Proven gone once,
		// they are cut off on their own records, their transcripts are
		// kept for whoever comes back for them, and nobody is told.
		// Three gone among five, so a version that cut off every open
		// fleet fails on the two still running.
		const ledger = createFleetLedger(stateDir("fleets"));
		const dead = noSuchProcess();
		const mine = await systemFacts.startedAt(process.pid);
		if (mine === undefined) throw new Error("the machine would not say");
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				owner:
					n < 3
						? { pid: dead, startedAt: 1_000 }
						: { pid: process.pid, startedAt: mine },
			});
			await age(staleFleet(`fleet-${n}`));
		}

		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));
		await startSession();
		await finished();

		for (let n = 0; n < 3; n++) {
			const run = await recordOf(`fleet-${n}`);
			expect(run?.open).toBeUndefined();
			expect(run?.cutOff).toEqual({
				at: expect.any(String),
				why: "owner-gone",
			});
			// Aged past every ordinary window, and kept: what a cut-off
			// fleet wrote is the only copy there is.
			expect(
				existsSync(stateDir("runs", `fleet-${n}`)),
				`${stateDir("runs", `fleet-${n}`)} is kept`,
			).toBe(true);
		}
		for (let n = 3; n < 5; n++) {
			expect(await recordOf(`fleet-${n}`)).toMatchObject({ open: true });
		}
		expect(said.filter(aboutFleets)).toEqual([]);
	});

	it("lets a cut-off fleet go once its window has passed", async () => {
		// Kept for as long as its conversation might come back for it,
		// and no longer, so nobody is ever asked to delete a file.
		const record = stateDir("fleets", "fleet-0.json");
		mkdirSync(stateDir("fleets"), { recursive: true });
		writeFileSync(
			record,
			JSON.stringify({
				id: "fleet-0",
				startedAt: "2019-01-01T00:00:00.000Z",
				jobs: ["one"],
				settledAt: "2019-01-01T00:00:00.000Z",
				cutOff: { at: "2019-01-01T00:00:00.000Z", why: "owner-gone" },
			}),
			"utf8",
		);
		const transcripts = staleFleet("fleet-0");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() =>
			expect(existsSync(transcripts), `${transcripts} is removed`).toBe(false),
		);
		await vi.waitFor(() =>
			expect(existsSync(record), `${record} is removed`).toBe(false),
		);
	});

	it("tells the conversation that dispatched a cut-off fleet, once", async () => {
		// A restored session is the same conversation under a new pid,
		// and the one place knowing its fleet was cut off is worth
		// anything. Told to the model, out of the person's way, and
		// marked on the record so a second restore does not tell it again.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-0",
			startedAt: new Date().toISOString(),
			jobs: ["one", "two"],
			session: "conversation-a",
			owner: { pid: noSuchProcess(), startedAt: 1_000 },
		});
		const transcripts = staleFleet("fleet-0");

		const first = await startSession("conversation-a");
		await vi.waitFor(() => expect(first).toHaveLength(1));
		expect(first[0]).toMatchObject({
			customType: "subagent-fleet-cut-off",
			display: false,
		});
		expect(first[0]?.content).toContain("fleet-0 (one, two)");
		expect(first[0]?.content).toContain(transcripts);
		await vi.waitFor(async () =>
			expect(await recordOf("fleet-0")).toMatchObject({
				cutOff: { told: true },
			}),
		);
		expect(said.filter(aboutFleets)).toEqual([]);

		// Restored at a later start, past the window in which the first
		// one looked for orphans, so this one looks too and finishes by
		// saying so.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + DAY_MS);
		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));
		const again = await startSession("conversation-a");
		await finished();
		expect(again).toEqual([]);
	});

	it("tells no other conversation, and none at all for an older record", async () => {
		// Every other session has no use for it. A record from before
		// sessions were kept names no conversation, so it is cut off and
		// told to nobody.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-0",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
			session: "conversation-a",
			owner: { pid: noSuchProcess(), startedAt: 1_000 },
		});
		await ledger.open({
			id: "fleet-1",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
			owner: { pid: noSuchProcess(), startedAt: 1_000 },
		});
		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));

		const told = await startSession("conversation-b");
		await finished();

		expect(told).toEqual([]);
		expect((await recordOf("fleet-0"))?.cutOff?.why).toBe("owner-gone");
		expect((await recordOf("fleet-1"))?.cutOff?.why).toBe("owner-gone");
		expect(said.filter(aboutFleets)).toEqual([]);
	});

	it("is swept by the first start in a window, though a conversation come back is told", async () => {
		// Every start swept the whole machine's fleets, reading each
		// record and every run's streams to find what the start before
		// had just found: 2,048 records and 405 runs on 4 November, about
		// half a second of CPU at every start. The first start in a window
		// sweeps for the machine; a conversation that came back still
		// hears of its own cut-off fleets, since only it can be told.
		const opens = holdTheClock();
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-done",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		await ledger.settle("fleet-done");
		const first = staleFleet("fleet-done");
		await age(first);
		await startSession("conversation-new", NEW);
		await vi.waitFor(() =>
			expect(existsSync(first), `${first} is removed`).toBe(false),
		);

		await ledger.open({
			id: "fleet-later",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		await ledger.settle("fleet-later");
		const later = staleFleet("fleet-later");
		await age(later);
		await ledger.open({
			id: "fleet-0",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
			session: "conversation-a",
			owner: { pid: noSuchProcess(), startedAt: 1_000 },
		});
		vi.setSystemTime(opens + 60_000);
		const told = await startSession("conversation-a", CAME_BACK);
		await vi.waitFor(() => expect(told).toHaveLength(1));
		await vi.waitFor(async () =>
			expect(await recordOf("fleet-0")).toMatchObject({
				cutOff: { told: true },
			}),
		);
		expect(existsSync(later), `${later} is kept`).toBe(true);

		vi.setSystemTime(opens + DAY_MS);
		await startSession("conversation-next", NEW);
		await vi.waitFor(() =>
			expect(existsSync(later), `${later} is removed`).toBe(false),
		);
	});

	it("agrees with itself when sessions start together", async () => {
		// Several sessions at once after a reboot is the ordinary case.
		// Each cuts off what it proves gone, and none can undo another:
		// the record ends cut off whoever wrote last.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 3; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				owner: { pid: noSuchProcess(), startedAt: 1_000 },
			});
		}
		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));

		await Promise.all([startSession(), startSession(), startSession()]);
		await finished();

		for (let n = 0; n < 3; n++) {
			const run = await recordOf(`fleet-${n}`);
			expect(run?.open).toBeUndefined();
			expect(run?.cutOff?.why).toBe("owner-gone");
		}
		expect(said.filter(aboutFleets)).toEqual([]);
	});

	it("removes the note earlier versions kept", async () => {
		mkdirSync(stateDir(), { recursive: true });
		const note = stateDir("abandoned-said.json");
		writeFileSync(note, JSON.stringify(["fleet-0"]), "utf8");

		await startSession();

		await vi.waitFor(() =>
			expect(existsSync(note), `${note} is removed`).toBe(false),
		);
	});

	it("says nothing about a held fleet another session is running", async () => {
		// The case the count alone could not see, and the one where
		// speaking does harm: these transcripts are held because work is
		// in flight, and the only lever the message offers would
		// unprotect it. This process stands in for the live session,
		// since it is the one this test can prove is alive.
		const ledger = createFleetLedger(stateDir("fleets"));
		const mine = await systemFacts.startedAt(process.pid);
		if (mine === undefined) throw new Error("the machine would not say");
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				owner: { pid: process.pid, startedAt: mine },
			});
			await age(staleFleet(`fleet-${n}`));
		}

		// Anchored to something that happens strictly after the decision
		// being denied. Waiting for the sweep to delete something is not
		// that, since the sweep runs before this message is considered.
		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));

		await startSession();

		await finished();
		expect(said.filter(aboutFleets)).toEqual([]);
		// Nor cut off: work in flight is not lost.
		for (let n = 0; n < 5; n++) {
			expect(await recordOf(`fleet-${n}`)).toMatchObject({ open: true });
		}
	});

	it("says nothing about fleets the ledger holds but the disk does not", async () => {
		// The other half of counting what was held. Five open records
		// with no transcripts behind them is five fleets whose
		// dispatches never got as far as writing anything, and there is
		// nothing there to go and look at. The sweep taking another
		// fleet is what says it has decided.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
		}
		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);

		await startSession();
		await vi.waitFor(() =>
			expect(existsSync(transcripts), `${transcripts} is removed`).toBe(false),
		);
		expect(said).toEqual([]);
	});

	it("says nothing while only a few are held", async () => {
		// A channel that speaks every session is a channel nobody reads,
		// and a couple of held fleets is the ordinary state of a machine
		// somebody used this morning.
		//
		// Four, not zero. Holding none would pin the threshold only from
		// above, so a version that spoke at one would pass this and the
		// case below it alike.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 4; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
			await age(staleFleet(`fleet-${n}`));
		}
		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() =>
			expect(existsSync(transcripts), `${transcripts} is removed`).toBe(false),
		);
		expect(said).toEqual([]);
	});
});
