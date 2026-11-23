/**
 * A move asked of a session while its run goes on, as the session meets
 * it: from the moment it is taken until its session ends, it holds off
 * the reload an install's move would start, which going as the run
 * settles would stop the move unwritten, as E30 failed under a full host
 * test's load on 23 November.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMoveNote } from "../../../lib/internal/session/move.ts";
import {
	letMoveGo,
	moveWaiting,
} from "../../../lib/internal/session/move-waiting.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { inboxOf } from "../../../lib/mesh/steer.ts";
import { fixture, session, startSession } from "./support/mesh.ts";

/** Past steering's first look at its inboxes, three seconds in. */
const STEER_TAKEN_MS = 6000;

/** Past a waiting move's next look, two seconds on. */
const MOVE_LOOKED_MS = 5000;

describe("a move asked during a run", () => {
	// A failed expectation leaves no hold on globalThis for the next case.
	afterEach(() => letMoveGo(session));

	it("holds the session's reload from when it is taken until the session ends", async () => {
		fixture.paths = { ...fixture.paths, steer: join(fixture.root, "steer") };
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		let idle = false;
		let shut = 0;
		const { fire } = await startSession(
			{},
			{
				isIdle: () => idle,
				hasPendingMessages: () => false,
				isProjectTrusted: () => true,
				shutdown: () => shut++,
			},
		);
		await fire("agent_start");
		const address = presences.of(session)?.addresses[0] ?? "";
		const inbox = inboxOf(fixture.paths.steer ?? "", address);
		mkdirSync(inbox, { recursive: true });
		writeFileSync(
			join(inbox, "1-move.json"),
			JSON.stringify({ act: "move", to: "background" }),
		);
		// Taken at steering's first look, three seconds after the start.
		await vi.waitFor(
			() => {
				expect(presences.of(session)?.moving?.holds).toBe("a run is under way");
			},
			{ timeout: STEER_TAKEN_MS },
		);
		expect(moveWaiting(session), "held while the run goes on").toBe(
			"background",
		);

		await fire("agent_end");
		idle = true;
		await fire("agent_settled", { aborted: false });
		expect(moveWaiting(session), "held as the run settles").toBe("background");

		await vi.waitFor(
			() => {
				expect(readMoveNote(session)).toMatchObject({
					session,
					to: "background",
				});
			},
			{ timeout: MOVE_LOOKED_MS },
		);
		expect(shut, "the session ends with its note left").toBe(1);
		expect(moveWaiting(session), "held until the session has ended").toBe(
			"background",
		);

		await fire("session_shutdown");
		expect(moveWaiting(session), "let go as the session ends").toBe(
			undefined,
		);
	}, 15_000);
});
