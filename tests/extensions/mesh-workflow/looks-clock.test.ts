import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expiredText,
	keepLooks,
} from "../../../extensions/mesh-workflow/looks-clock.ts";
import {
	askAboutLooks,
	keepLooksFor,
} from "../../../extensions/mesh-workflow/peer/looks.ts";
import {
	looksIn,
	OPENED_LASTS_MS,
	pointAt,
	SHOWING_LASTS_MS,
	UNHEARD_CELL_MS,
} from "../../../lib/mesh/looks/looks.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { presence } from "../../lib/mesh/presence/support/presences.ts";

/** A mesh whose presences are `these`, as the looks clock lists them. */
const listing = (these: readonly Presence[] = []) => ({
	listed: async () => [...these],
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "looks-clock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const shows = {
	kind: "pr" as const,
	target: "https://github.com/owner/repo/pull/7",
	title: "The narrow bar",
	why: "The bar keeps the model at narrow widths now.",
	ask: "Nothing, just to see.",
};
const t0 = new Date("2026-11-12T09:00:00Z");
const aDayOn = new Date(t0.getTime() + SHOWING_LASTS_MS);

describe("the looks clock", () => {
	it("expires this quest's looks past their time, whichever of its sessions pointed", () => {
		pointAt(dir, shows, { session: "S1", quest: "Q1" }, t0);
		pointAt(dir, shows, { session: "S2", quest: "Q2" }, t0);

		const expired = keepLooks(dir, { session: "S9", quest: "Q1" }, aDayOn);

		expect(
			expired.map((look) => look.quest),
			"Q1's look",
		).toEqual(["Q1"]);
		expect(
			looksIn(dir)
				.map((look) => `${look.quest} ${look.state}`)
				.sort(),
			"Q2's look waits for Q2",
		).toEqual(["Q1 expired", "Q2 waiting"]);
	});

	it("lets anyone's opened look that asked nothing back leave", () => {
		const look = pointAt(dir, shows, { session: "S2", quest: "Q2" }, t0);
		const file = join(dir, `${look.id}.json`);
		const kept: Record<string, unknown> = JSON.parse(
			readFileSync(file, "utf8"),
		);
		writeFileSync(file, JSON.stringify({ ...kept, state: "opened" }));

		keepLooks(dir, { session: "S1", quest: "Q1" }, t0);

		expect(looksIn(dir)[0]).toMatchObject({ state: "resolved", how: "seen" });
	});

	it("keeps nothing where there is no list yet", () => {
		expect(keepLooks(join(dir, "none"), { session: "S1" }, t0)).toEqual([]);
	});

	it("tells the agent which of its looks went, by title", () => {
		const look = pointAt(dir, shows, { session: "S1" }, t0);

		expect(expiredText([]), "nothing to say").toBeUndefined();
		expect(expiredText([look])).toContain('"The narrow bar"');
	});

	it("expires a look the launcher opened a day after its tick stamped it, saying so", () => {
		const owner = { session: "S1", quest: "Q1" };
		const look = pointAt(
			dir,
			{ ...shows, title: "Pick one", choices: ["Keep It", "Drop It"] },
			owner,
			t0,
		);
		const file = join(dir, `${look.id}.json`);
		const kept: Record<string, unknown> = JSON.parse(
			readFileSync(file, "utf8"),
		);
		writeFileSync(file, JSON.stringify({ ...kept, state: "opened" }));
		const opened = new Date(t0.getTime() + SHOWING_LASTS_MS * 2);

		expect(keepLooks(dir, owner, opened), "stamped, not expired").toEqual([]);
		const expired = keepLooks(
			dir,
			owner,
			new Date(opened.getTime() + OPENED_LASTS_MS),
		);

		expect(expired.map((one) => one.openedAt)).toEqual([opened.toISOString()]);
		expect(expiredText(expired)).toContain(
			'"Pick one": each went a day unanswered after they opened it',
		);
		const shown = pointAt(dir, { ...shows, target: "/notes.md" }, owner, t0);
		expect(expiredText([shown])).toContain(
			'"The narrow bar": each asked nothing back and went a day unopened',
		);
	});

	it("changes nothing for a session that went while its tick read", async () => {
		const owner = { session: "S1", quest: "Q1" };
		pointAt(dir, { ...shows, kind: "file", target: "/notes.md" }, owner, t0);
		const told: unknown[] = [];
		const pi: Pick<ExtensionAPI, "exec" | "sendMessage"> = {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			sendMessage: (message) => {
				told.push(message);
			},
		};
		const ended = () => false;
		let standing = true;

		const reading = keepLooksFor(
			pi,
			dir,
			owner,
			ended,
			() => standing,
			listing(),
		);
		standing = false;
		await reading;
		expect(looksIn(dir)[0]?.state, "left for its next session").toBe("waiting");
		expect(told, "nobody to tell").toEqual([]);

		await keepLooksFor(pi, dir, owner, ended, () => true, listing());
		expect(looksIn(dir)[0]?.state, "expired by a session there").toBe(
			"expired",
		);
		expect(told, "and told").toHaveLength(1);
	});
});

describe("the looks of sessions that ended", () => {
	const pi: Pick<ExtensionAPI, "exec"> = {
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	const file = { ...shows, kind: "file" as const, target: "/notes.md" };

	it("resolve once the census finds the session gone, or it went unheard", async () => {
		const long = new Date(Date.now() - UNHEARD_CELL_MS - 60_000);
		const lately = new Date();
		pointAt(dir, { ...file, title: "mine" }, { session: "S1" }, long);
		pointAt(dir, { ...file, title: "gone" }, { session: "S2" }, long);
		pointAt(
			dir,
			{ ...file, title: "unheard" },
			{ session: "S3", address: "AAA333" },
			long,
		);
		pointAt(dir, { ...file, title: "off the mesh" }, { session: "S6" }, long);
		pointAt(
			dir,
			{ ...file, title: "just said" },
			{ session: "S4", address: "AAA444" },
			lately,
		);
		pointAt(dir, { ...file, title: "parked" }, { session: "S5" }, long);
		const gone = presence({ session: "S2" });
		const parked = presence({ session: "S5" });
		const judged: string[][] = [];

		await askAboutLooks(
			pi,
			dir,
			"S1",
			listing([gone, parked, presence({ session: "S9" })]),
			undefined,
			async (listed) => {
				judged.push(listed.map((one) => one.session));
				return { present: [parked], gone: [gone], resuming: [] };
			},
		);

		expect(
			judged,
			"every presence is judged, so the census sees each process whole",
		).toEqual([["S2", "S5", "S9"]]);
		expect(
			Object.fromEntries(looksIn(dir).map((look) => [look.title, look.state])),
		).toEqual({
			mine: "waiting",
			gone: "resolved",
			unheard: "resolved",
			"off the mesh": "waiting",
			"just said": "waiting",
			parked: "waiting",
		});
	});

	it("stay while a session there carries on their quest or their address", async () => {
		const long = new Date(Date.now() - UNHEARD_CELL_MS - 60_000);
		pointAt(
			dir,
			{ ...file, title: "rolled over" },
			{ session: "S2", quest: "Q2" },
			long,
		);
		pointAt(
			dir,
			{ ...file, title: "same address" },
			{ session: "S3", address: "AAA333" },
			long,
		);
		pointAt(
			dir,
			{ ...file, title: "nobody carries" },
			{ session: "S4", quest: "Q4" },
			long,
		);
		const ended = ["S2", "S3", "S4"].map((session) => presence({ session }));
		const next = presence({
			session: "S7",
			quest: "Q2",
			addresses: ["AAA333"],
		});

		await askAboutLooks(
			pi,
			dir,
			"S1",
			listing([...ended, next]),
			undefined,
			async () => ({ present: [next], gone: ended, resuming: [] }),
		);

		expect(
			Object.fromEntries(looksIn(dir).map((look) => [look.title, look.state])),
		).toEqual({
			"rolled over": "waiting",
			"same address": "waiting",
			"nobody carries": "resolved",
		});
	});

	it("take none as unheard when the listing found nobody", async () => {
		const long = new Date(Date.now() - UNHEARD_CELL_MS - 60_000);
		pointAt(dir, file, { session: "S2", address: "AAA222" }, long);

		await askAboutLooks(pi, dir, "S1", listing([]), undefined, async () => ({
			present: [],
			gone: [],
			resuming: [],
		}));

		expect(looksIn(dir)[0]?.state).toBe("waiting");
	});

	it("wait for a later turn when the presences can't be read", async () => {
		const long = new Date(Date.now() - UNHEARD_CELL_MS - 60_000);
		pointAt(dir, file, { session: "S2" }, long);

		await askAboutLooks(pi, dir, "S1", {
			listed: () => Promise.reject(new Error("unreadable")),
		});

		expect(looksIn(dir)[0]?.state).toBe("waiting");
	});
});
