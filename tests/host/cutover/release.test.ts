import { describe, expect, it } from "vitest";
import {
	chooseReleased,
	type HeldConversation,
	type ReleaseFacts,
	releaseBack,
	releaseProse,
} from "../../../host/cutover/release.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";

const held = (session: string, kind: "attended" | "background" = "attended") =>
	({ session, host: `work-${kind}`, kind }) satisfies HeldConversation;

const ADDRESSES: Record<string, string[]> = {
	s1: ["AAAAAA", "s1"],
	s2: ["BBBBBB"],
	s3: ["CCCCCC"],
};

/** A realm whose conversations close after some looks, as each frees up. */
function fakeRealm(
	closes: Record<string, { after: number; holds?: string[]; note?: boolean }>,
	conversations = Object.keys(closes).map((one) => held(one)),
) {
	let looks = 0;
	let clock = 0;
	const told: string[] = [];
	const journals: { quest: string; prose: string }[] = [];
	const said: string[] = [];
	let refreshed = 0;
	const facts: ReleaseFacts = {
		held: async () =>
			conversations.filter(
				(one) =>
					!told.includes(ADDRESSES[one.session]?.[0] ?? one.session) ||
					looks <= (closes[one.session]?.after ?? Number.POSITIVE_INFINITY),
			),
		addressesOf: (session) =>
			// Its presence goes once it has closed.
			conversations.some((one) => one.session === session)
				? (ADDRESSES[session] ?? [])
				: [],
		tell: (address) => told.push(address),
		note: (session): MoveNote | undefined =>
			closes[session]?.note === false
				? undefined
				: {
						session,
						sessionFile: `/logs/${session}.jsonl`,
						cwd: "/src",
						to: "pi",
						at: "2026-11-24T19:00:00.000Z",
						addresses: ADDRESSES[session] ?? [],
						...(session === "s3" ? {} : { quest: `Q-${session}` }),
						from: "work-attended",
						pid: 1,
					},
		holds: async (session) => closes[session]?.holds?.[looks - 1],
		refreshRestore: () => {
			refreshed += 1;
		},
		journal: (quest, prose) => {
			journals.push({ quest, prose });
			return true;
		},
		now: () => clock,
		pause: async (ms) => {
			clock += ms;
			looks += 1;
		},
		say: (line) => said.push(line),
	};
	return {
		facts,
		told,
		journals,
		said,
		refreshes: () => refreshed,
	};
}

describe("chooseReleased", () => {
	it("picks by address in any case or by session id, and names what no host holds", () => {
		const all = [held("s1"), held("s2"), held("s3")];
		const { chosen, unknown } = chooseReleased(
			all,
			(session) => ADDRESSES[session] ?? [],
			["aaaaaa", "s2", "AAAAAA", "ZZZZZZ"],
		);
		expect(chosen.map((one) => one.session)).toEqual(["s1", "s2"]);
		expect(unknown).toEqual(["ZZZZZZ"]);
		expect(
			chooseReleased(all, () => [], "all").chosen.map((one) => one.session),
		).toEqual(["s1", "s2", "s3"]);
	});
});

describe("releaseBack", () => {
	it("tells each to move back, waits for each to close, offers them and journals what the host held", async () => {
		const realm = fakeRealm({
			s1: { after: 0 },
			s2: {
				after: 2,
				holds: ["a run is under way", "background jobs are out"],
			},
		});
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(realm.told).toEqual(["AAAAAA", "BBBBBB"]);
		expect(report.released.map((one) => one.address)).toEqual([
			"AAAAAA",
			"BBBBBB",
		]);
		expect(report.waiting).toEqual([]);
		expect(realm.refreshes(), "restore.json written once, after").toBe(1);
		expect(realm.journals).toEqual([
			{
				quest: "Q-s1",
				prose:
					"AAAAAA was released from the work-attended host back to plain pi at 2026-11-24T19:00:00.000Z, and waits in the launcher's Sessions to Reopen to open from the same file. It closed at once, holding nothing. Only the host held its screen, so any viewer on it closed with it.",
			},
			{
				quest: "Q-s2",
				prose: expect.stringContaining(
					"Before it closed it waited while a run is under way; then while background jobs are out.",
				),
			},
		]);
	});

	it("leaves one still held at the deadline waiting, with what holds it", async () => {
		const realm = fakeRealm({
			s1: { after: 99, holds: new Array(99).fill("a prompt is open") },
		});
		const report = await releaseBack(["AAAAAA"], realm.facts, 6_000);

		expect(report.released).toEqual([]);
		expect(report.waiting).toEqual([
			{ address: "AAAAAA", holds: "a prompt is open" },
		]);
		expect(
			realm.said.filter((line) => line.includes("waits")),
			"said once while it holds the same",
		).toEqual(["AAAAAA waits: a prompt is open"]);
	});

	it("names one gone without a note as not offered, and one without a quest as not journaled", async () => {
		const realm = fakeRealm({
			s1: { after: 0, note: false },
			s3: { after: 0 },
		});
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(report.lost).toEqual(["AAAAAA"]);
		expect(report.released).toMatchObject([
			{ address: "CCCCCC", journaled: false },
		]);
		expect(realm.journals).toEqual([]);
	});

	it("tells nobody it wasn't asked to", async () => {
		const realm = fakeRealm({ s1: { after: 0 }, s2: { after: 0 } });
		const report = await releaseBack(["s2"], realm.facts, 60_000);

		expect(realm.told).toEqual(["BBBBBB"]);
		expect(report.released.map((one) => one.session)).toEqual(["s2"]);
	});
});

describe("releaseProse", () => {
	it("says where it went, how to open it and what closed with the host", () => {
		expect(
			releaseProse({
				address: "AAAAAA",
				session: "s1",
				from: "work-background",
				at: "2026-11-24T19:00:00.000Z",
				waitedFor: ["messages wait for it"],
			}),
		).toBe(
			"AAAAAA was released from the work-background host back to plain pi at 2026-11-24T19:00:00.000Z, and waits in the launcher's Sessions to Reopen to open from the same file. Before it closed it waited while messages wait for it. Only the host held its screen, so any viewer on it closed with it.",
		);
	});
});
