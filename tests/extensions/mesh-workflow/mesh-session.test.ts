/**
 * A session's own life on the mesh: carried on through a rollover, what
 * its holder needs as it parks, a pi that keeps no session, a fleet's
 * subagent working as its peer's hands, and a folder left untrusted.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
