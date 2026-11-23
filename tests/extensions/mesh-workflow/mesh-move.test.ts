/**
 * A move asked of a session while its run goes on, as the session meets
 * it: the move goes the moment the run settles, which is when anything
 * else a settle starts (a reload onto a moved install, say) goes too.
 * Left to its next look, a few seconds on, a reload that began meanwhile
 * stops it, and a slow reload holds the move until a release gives up
 * on it, as E30 failed under a full host test's load on 23 November.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readMoveNote } from "../../../lib/internal/session/move.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { inboxOf } from "../../../lib/mesh/steer.ts";
import { fixture, session, startSession } from "./support/mesh.ts";

/** Past steering's first look at its inboxes, three seconds in. */
const STEER_TAKEN_MS = 6000;

describe("a move asked during a run", () => {
	it("goes as the run settles, not at its next look", async () => {
		fixture.paths = { ...fixture.paths, steer: join(fixture.root, "steer") };
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		// The run counts as under way through its end, as pi's does, until
		// it settles.
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

		await fire("agent_end");
		expect(readMoveNote(session), "no note while the run still counts").toBe(
			undefined,
		);
		idle = true;
		await fire("agent_settled", { aborted: false });

		expect(readMoveNote(session), "the note, as the run settles").toMatchObject(
			{ session, to: "background" },
		);
		expect(shut, "the session ends with its note left").toBe(1);
	}, 10_000);
});
