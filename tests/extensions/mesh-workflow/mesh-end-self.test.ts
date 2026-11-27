/**
 * mesh_end with no address: a session a mycelium holder keeps ends
 * itself through the node, and one no holder keeps ends nothing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { end } from "../../../extensions/mesh-workflow/tools/end.ts";
import type { Local } from "../../../extensions/mesh-workflow/tools.ts";
import type { Ended } from "../../../lib/mesh/worker-link.ts";

/**
 * A session that orchestrates nothing, held by `holder` when one is
 * named, whose link answers an End as `ended` says; only the fields
 * ending itself reads, the rest of a Local never touched.
 */
function session(holder?: string, ended?: Ended): Local {
	const peer = { session: "session-s", addresses: ["8XK2PQ"] };
	return {
		peer: { ...peer, signature: "8XK2PQ" },
		presences: { all: () => [] },
		...(holder === undefined ? {} : { holder }),
		...(ended === undefined
			? {}
			: { endHeld: vi.fn().mockResolvedValue(ended) }),
	} as unknown as Local;
}

/** A pi context whose shutdown is only counted. */
function context(): ExtensionContext & { shutdown: ReturnType<typeof vi.fn> } {
	return {
		shutdown: vi.fn(),
		sessionManager: { getSessionId: () => "session-s" },
	} as unknown as ExtensionContext & { shutdown: ReturnType<typeof vi.fn> };
}

/** What a tool answer says. */
function said(answered: { content: { text: string }[] }): string | undefined {
	return answered.content[0]?.text;
}

describe("mesh_end with no address", () => {
	it("ends nothing for a session no holder keeps", async () => {
		const at = session(undefined, { ok: true });
		const ctx = context();

		const answered = await end(at, {}, ctx);

		expect(said(answered)).toBe(
			"Nothing ended: this session isn't held by a mycelium holder, so there is nothing to end it through.",
		);
		expect(at.endHeld, "the node is never asked").not.toHaveBeenCalled();
		expect(ctx.shutdown, "pi goes on").not.toHaveBeenCalled();
	});

	it("asks the node through its holder, then quits pi", async () => {
		const at = session("holder-1", { ok: true });
		const ctx = context();

		const answered = await end(at, {}, ctx);

		expect(said(answered)).toBe("Ending: the holder takes this session down.");
		expect(at.endHeld, "asked of the holder keeping it").toHaveBeenCalledWith(
			"holder-1",
		);
		expect(ctx.shutdown, "pi quits as it ends itself").toHaveBeenCalledOnce();
	});

	it("says what the node said and quits nothing when it refuses", async () => {
		const at = session("holder-1", { refused: "no holder by that id" });
		const ctx = context();

		const answered = await end(at, {}, ctx);

		expect(said(answered)).toBe(
			"Nothing ended: the node said no holder by that id.",
		);
		expect(ctx.shutdown, "pi goes on").not.toHaveBeenCalled();
	});

	it("ends nothing for a held session with no link to the node", async () => {
		const at = session("holder-1");
		const ctx = context();

		const answered = await end(at, {}, ctx);

		expect(said(answered)).toBe(
			"Nothing ended: this session keeps no link to the node's worker socket, so there is nothing to ask the holder through.",
		);
		expect(ctx.shutdown, "pi goes on").not.toHaveBeenCalled();
	});
});
