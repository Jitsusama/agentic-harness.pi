/**
 * A session's own life on the mesh: carried on through a rollover, what
 * its holder needs as it parks, a pi that keeps no session, a fleet's
 * subagent working as its peer's hands, and a folder left untrusted.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CarriedContext,
	type CarryingPlaces,
	carryThisSession,
} from "../../../extensions/mesh-workflow/carrying.ts";
import { HAND_EXTENSION } from "../../../extensions/mesh-workflow/index.ts";
import {
	type CarryHold,
	carryUnderWay,
	closeLanded,
	holdForCarry,
} from "../../../lib/internal/carry/under-way.ts";
import { sessionRegistryDir } from "../../../lib/internal/quest/sessions/loaded.ts";
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
import { inboxOf } from "../../../lib/mesh/steer.ts";
import { FROM_PERSON } from "../../../lib/mesh/steer-who.ts";
import {
	SUBAGENT_READY,
	SUBAGENT_REGISTER_DEFAULT_EXTENSION,
} from "../../../lib/subagent/events.ts";
import { until } from "../../support/until.ts";
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
		// What each test left holding, let go after it whether it passed or
		// not, so no later park test reads a carry it never started.
		const left: (() => Promise<unknown>)[] = [];
		// Each is let go though one before it throws, which then fails the
		// test that left it.
		afterEach(async () => {
			// A carried hold no release lets go, for one that failed before its
			// own close (PV3TE0's round 9, F5).
			closeLanded(session);
			const ended = await Promise.allSettled(
				left.splice(0).map((end) => end()),
			);
			const failed = ended.find((one) => one.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		});

		/** A hold an ordered carry would take, let go after the test. */
		const ordered = (): CarryHold => {
			const hold = holdForCarry(session, "penelope");
			left.push(async () => hold.release());
			return hold;
		};

		/** Asks this session's park, answering what refused it. */
		const parkAsked = (
			emit: (event: string, data: unknown) => void,
			restart = false,
		) => {
			const ask = { session, refusals: [] as string[], restart };
			emit(PARK_ASK, ask);
			return ask.refusals;
		};

		/** A carry of this session that waits on its run until `ended` is called. */
		const carrying = (places: CarryingPlaces = {}) => {
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
				...places,
			});
			// Settled either way after the test, so a failing one leaves
			// nothing polling and no rejection unheard.
			left.push(() => {
				idle = true;
				return carried.catch(() => undefined);
			});
			return {
				// With no quest loaded here, the carry refuses once its run ends.
				ended: () => {
					idle = true;
					return expect(carried).rejects.toThrow(/no quest is loaded/);
				},
				carried,
			};
		};

		it("refuses to park until the carry ends", async () => {
			const { emit } = await startSession();
			const carry = carrying();

			const during = parkAsked(emit);
			await carry.ended();
			const after = parkAsked(emit);

			expect(during).toEqual(["its work is being carried to penelope"]);
			expect(after).toEqual([]);
		});

		it("refuses to start again in place, which would end the carry too", async () => {
			const { emit } = await startSession();
			const carry = carrying();

			const refusals = parkAsked(emit, true);
			await carry.ended();

			expect(refusals).toEqual(["its work is being carried to penelope"]);
		});

		it("lets the park go once a carry's hold has had its time", async () => {
			const { emit } = await startSession();
			const hold = holdForCarry(session, "penelope", { mostMs: 0 });
			left.push(async () => hold.release());

			expect(parkAsked(emit)).toEqual([]);
		});

		// 23 November (PV3TE0's F41): of two carries of one session, the
		// first to end lifted the other's hold.
		it("refuses a second carry, and keeps the first one's hold", async () => {
			const { emit } = await startSession();
			const first = carrying();
			const second = carrying();

			await expect(second.carried).rejects.toThrow(
				"a carry to penelope is already under way.",
			);
			const refusals = parkAsked(emit);
			await first.ended();

			expect(refusals).toEqual(["its work is being carried to penelope"]);
		});

		// PV3TE0's round 7 (F2, F7, F11): a hung carry's hold that never
		// lapsed for a second carry turned away every later Carry of a
		// hosted session until its host restarted.
		// The park beside it is the case above; this one's own carry holds
		// the park while it runs, as any carry does.
		it("takes a carry whose hold has had its time as hung, letting a second carry go", async () => {
			await startSession();
			const hung = holdForCarry(session, "penelope", { mostMs: 0 });
			left.push(async () => hung.release());
			const second = carrying();

			// Refused for no quest once its run ends, never as already under way.
			await second.ended();
		});

		// PV3TE0's round 3 (F2, F5, F10): state.ts sets the ordered carry's
		// own hold aside in its looks and hands it to the carry; drop
		// either and every ordered carry refuses itself.
		/**
		 * A session steered through its inbox, its run under way until
		 * `idle` is set, saying on a screen what it tells.
		 */
		const steeredSession = async () => {
			const steer = join(fixture.root, "steer");
			fixture.paths = { ...fixture.paths, steer };
			const run = { idle: false, stale: false };
			const told: string[] = [];
			// Every other call a screen takes is answered with nothing.
			const ui = new Proxy(
				{},
				{
					get: (_, key) =>
						key === "notify"
							? (text: string) => told.push(text)
							: () => undefined,
				},
			);
			const { emit, fire } = await startSession(
				{},
				{
					hasUI: true,
					ui,
					// Its id read throws once `stale` is set, as a stale context's does.
					sessionManager: {
						getSessionId: () => {
							if (run.stale) throw new Error("the context is stale");
							return session;
						},
						getSessionFile: () => join(fixture.root, `${session}.jsonl`),
						getBranch: () => [],
						getSessionName: () => undefined,
						getCwd: () => fixture.root,
					},
					isIdle: () => run.idle,
					hasPendingMessages: () => false,
					abort: () => {},
					// Plain pi's close, which a carry that carried asks for.
					shutdown: () => {},
				},
			);
			// Whatever the test did, its run ends and its carry lets go, so
			// no later park test reads a hold it never took.
			// A carry still under way that never goes fails the test that
			// leaked it, saying what still holds, rather than a later park
			// test, while the session's peer still answers its park. One that
			// carried is let go by the close landed first, so each test that
			// carries reads its own hold (PV3TE0's round 10, F3).
			left.push(async () => {
				run.idle = true;
				await until(
					"the steered carry lets go",
					() => parkAsked(emit).length === 0,
					10_000,
				).catch(() => {
					throw new Error(
						`A steered carry still holds the park: ${JSON.stringify(parkAsked(emit))}. Told: ${JSON.stringify(told)}`,
					);
				});
			});
			const steered = (body: Record<string, string>) => {
				const inbox = inboxOf(steer, "7M6JKG");
				mkdirSync(inbox, { recursive: true });
				const name = join(inbox, `${Date.now()}-0a1b.json`);
				writeFileSync(`${name}.tmp`, JSON.stringify(body));
				renameSync(`${name}.tmp`, name);
			};
			const toldOf = (what: string, said: (text: string) => boolean) =>
				until(what, () => told.some(said), 10_000).catch((error: unknown) => {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)} Told: ${JSON.stringify(told)}`,
					);
				});
			return { emit, fire, run, told, steered, toldOf };
		};

		it("takes an ordered carry steered in as far as its carry, its own hold set aside, and holds the park meanwhile", async () => {
			const { emit, run, told, steered, toldOf } = await steeredSession();
			steered({
				act: "ordered-carry",
				to: "penelope",
				why: "its camera work needs the Mac",
				by: "WCJQSG",
				from: "WCJQSG",
			});

			await toldOf("the ordered carry waits out the run under way", (text) =>
				text.includes("letting the turn under way end first"),
			);
			const waiting = parkAsked(emit);
			run.idle = true;
			await toldOf("the ordered carry ends", (text) =>
				text.startsWith("This session refused"),
			);
			// Once refused, its hold has gone; that it goes before its refusal
			// is written is ordered-carry.test's to hold.
			const after = parkAsked(emit);

			expect(waiting, "the park is held from the order").toEqual([
				"its work is being carried to penelope",
			]);
			// It reached the carry, which refuses here only for want of a quest.
			expect(
				told.filter((text) => text.startsWith("This session refused")),
			).toEqual([
				expect.stringContaining(
					"an ordered carry to penelope by WCJQSG: its work couldn't be carried: no quest is loaded",
				),
			]);
			expect(after, "the park goes once the order lets go").toEqual([]);
		});

		// PV3TE0's round 4 (F4, F5, F14): pausing asks the registry the
		// ordered carry holds through state.ts, and promises no close the
		// carry under way may not keep.
		it("leaves a person's Carry to the ordered carry under way, saying to Carry again if that one is refused", async () => {
			// Taken first, so it is let go before the session's end waits on it.
			ordered();
			const { told, steered, toldOf } = await steeredSession();
			// Only the person's own Carry is read as one, the launcher's.
			steered({ act: "carry", to: "equilibrius", from: FROM_PERSON });

			await toldOf("the Carry is left to the one under way", (text) =>
				text.startsWith("A Carry to equilibrius"),
			);

			expect(told.filter((text) => text.startsWith("A Carry"))).toEqual([
				`A Carry to equilibrius from outside its window, steered by ${FROM_PERSON}, was left to the carry to penelope already under way, which closes this session if it carries; if that one is refused, Carry again.`,
			]);
		});

		// PV3TE0's round 8 (F3, F4, F6, F9, F12): only state.ts hands the
		// registry an ordered carry's carried, and only the session's
		// shutdown says its close landed; drop either and nothing else fails.
		/** A session an ordered carry to penelope carried, with a quest loaded. */
		const carriedAway = async () => {
			const loaded = join(sessionRegistryDir(), `${session}.json`);
			mkdirSync(sessionRegistryDir(), { recursive: true });
			writeFileSync(
				loaded,
				JSON.stringify({
					sessionId: session,
					instanceId: "i-1",
					cwd: fixture.root,
					quest: "QEST-20261123-CARRY8",
					openedAt: "2026-11-23T11:00:00.000Z",
				}),
			);
			// Every other test here carries with no quest loaded.
			left.push(async () => rmSync(loaded, { force: true }));
			const { fire, run, told, steered, toldOf } = await steeredSession();
			run.idle = true;
			steered({
				act: "ordered-carry",
				to: "penelope",
				why: "its camera work needs the Mac",
				by: "WCJQSG",
				from: "WCJQSG",
			});
			await toldOf("the ordered carry carries", (text) =>
				text.startsWith("Carried to penelope"),
			);
			return { fire, told, steered, toldOf };
		};

		it("keeps an ordered carry that carried holding the session until its close lands", async () => {
			const { fire, told, steered, toldOf } = await carriedAway();

			steered({ act: "carry", to: "equilibrius", from: FROM_PERSON });
			await toldOf("the Carry is left to the one that carried", (text) =>
				text.startsWith("A Carry to equilibrius"),
			);
			const closing = carryUnderWay(session);
			await fire("session_shutdown");

			expect(told.filter((text) => text.startsWith("A Carry"))).toEqual([
				expect.stringContaining("was left to the carry to penelope"),
			]);
			expect(closing, "held while it closes").toBe("penelope");
			expect(carryUnderWay(session), "let go once it closed").toBeUndefined();
		});

		// PV3TE0's round 10 (F1): a host outlives a conversation and may open
		// it again while the carry its close left running still runs; only
		// the session's start says it is open once more.
		it("holds a carry that carries after its session closed and opened again, until that opening closes", async () => {
			const carry = ordered();
			const closed = await startSession();
			await closed.fire("session_shutdown");
			const reopened = await startSession();

			carry.carried();
			const held = carryUnderWay(session);
			await reopened.fire("session_shutdown");

			expect(held, "held while it runs again").toBe("penelope");
			expect(carryUnderWay(session), "let go as it closes").toBeUndefined();
		});

		// PV3TE0's round 9 (F4): a reload's shutdown is no close, since the
		// session goes on in fresh modules; nothing else tells them apart.
		it("keeps an ordered carry that carried holding the session through a reload's shutdown", async () => {
			const { fire } = await carriedAway();

			await fire("session_shutdown", { reason: "reload" });

			expect(carryUnderWay(session)).toBe("penelope");
		});

		// PV3TE0's round 5 (F13, F18) and 6 (F6): read bare, the id threw
		// before anything was said, and the Carry vanished without a word.
		it("says a person's Carry it couldn't take, though the session's id can no longer be read", async () => {
			const { run, told, steered, toldOf } = await steeredSession();
			run.stale = true;
			steered({ act: "carry", to: "equilibrius", from: FROM_PERSON });

			await toldOf("the Carry says it stays open", (text) =>
				text.includes("stays open"),
			);

			expect(told.filter((text) => text.includes("stays open"))).toEqual([
				expect.stringContaining("the context is stale"),
			]);
		});

		it("holds the park from an ordered carry's order until it lets go", async () => {
			const { emit } = await startSession();
			const hold = ordered();

			const before = parkAsked(emit);
			await carrying({ hold }).ended();
			const carried = parkAsked(emit);
			hold.release();
			const after = parkAsked(emit);

			expect(before).toEqual(["its work is being carried to penelope"]);
			expect(carried).toEqual(["its work is being carried to penelope"]);
			expect(after).toEqual([]);
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
