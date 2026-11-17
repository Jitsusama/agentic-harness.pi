/**
 * What this session's peer keeps across a reload: the groups it joined,
 * the peers it stopped and what it landed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { presence, session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	it("keeps only what it joined across a reload, and works its scopes out again", () => {
		const at = surroundings();
		at.presences.publish(
			presence({
				session,
				groups: ["#harness", "#quest/old"],
				joined: ["#harness"],
			}),
		);

		const again = localPeer(at);

		expect(again.groups).toEqual(["#harness"]);
	});

	it("keeps its groups across a reload", () => {
		const first = localPeer(surroundings());
		first.join("#optimus/power");

		const again = localPeer(surroundings());

		expect(again.groups).toEqual(["#optimus/power"]);
		expect(
			again.leave("#optimus/power"),
			"leaving a group kept across the reload says it left",
		).toBe(true);
		expect(
			again.leave("#optimus/power"),
			"leaving it a second time says it was not in it",
		).toBe(false);
	});

	it("keeps its stops across a reload, until it lifts them", () => {
		const stop = { address: "P9R1KI", session: "s-p", at: "2026-10-22" };
		const first = localPeer(surroundings());
		expect(first.stop(stop), "a first stop of P9R1KI is taken").toBe(true);
		expect(
			first.stop({ ...stop, why: "again" }),
			"a second stop of P9R1KI is not taken",
		).toBe(false);

		const again = localPeer(surroundings());

		expect(again.stops).toEqual([stop]);
		expect(surroundings().presences.of(session)?.stops).toEqual([stop]);
		expect(again.lift("P9R1KI")).toEqual(stop);
		expect(again.lift("P9R1KI")).toBeUndefined();
		expect(localPeer(surroundings()).stops).toEqual([]);
		expect(surroundings().presences.of(session)?.stops).toBeUndefined();
	});

	describe("what it landed", () => {
		const noon = Date.parse("2026-11-01T12:00:00.000Z");
		const at = (minutes: number) =>
			new Date(noon + minutes * 60_000).toISOString();
		const landing = (ref: string, minutes = 0) => ({
			at: at(minutes),
			ref,
			what: `${ref} landed`,
		});
		const clocked = (over: { session?: string; previous?: string } = {}) => ({
			...surroundings(),
			...over,
			now: () => noon + 60 * 60_000,
		});

		it("publishes each landing, newest first, one per ref", () => {
			const peer = localPeer(clocked());

			peer.landed(landing("agentic-harness.pi#920", 0));
			peer.landed(landing("core.nix#1491", 5));
			peer.landed({ ...landing("agentic-harness.pi#920", 10), what: "again" });

			expect(
				surroundings()
					.presences.of(session)
					?.landings?.map((one) => one.ref),
			).toEqual(["agentic-harness.pi#920", "core.nix#1491"]);
			expect(peer.landings[0]?.what).toBe("again");
		});

		it("keeps them across a reload and into the log a rollover starts", () => {
			localPeer(clocked()).landed(landing("PLAN-20261030-QMUYBH#14a"));

			expect(localPeer(clocked()).landings.map((one) => one.ref)).toEqual([
				"PLAN-20261030-QMUYBH#14a",
			]);
			const rolled = localPeer(
				clocked({ session: "01a19244-rolled", previous: session }),
			);
			expect(rolled.landings.map((one) => one.ref)).toEqual([
				"PLAN-20261030-QMUYBH#14a",
			]);
		});

		it("lets one older than a day go at its next start", () => {
			localPeer(clocked()).landed(landing("core.nix#1400", -25 * 60));

			expect(localPeer(clocked()).landings).toEqual([]);
		});
	});
});
