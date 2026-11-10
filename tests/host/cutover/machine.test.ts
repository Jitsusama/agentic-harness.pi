import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machineFacts } from "../../../host/cutover/machine.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["AAAAAA"],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	state: "listening",
	at: "2026-11-10T09:00:00.000Z",
	...over,
});

/** A harness root, knowing the move or not. */
function root(knows: boolean): string {
	const folder = mkdtempSync(join(tmpdir(), "cutover-root-"));
	if (knows) {
		mkdirSync(join(folder, "lib", "internal", "session"), { recursive: true });
		writeFileSync(join(folder, "lib", "internal", "session", "move.ts"), "");
	}
	return folder;
}

describe("machineFacts' knowsMove", () => {
	it("takes a presence's word, which only a harness with the move says", async () => {
		const facts = machineFacts({ realm: "work" });
		expect(
			await facts.knowsMove(presence({ driven: false })),
			"a presence saying nobody drives it",
		).toBe(true);
		expect(
			await facts.knowsMove(presence({ driven: true })),
			"a presence saying a person drives it",
		).toBe(true);
		expect(
			await facts.knowsMove(presence()),
			"a presence that says neither",
		).toBe(false);
	});

	it("lets a parked pi that predates it move when the install it wakes on knows how", async () => {
		const parked = presence({ state: "parked" });
		expect(
			await machineFacts({ realm: "work", current: root(true) }).knowsMove(
				parked,
			),
			"waking on an install that knows the move",
		).toBe(true);
		expect(
			await machineFacts({ realm: "work", current: root(false) }).knowsMove(
				parked,
			),
			"waking on an install that predates it",
		).toBe(false);
		expect(
			await machineFacts({ realm: "work" }).knowsMove(parked),
			"with no install named",
		).toBe(false);
	});
});
