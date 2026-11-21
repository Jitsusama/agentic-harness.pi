/**
 * Who `orchestrator` reaches for a peer before any hub is chosen: the
 * mark's orchestrator, nobody for any session on a quest heading an
 * orchestration, and nobody for a peer the mesh doesn't list yet. None of these asks the
 * node for ties.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aboveFor } from "../../../extensions/mesh-workflow/tools/above.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

/** What aboveFor reads of a peer with these roles, on an empty mesh. */
function reading(roles: {
	orchestratedBy?: string;
	orchestrates?: string;
	questHeads?: string;
}) {
	const folder = mkdtempSync(join(tmpdir(), "above-"));
	folders.push(folder);
	// Only the fields aboveFor reads; the rest of a Peer is never touched.
	const peer = {
		session: "session-s",
		orchestratedBy: roles.orchestratedBy,
		orchestrates: roles.orchestrates,
		questHeads: roles.questHeads,
	} as unknown as Peer;
	return { peer, presences: createPresences(folder), ties: vi.fn() };
}

describe("who orchestrator reaches", () => {
	it("is the mark's orchestrator, without asking for ties", async () => {
		const at = reading({ orchestratedBy: "5GV2AH" });

		expect(await aboveFor(at)).toEqual({ address: "5GV2AH", by: "mark" });
		expect(at.ties).not.toHaveBeenCalled();
	});

	it("is nobody for the head of an orchestration, which is its quest's orchestrator", async () => {
		const at = reading({ orchestrates: "7M6JKG" });

		expect(await aboveFor(at)).toEqual({
			none: "this peer heads its own orchestration, so nothing is above it for `orchestrator` to reach",
		});
		expect(at.ties).not.toHaveBeenCalled();
	});

	// Another session leads it, so this one has neither role, and a hub
	// above would pass over the head on its own quest.
	it("is nobody for another session on a quest heading an orchestration, naming its head", async () => {
		const at = reading({ questHeads: "7M6JKG" });

		expect(await aboveFor(at)).toEqual({
			none: "this peer's quest heads its own orchestration, whose head is 7M6JKG, so nothing is above it for `orchestrator` to reach; write to 7M6JKG by its address",
		});
		expect(at.ties).not.toHaveBeenCalled();
	});

	it("is nobody, saying why, for a peer with no presence on the mesh yet", async () => {
		const at = reading({});
		at.ties.mockResolvedValue([]);

		expect(await aboveFor(at)).toEqual({
			none: "this peer has no presence on the mesh yet, so no orchestrator or hub from use is above it",
		});
	});
});
