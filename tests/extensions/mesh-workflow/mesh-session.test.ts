/**
 * A session's own life on the mesh: carried on through a rollover, what
 * its holder needs as it parks, a pi that keeps no session, a fleet's
 * subagent working as its peer's hands, and a folder left untrusted.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CARRY_HOLDS_MOST_MS,
	type CarriedContext,
	carryThisSession,
} from "../../../extensions/mesh-workflow/carrying.ts";
import { HAND_EXTENSION } from "../../../extensions/mesh-workflow/index.ts";
import { leaveUntrusted } from "../../../lib/internal/session/carried-trust.ts";
import {
	leaveSession,
	stayInSession,
} from "../../../lib/internal/session/left.ts";
import {
	PARK_ASK,
	PARKING,
	type Parking,
} from "../../../lib/internal/session/park.ts";
import {
	ROLLOVER_CARRY,
	ROLLOVER_RECORD,
} from "../../../lib/internal/session/rollover.ts";
import { WAKERS_ASK } from "../../../lib/internal/session/wakers.ts";
import { MESH_SESSION_ENV } from "../../../lib/mesh/hand.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";
import { holderSteers } from "../../../lib/mesh/parked.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../../lib/subagent/events.ts";
import {
	fixture,
	fromElsewhere,
	peer,
	send,
	session,
	startSession,
} from "./support/mesh.ts";

describe("a rollover", () => {
	it("carries the peer on into the fresh session, the same peer", async () => {
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		const first = await startSession();
		await first.tools.get("mesh_join")?.execute("call-1", { group: "#skynet" });
		await first.tools.get("mesh_stop")?.execute("call-2", { peer: "WCJQSG" });
		await send(first.tools, "all", "hold", "Hold builds.");
		const carry = { carried: {} as Record<string, unknown> };
		first.emit(ROLLOVER_CARRY, carry);
		expect(carry.carried.mesh).toEqual({ session });
		await first.fire("session_shutdown");

		// The fresh log's quest record may not be written yet.
		const fresh = "01a20000-0000-7000-8000-00000000f2e5";
		await startSession(
			{},
			{
				sessionManager: {
					getSessionId: () => fresh,
					getSessionName: () => undefined,
					getCwd: () => fixture.root,
					getSessionFile: () => join(fixture.root, `${fresh}.jsonl`),
					getBranch: () => [
						{
							type: "custom",
							id: "r1",
							parentId: null,
							customType: ROLLOVER_RECORD,
							data: {
								parentSession: join(fixture.root, `${session}.jsonl`),
								parentLeaf: "a1",
								dropped: 3,
								carried: carry.carried,
							},
						},
					],
				},
			},
		);

		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const now = presences.of(fresh);
		expect(now?.addresses[0]).toBe("7M6JKG");
		expect(now?.joined).toContain("#skynet");
		expect(now?.stops?.map((stop) => stop.address)).toEqual(["WCJQSG"]);
		expect(presences.of(session)).toBeUndefined();
		const board = createBoard(join(fixture.paths.mesh, "leases"));
		expect(board.of(fresh)?.leases.map((lease) => lease.kind)).toEqual([
			"hold",
		]);
		expect(board.of(session)).toBeUndefined();
	});

	it("keeps the log it rolled away from off the mesh, should it start again", async () => {
		// Seen live on 3 November: the left log started again with each of
		// the live session's reloads, and caught up on 13 messages the live
		// session never got.
		leaveSession(session);
		try {
			const { sent } = await startSession();
			fromElsewhere({ text: "for everyone" });

			// A real pause: the test is that the left log hears nothing in it.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(sent).toEqual([]);
			expect(
				createPresences(join(fixture.paths.mesh, "presence")).all(),
			).toEqual([]);
		} finally {
			stayInSession(session);
		}
	});
});

describe("parking", () => {
	// 14 November: a talk to a parked session waited up to a minute for a
	// running peer's look; its holder watches the inboxes the mesh names.
	it("names a parking session's steer inboxes and which steers wake it, for its holder", async () => {
		fixture.paths = { ...fixture.paths, steer: join(fixture.root, "steer") };
		const { emit } = await startSession();
		const parking: Parking = { session, addresses: [] };

		emit(PARKING, parking);
		expect(parking.addresses).not.toEqual([]);
		expect(parking.steers).toEqual(
			holderSteers(join(fixture.root, "steer"), parking.addresses),
		);
	});

	it("names no inboxes for a parking session where the mesh keeps none", async () => {
		const { emit } = await startSession();
		const parking: Parking = { session, addresses: [] };

		emit(PARKING, parking);
		expect(parking.steers).toBeUndefined();
	});

	// A parked void took 11 s to wake for each line (QCXZEB, 12 November).
	describe("standing at the launcher's top", () => {
		const standing = () => {
			mkdirSync(join(fixture.paths.quests, "QEST-20261021-7M6JKG"), {
				recursive: true,
			});
			writeFileSync(
				join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
				"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nstands-at-top: {name: The Void, keywords: [void]}\n---\n# QEST-20261021-7M6JKG\n",
			);
		};

		it("refuses to park, so a line said to it never waits for a wake", async () => {
			standing();
			const { emit } = await startSession();
			const ask = { session, refusals: [] as string[] };

			emit(PARK_ASK, ask);
			expect(ask.refusals).toEqual(["it stands at the launcher's top"]);
		});

		it("still starts again in place for a new install", async () => {
			standing();
			const { emit } = await startSession();
			const ask = { session, refusals: [] as string[], restart: true };

			emit(PARK_ASK, ask);
			expect(ask.refusals).toEqual([]);
		});
	});

	// 23 November: a background conversation idle five minutes parked
	// part-way through a carry its node had ordered, and wrote no done
	// file (BMDYSH, 01:03).
	describe("while its work is being carried", () => {
		/** A carry of this session that waits on its run until `ended` is called. */
		const carrying = () => {
			let idle = false;
			const ctx: CarriedContext = {
				sessionManager: {
					getSessionId: () => session,
					getSessionFile: () => undefined,
					getSessionName: () => undefined,
					getCwd: () => fixture.root,
				} as unknown as CarriedContext["sessionManager"],
				isIdle: () => idle,
				hasUI: false,
				ui: {} as CarriedContext["ui"],
			};
			const carried = carryThisSession(ctx, "penelope", {
				windDownMs: 60_000,
			});
			return {
				// With no quest loaded here, the carry refuses once its run ends.
				ended: () => {
					idle = true;
					return expect(carried).rejects.toThrow(/no quest is loaded/);
				},
			};
		};

		it("refuses to park until the carry ends", async () => {
			const { emit } = await startSession();
			const carry = carrying();
			const during = { session, refusals: [] as string[] };

			emit(PARK_ASK, during);
			await carry.ended();
			const after = { session, refusals: [] as string[] };
			emit(PARK_ASK, after);

			expect(during.refusals).toEqual([
				"its work is being carried to penelope",
			]);
			expect(after.refusals).toEqual([]);
		});

		it("refuses to start again in place, which would end the carry too", async () => {
			const { emit } = await startSession();
			const carry = carrying();
			const ask = { session, refusals: [] as string[], restart: true };

			emit(PARK_ASK, ask);
			await carry.ended();

			expect(ask.refusals).toEqual(["its work is being carried to penelope"]);
		});

		it("lets the park go once a carry has held it fifteen minutes", async () => {
			const { emit } = await startSession();
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const carry = carrying();
				const early = { session, refusals: [] as string[] };
				vi.setSystemTime(Date.now() + CARRY_HOLDS_MOST_MS - 1);
				emit(PARK_ASK, early);
				const late = { session, refusals: [] as string[] };
				vi.setSystemTime(Date.now() + 1);
				emit(PARK_ASK, late);
				await carry.ended();

				expect(early.refusals).toEqual([
					"its work is being carried to penelope",
				]);
				expect(late.refusals).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("leaves another session's park to that session", async () => {
			const { emit } = await startSession();
			const carry = carrying();
			const other = {
				session: "01a15f3a-0000-7463-9909-afa624b025fe",
				refusals: [] as string[],
			};

			emit(PARK_ASK, other);
			await carry.ended();

			expect(other.refusals).toEqual([]);
		});
	});

	it("names a question it asked that is still unanswered as what will wake it", async () => {
		const { emit } = await startSession();
		fromElsewhere({
			to: ["@85PKB2"],
			from: "7M6JKG",
			intent: "question",
			text: "may I merge?",
		});
		const ask = { session, wakers: [] as string[] };

		emit(WAKERS_ASK, ask);
		expect(ask.wakers).toHaveLength(1);
		expect(ask.wakers[0]).toMatch(/^a question \[.+\] awaiting 85PKB2$/);
	});
});

// 15 November: health counted 24 sessions put down on purpose as agents
// that died, since a quit left the same presence a crash does (80ECO2).
describe("ending", () => {
	const presence = () =>
		createPresences(join(fixture.paths.mesh, "presence")).of(session);

	it("says a session quit for good has ended", async () => {
		const { fire } = await startSession();
		expect(presence(), "a running session").not.toHaveProperty("ended");

		await fire("session_shutdown", { reason: "quit" });
		expect(presence()?.ended).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	it("says nothing ended when it reloads or parks", async () => {
		const reloaded = await startSession();
		await reloaded.fire("session_shutdown", { reason: "reload" });
		expect(presence(), "a reload").not.toHaveProperty("ended");

		const parked = await startSession();
		parked.emit(PARKING, { session, addresses: [] });
		await parked.fire("session_shutdown", { reason: "quit" });
		expect(presence(), "a park").toMatchObject({ state: "parked" });
		expect(presence(), "a park").not.toHaveProperty("ended");
	});

	it("says a session switched away from has ended", async () => {
		const { fire } = await startSession();
		await fire("session_shutdown", { reason: "new" });
		expect(presence()?.ended).toMatch(/^\d{4}-\d\d-\d\dT/);
	});
});

describe("a pi that keeps no session", () => {
	it("stays off the mesh, as a reload's load check does", async () => {
		// Seen live: every reload's load check showed up as a peer named for
		// its session id, working on a temporary folder.
		const { sent, tools } = await startSession(
			{},
			{
				sessionManager: {
					getSessionId: () => session,
					getSessionName: () => undefined,
					getCwd: () => fixture.root,
					getSessionFile: () => undefined,
				},
			},
		);
		fromElsewhere({ text: "for everyone" });

		// A real pause: the test is that a pi off the mesh hears nothing in it.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toEqual([]);
		expect(createPresences(join(fixture.paths.mesh, "presence")).all()).toEqual(
			[],
		);
		const answer = await send(tools, "all", "fyi", "hello");
		expect(answer).toContain("not on the mesh");
	});
});

describe("the subjects it says", () => {
	it("reads the owner lines naming its address from the owners file into its presence", async () => {
		const owners = join(fixture.root, "owners.txt");
		writeFileSync(owners, "health.=7M6JKG\noom.=80ECO2\n");
		await startSession({ PI_OWNERS_FILE: owners });

		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		expect(presences.of(session)?.subjects).toEqual(["health."]);
	});
});

describe("a fleet's subagent", () => {
	it("works as the hands of the peer that starts it", async () => {
		const env: NodeJS.ProcessEnv = {};
		const { emitted } = await startSession(env);

		expect(emitted).toContainEqual([
			SUBAGENT_REGISTER_DEFAULT_EXTENSION,
			HAND_EXTENSION,
		]);
		// Named to what it starts, so a subagent knows whose hands it is.
		expect(env[MESH_SESSION_ENV]).toBe(session);
	});

	it("gets its hands from a fleet that says it is ready after the mesh loaded", async () => {
		const registered: unknown[] = [];
		await startSession({}, {}, [], undefined, undefined, (emit) =>
			emit(SUBAGENT_READY, {
				registerDefaultExtension: (path: unknown) => registered.push(path),
			}),
		);

		expect(registered).toEqual([HAND_EXTENSION]);
	});

	it("is not a peer of its own", async () => {
		// It works inside another session's turn and answers to it alone.
		const { sent, tools } = await startSession({
			SUBAGENT_SUPERVISOR: "1",
			SUBAGENT_RUN_ID: "run-1",
		});
		fromElsewhere({ text: "for everyone" });

		// A real pause: the test is that the subagent hears nothing in it.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toEqual([]);
		expect(tools.size).toBe(0);
		expect(createPresences(join(fixture.paths.mesh, "presence")).all()).toEqual(
			[],
		);
	});
});

describe("a folder its host left untrusted", () => {
	it("stays untrusted in the plain pi that takes the conversation up", async () => {
		const { fire } = await startSession();
		const argv = process.argv;
		leaveUntrusted(session, fixture.root);
		try {
			process.argv = ["node", "pi", "--session", session];
			expect(
				await fire("project_trust", {
					type: "project_trust",
					cwd: fixture.root,
				}),
			).toEqual({ trusted: "no", remember: false });
			process.argv = ["node", "pi"];
			expect(
				await fire("project_trust", {
					type: "project_trust",
					cwd: fixture.root,
				}),
				"a pi on no session, as a host",
			).toEqual({ trusted: "undecided" });
		} finally {
			process.argv = argv;
		}
	});
});
