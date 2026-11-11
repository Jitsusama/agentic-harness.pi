/**
 * A peer whose presence file another process wrote over says its own
 * again at its next refresh, and one whose file is its own writes nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../lib/mesh/peer.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";

let root: string;
const session = "01a1be5c-fff0-70a1-9301-f505d5634bf6";
const host = {
	pid: 4100,
	startedAt: 1_794_370_632_830,
	startTicks: 14_107_285,
};
const plain = {
	pid: 4200,
	startedAt: 1_794_372_000_000,
	startTicks: 14_200_000,
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-reassert-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A hosted peer whose every write is counted. */
function hostedPeer() {
	const kept = createPresences(join(root, "presence"));
	const written: Presence[] = [];
	const presences = {
		...kept,
		publish: (one: Presence) => {
			written.push(one);
			kept.publish(one);
		},
	};
	const peer = localPeer({
		session,
		cwd: root,
		records: { sessions: join(root, "sessions"), quests: join(root, "quests") },
		presences,
		owner: host,
		hosted: { host: "work-background", conversation: session },
	});
	return { peer, kept, written };
}

describe("a peer's presence written over by another process", () => {
	it("is said again, with its own owner and host, at the next refresh", () => {
		const { peer, kept, written } = hostedPeer();
		const own = kept.of(session);
		if (own === undefined) throw new Error("the peer published nothing");
		// What a plain pi on the same log left: its own pid, and no host.
		const { hosted: _hosted, ...unhosted } = own;
		kept.publish({ ...unhosted, owner: plain });

		peer.refresh();

		expect(written, "the peer wrote its presence a second time").toHaveLength(
			2,
		);
		expect(kept.of(session)).toMatchObject({
			owner: { pid: host.pid },
			hosted: { host: "work-background", conversation: session },
		});
	});

	it("is said again when only the host it names differs", () => {
		const { peer, kept, written } = hostedPeer();
		const own = kept.of(session);
		if (own === undefined) throw new Error("the peer published nothing");
		kept.publish({
			...own,
			hosted: { host: "work-attended", conversation: session },
		});

		peer.refresh();

		expect(written).toHaveLength(2);
		expect(kept.of(session)?.hosted?.host).toBe("work-background");
	});

	it("writes nothing while the file names its own process and host", () => {
		const { peer, written } = hostedPeer();

		peer.refresh();
		peer.refresh();

		expect(written, "an unchanged presence is not written again").toHaveLength(
			1,
		);
	});
});
