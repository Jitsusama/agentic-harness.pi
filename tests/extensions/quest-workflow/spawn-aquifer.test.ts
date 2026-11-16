/**
 * An Aquifer cell is started by the same verb as a session on optimus:
 * Joel asked on 15 November for Aquifer-backed cells "as simple to create
 * ... as on our bare metal" (WCJQSG [9a83b3bc]). So `quest spawn` with a
 * need of reach=aquifer asks the node to place it, starts it on the
 * machine placed, and passes on in plain words any refusal the node
 * gives, such as a credentialed cell that may never be kept or forked.
 */
import { describe, expect, it } from "vitest";
import {
	machineFor,
	type PlaceOnNode,
	type ShareQuest,
	type StartOnNode,
	spawnHeld,
} from "../../../extensions/quest-workflow/verbs/spawn-held.ts";
import type { Need } from "../../../lib/mesh/placement.ts";
import { fakeDriver } from "../../lib/terminal/fakes.ts";

const AQUIFER = "basin-1";
const REACH: Need = { kind: "reach", value: "aquifer" };

/** A node that places work needing Aquifer on it, and nothing else. */
function placing() {
	const asked: (readonly Need[])[] = [];
	const place: PlaceOnNode = async (needs) => {
		asked.push(needs);
		return needs.some((one) => one.kind === "reach" && one.value === "aquifer")
			? { ok: true, machine: AQUIFER }
			: { ok: false, reason: "optimus lacks reach aquifer" };
	};
	return { asked, place };
}

/** A node that starts what it's asked, or refuses with `refusal`. */
function starting(refusal?: string) {
	const asked: Parameters<StartOnNode>[0][] = [];
	const start: StartOnNode = async (one) => {
		asked.push(one);
		if (refusal !== undefined) return { ok: false, reason: refusal };
		return {
			ok: true,
			started: {
				machine: one.machine,
				held: "a9f3c210",
				folder: "/work/src/core.nix",
				attach: ["mycelium", "attach", "--on", one.machine, "a9f3c210"],
			},
		};
	};
	return { asked, start };
}

const shareAll: ShareQuest = async () => ({ ok: true });

function spawnOnAquifer() {
	return {
		machine: AQUIFER,
		needs: [REACH],
		command: "pi",
		cwd: "/home/joel/src/core.nix",
		home: "/home/joel",
		questId: "QEST-20261013-4UHC5Q",
		layout: "tab",
		options: {
			platform: "linux",
			ancestry: false,
			settings: { drivers: { kitty: { path: "/bin/sh" } } },
			env: { KITTY_PANE: "1" },
			drivers: [fakeDriver("kitty")],
			dryRun: false,
		},
	} as const;
}

describe("a spawn needing Aquifer", () => {
	it("is placed by the node with the need as it was said", async () => {
		const { asked, place } = placing();
		const chosen = await machineFor(undefined, ["reach=aquifer"], place);

		expect(chosen).toEqual({ ok: true, machine: AQUIFER, needs: [REACH] });
		expect(asked, "the node was asked once, with the need").toEqual([[REACH]]);
	});

	it("starts on the machine placed, with its need, and joins as any other", async () => {
		const { asked, start } = starting();
		const outcome = await spawnHeld(spawnOnAquifer(), start, shareAll);

		expect(asked[0]?.machine).toBe(AQUIFER);
		expect(asked[0]?.needs, "the node starting it hears the need").toEqual([
			REACH,
		]);
		expect(outcome.ok && outcome.message).toContain(
			"join it with: 'mycelium' 'attach' '--on' 'basin-1' 'a9f3c210'",
		);
	});

	it("says the node's refusal in its own words and starts nothing", async () => {
		const why = "a credentialed cell is never kept or forked";
		const outcome = await spawnHeld(
			spawnOnAquifer(),
			starting(why).start,
			shareAll,
		);

		expect(outcome).toEqual({
			ok: false,
			refusal: `Nothing was started on ${AQUIFER}: ${why}.`,
		});
	});

	it("says plainly when no machine has the reach", async () => {
		const chosen = await machineFor(undefined, ["reach=aquifer"], async () => ({
			ok: false,
			reason: "no machine reaches aquifer",
		}));

		expect(chosen).toEqual({
			ok: false,
			refusal:
				"Nothing was started, since mycelium's node placed it nowhere: no machine reaches aquifer.",
		});
	});
});
