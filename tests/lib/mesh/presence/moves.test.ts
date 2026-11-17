/**
 * What this session's peer says for a node that would move it: a move
 * waiting or called off, whether a person drives it, how its commands
 * are fenced and what it leases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	it("says a move waiting and what holds it, kept through a reload in its own process alone", () => {
		const at = {
			...surroundings(),
			owner: { pid: 4100, startedAt: 1000 },
		};
		const peer = localPeer(at);
		const moving = {
			to: "background" as const,
			since: "2026-11-10T09:00:00.000Z",
			holds: "background jobs are out",
		};
		peer.setMoving(moving);
		expect(at.presences.of(session)?.moving).toEqual(moving);

		expect(localPeer(at).moving, "a reload goes on waiting").toEqual(moving);
		// The host that takes the file up runs it in another process.
		const adopted = localPeer({
			...at,
			owner: { pid: 5200, startedAt: 2000 },
		});
		expect(adopted.moving, "the adopted conversation moves no more").toBe(
			undefined,
		);
		expect(at.presences.of(session)?.moving).toBeUndefined();
	});

	it("says why a move was called off, until another is asked", () => {
		const at = { ...surroundings(), owner: { pid: 4100, startedAt: 1000 } };
		const peer = localPeer(at);
		peer.setMoving({ to: "attended", since: "2026-11-10T09:00:00.000Z" });
		const off = {
			to: "attended" as const,
			since: "2026-11-10T09:00:00.000Z",
			at: "2026-11-10T09:45:00.000Z",
			why: "it waited 45 minutes and is still held: a fleet is out",
		};
		peer.callOffMove(off);
		expect(at.presences.of(session)?.moving).toBeUndefined();
		expect(at.presences.of(session)?.moveOff).toEqual(off);
		const reloaded = localPeer(at);
		reloaded.refresh();
		expect(
			at.presences.of(session)?.moveOff,
			"a reload still says why",
		).toEqual(off);

		reloaded.setMoving({
			to: "background",
			since: "2026-11-10T10:00:00.000Z",
		});
		expect(at.presences.of(session)?.moveOff).toBeUndefined();
	});

	it("says a person drives it, kept for its own session in any process and passed to no other", () => {
		const at = { ...surroundings(), owner: { pid: 4100, startedAt: 1000 } };
		const peer = localPeer(at);
		expect(at.presences.of(session)?.driven, "said either way").toBe(false);
		peer.setDriven();
		expect(at.presences.of(session)?.driven, "said once a person wrote").toBe(
			true,
		);

		const adopted = localPeer({ ...at, owner: { pid: 5200, startedAt: 2000 } });
		expect(adopted.driven, "the host's conversation says so too").toBe(true);
		const fresh = localPeer({
			...at,
			session: "01a19244-new",
			previous: session,
		});
		expect(fresh.driven, "a new session starts undriven").toBe(false);
	});

	// ISXEG8's condition 2: a node carries a session only to a machine
	// fenced at least as strictly, so it reads how this one is fenced.
	it("says how its commands are fenced, as its surroundings say", () => {
		for (const fence of ["none", "fence", "strict"] as const) {
			const at = { ...surroundings(), fence };
			localPeer(at);
			expect(at.presences.of(session)?.fence, fence).toBe(fence);
		}
		const unsaid = surroundings();
		localPeer(unsaid);
		expect(
			unsaid.presences.of(session),
			"left out where the harness doesn't say",
		).not.toHaveProperty("fence");
	});

	// 5HJZ8Z, 16 November: a node tells a harness that leases its
	// background commands from an older one, which it can't judge idle.
	it("says it leases its background commands, where its harness does", () => {
		const at = { ...surroundings(), leases: { background: true } };
		localPeer(at);
		expect(at.presences.of(session)?.leases).toEqual({ background: true });
		const unsaid = surroundings();
		localPeer(unsaid);
		expect(
			unsaid.presences.of(session),
			"left out where the harness doesn't say",
		).not.toHaveProperty("leases");
	});
});
