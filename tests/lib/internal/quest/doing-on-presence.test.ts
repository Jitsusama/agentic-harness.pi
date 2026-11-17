/**
 * A peer's presence says what its quest workflow last said it was doing,
 * read again at each publish, and a reader keeps it whole or not at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sayDoing } from "../../../../lib/internal/quest/sessions/doing.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";

let root: string;
const session = "01a1e0aa-0000-7000-8000-000000000251";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-doing-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A peer whose records name a doing folder. */
function peerWithDoing() {
	const presences = createPresences(join(root, "presence"));
	const doing = join(root, "doing");
	const peer = localPeer({
		session,
		cwd: root,
		records: {
			sessions: join(root, "sessions"),
			quests: join(root, "quests"),
			doing,
		},
		presences,
	});
	return { peer, presences, doing };
}

describe("a peer's doing", () => {
	it("is left out until the quest workflow says one", () => {
		const { presences, peer } = peerWithDoing();
		expect(presences.of(session)?.doing, "nothing said yet").toBeUndefined();
		peer.dispose();
	});

	it("is said at the next publish, and taken away once it's gone", () => {
		const { presences, peer, doing } = peerWithDoing();
		const said = {
			plan: "PLAN-1",
			item: 251,
			next: "Put doing on the presence",
			chose: "A file of its own",
		};
		sayDoing(doing, session, said, new Date("2026-11-15T13:50:00Z"));
		peer.refresh();
		expect(presences.of(session)?.doing, "read back whole").toEqual({
			...said,
			at: "2026-11-15T13:50:00.000Z",
		});
		sayDoing(doing, session, undefined, new Date());
		peer.refresh();
		expect(presences.of(session)?.doing, "gone with its file").toBeUndefined();
		peer.dispose();
	});

	it("is dropped by a reader when it isn't one", () => {
		const { presences, peer } = peerWithDoing();
		const own = presences.of(session);
		if (own === undefined) throw new Error("the peer published nothing");
		const file = join(root, "presence", `${session}.json`);
		const doing = { plan: "PLAN-1", next: "a", at: "2026-11-15T13:50:00Z" };
		writeFileSync(file, JSON.stringify({ ...own, doing }));
		expect(presences.of(session)?.doing, "well formed, so kept").toEqual(doing);
		writeFileSync(file, JSON.stringify({ ...own, doing: { plan: 7 } }));
		expect(
			presences.of(session)?.doing,
			"malformed, so left out",
		).toBeUndefined();
		peer.dispose();
	});
});
