/** The host letting a child go: stopping its unit, asking systemd again when it won't say, and keeping a slot in use while its unit may still run. */
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { slotOf } from "../../../host/service/child-units.ts";
import {
	a,
	childOf,
	entry,
	folder,
	key,
	reported,
	said,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

superviseEachTest();

describe("a child leaving", () => {
	it("keeps its slot in use while its unit won't stop, refusing a start there", async () => {
		await supervisor.resume(entry(a));
		units.lingers = true;

		childOf(a).say({ type: "became", previousId: "not an id" });

		const slot = slotOf(folder, key, a);
		await vi.waitFor(
			() =>
				expect(String(reported.at(-1))).toContain(
					`still runs, so its slot stays in use: systemctl --user stop ${slot.unit}`,
				),
			{ timeout: 4_000 },
		);
		expect(units.stopped, "stopped three times").toEqual([
			slot.unit,
			slot.unit,
			slot.unit,
		]);
		expect(existsSync(slot.file), "its slot is kept").toBe(true);
		await expect(supervisor.resume(entry(a))).rejects.toThrow("runs in");
		expect(units.started, "no second child beside it").toHaveLength(1);

		// Gone at last, as one systemd stopped late would be.
		await units.children.get(slot.unit)?.exit();
		await supervisor.resume(entry(a));
		expect(units.started, "started again once it went").toHaveLength(2);
	});

	it("asks again when systemd once won't say whether its unit went", async () => {
		await supervisor.resume(entry(a));
		units.goneFails = 1;
		const slot = slotOf(folder, key, a);

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(() =>
			expect(existsSync(slot.file), "its slot is cleared").toBe(false),
		);
		expect(said).toContainEqual(
			expect.stringMatching(/its stop failed: .*systemd would not say/),
		);
		expect(reported, "nothing left for anyone to do").toEqual([]);
		await supervisor.resume(entry(a));
		expect(units.started, "started again in its slot").toHaveLength(2);
	});

	it("keeps its slot while systemd won't say whether its unit went, until it does", async () => {
		await supervisor.resume(entry(a));
		// Each try's ask, and the one after the last.
		units.goneFails = 4;

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(() =>
			expect(String(reported.at(-1))).toContain("still runs"),
		);
		const slot = slotOf(folder, key, a);
		expect(existsSync(slot.file), "its slot is kept").toBe(true);
		await supervisor.resume(entry(a));
		expect(units.started, "started once systemd said it went").toHaveLength(2);
	});

	it("stops a child that said it ends when systemd once won't say whether it went", async () => {
		await supervisor.resume(entry(a));
		units.goneFails = 1;
		const slot = slotOf(folder, key, a);

		// It says so, but never exits of itself.
		childOf(a).say({ type: "ending", why: "parked" });

		await vi.waitFor(
			() => {
				expect(units.stopped, "stopped all the same").toEqual([slot.unit]);
				expect(existsSync(slot.file), "its slot is cleared").toBe(false);
			},
			{ timeout: 3_000 },
		);
		expect(reported, "nothing left for anyone to do").toEqual([]);
	});

	it("frees its slot when its stop fails each time yet its unit goes", async () => {
		await supervisor.resume(entry(a));
		units.stopFails = 3;
		const slot = slotOf(folder, key, a);

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(
			() => expect(existsSync(slot.file), "its slot is cleared").toBe(false),
			{ timeout: 4_000 },
		);
		expect(units.stopped, "stopped three times").toHaveLength(3);
		expect(reported, "no unit said to run on").toEqual([]);
		await supervisor.resume(entry(a));
		expect(units.started, "started again in its slot").toHaveLength(2);
	});
});
