import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createHeavyCalls,
	createLeasing,
	leasesText,
} from "../../../extensions/mesh-workflow/leases.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	createBoard,
	type LeaseEvent,
	MOST_HOLD_MS,
	type OwnLeases,
	ownLeases,
	RUN_LEASE_MS,
} from "../../../lib/mesh/lease.ts";
import type { Draft } from "../../../lib/mesh/message.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-leasing-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Leasing for a peer signing as LUQ49E, with its own leases. */
function leasing() {
	const board = createBoard(join(root, "leases"));
	const transport = folderTransport(join(root, "messages"));
	const own: OwnLeases = ownLeases(board, "me");
	const self = {
		session: "me",
		addresses: ["LUQ49E"],
		signature: "LUQ49E",
	} as unknown as Peer;
	const at = createLeasing({
		board,
		presences: createPresences(join(root, "presence")),
		transport,
		own: () => own,
		peer: () => self,
		sent: () => {},
	});
	const from = (over: Partial<Draft>) =>
		transport.send({
			from: "WCJQSG",
			to: [ALL],
			intent: "fyi",
			text: "x",
			pid: process.pid + 1,
			...over,
		});
	const mine = (over: Partial<Draft>) =>
		from({ from: "LUQ49E", pid: process.pid, ...over });
	return { at, own, from, mine };
}

describe("a wait on a hold", () => {
	it("ends by the clock once the hold has stood two hours", async () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "my test waits" }));

		expect(await at.lapsed(Date.now() + MOST_HOLD_MS - 60_000)).toEqual([]);
		const ends = await at.lapsed(Date.now() + MOST_HOLD_MS);

		expect(ends).toEqual([
			{
				hold,
				how: "it has stood two hours, as long as a hold lasts",
				said: false,
				why: "my test waits",
			},
		]);
		expect(own.leases).toEqual([]);
	});

	it("moves to the hold that replaces it, and ends with that one", () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "waiting" }));

		const longer = from({
			intent: "hold",
			supersedes: hold.id,
			text: "hold qemu and nix",
		});
		expect(at.ended(longer)).toBeUndefined();
		expect(own.leases).toMatchObject([{ kind: "wait", subject: longer.id }]);

		const over = from({ supersedes: longer.id, text: "done" });
		expect(at.ended(over)).toMatchObject({ hold: longer, why: "waiting" });
		expect(own.leases).toEqual([]);
	});

	it("is not ended by a peer other than the holder", () => {
		const { at, own, from, mine } = leasing();
		const hold = from({ intent: "hold", text: "hold qemu" });
		at.sent(mine({ re: hold.id, text: "waiting" }));

		const other = from({
			from: "P9R1KI",
			pid: process.pid + 2,
			re: hold.id,
			text: "over, I think",
		});

		expect(at.ended(other)).toBeUndefined();
		expect(own.leases).toMatchObject([{ kind: "wait", subject: hold.id }]);
	});

	it("is not taken on this peer's own hold, nor on what is not a hold", () => {
		const { at, own, from, mine } = leasing();
		const question = from({ intent: "question", text: "who has qemu?" });
		at.sent(mine({ re: question.id, text: "me" }));
		const hold = mine({ intent: "hold", text: "hold builds" });
		at.sent(hold);
		at.sent(mine({ re: hold.id, text: "still holding" }));

		expect(own.leases.map(({ kind }) => kind)).toEqual([]);
	});
});

describe("a question taken up", () => {
	it("stays claimed while the run answering it goes on, and only that", () => {
		const { at, own, from } = leasing();
		const now = Date.now();
		const going = from({ intent: "question", text: "who has qemu?" });
		const dropped = from({ intent: "question", text: "who has nix?" });
		own.take("answer", going.id, RUN_LEASE_MS, "who has qemu?", now - 540_000);
		own.take("answer", dropped.id, RUN_LEASE_MS, "who has nix?", now - 660_000);
		own.take("change", "a.ts", RUN_LEASE_MS, undefined, now - 540_000);

		at.stillAnswering();

		const until = (subject: string) =>
			Date.parse(
				own.leases.find((lease) => lease.subject === subject)?.until ?? "",
			);
		expect(until(going.id)).toBeGreaterThanOrEqual(now + RUN_LEASE_MS);
		expect(until(dropped.id)).toBeLessThan(now);
		expect(until("a.ts")).toBeLessThan(now + RUN_LEASE_MS);
	});
});

describe("leases as listed", () => {
	const present = (session: string, address: string): Presence => ({
		session,
		addresses: [address],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: "",
	});

	it("count a peer's changes past the first three, and say the rest by kind", () => {
		const now = Date.now();
		const until = new Date(now + 60_000).toISOString();
		const lease = (kind: string, subject: string, why?: string) => ({
			kind,
			subject,
			since: "",
			until,
			...(why ? { why } : {}),
		});
		const board = [
			{
				session: "w",
				leases: [
					lease("change", "a"),
					lease("change", "b"),
					lease("change", "c"),
					lease("change", "d"),
					lease("change", "e"),
					lease("wait", "20261022-0101-0001-aaaaaaaa", "my test"),
					lease("heavy", "qemu", "vm test"),
					{ ...lease("answer", "x"), until: new Date(now - 1).toISOString() },
				],
			},
			{ session: "gone", leases: [lease("change", "z")] },
		] as never;

		expect(leasesText(board, [present("w", "WCJQSG")], now)).toBe(
			"\nLeases:\nWCJQSG: changing a, b, c and 2 more; waiting on [aaaaaaaa] (my test); running heavy work on qemu (vm test)",
		);
		expect(leasesText([], [present("w", "WCJQSG")], now)).toBe("");
	});

	it("say a checkout rewritten as what left its files as they are", () => {
		const now = Date.now();
		const until = new Date(now + 60_000).toISOString();
		const board = [
			{
				session: "w",
				leases: [
					{
						kind: "change" as const,
						subject: "w:a",
						since: "",
						until,
						checkout: "/w",
					},
					{
						kind: "change" as const,
						subject: "/w",
						since: "",
						until,
						checkout: "/w",
						why: "git switch fix",
					},
				],
			},
		];

		expect(leasesText(board, [present("w", "WCJQSG")], now)).toBe(
			"\nLeases:\nWCJQSG: rewrote the files of /w (git switch fix); changing w:a",
		);
	});

	it("put a hand's leases under the peer it works for", () => {
		const now = Date.now();
		const heavy = {
			kind: "heavy" as const,
			subject: "nix build",
			since: "",
			until: new Date(now + 60_000).toISOString(),
			why: "nix build, by a subagent",
		};
		const board = [
			{ session: "w.hand.run.lens", handOf: "w", leases: [heavy] },
		];

		expect(leasesText(board, [present("w", "WCJQSG")], now)).toBe(
			"\nLeases:\nWCJQSG: running heavy work on nix build (nix build, by a subagent)",
		);
	});
});

describe("heavy shell calls", () => {
	const text = (words: string) => [{ type: "text", text: words }];
	const tracked = () => {
		const events: LeaseEvent[] = [];
		const calls = createHeavyCalls(
			(event) => events.push(event),
			(command) => `why: ${command}`,
		);
		return { events, calls };
	};

	it("claim the heavy work a command runs, and nothing for one that runs none", () => {
		const { events, calls } = tracked();

		expect(calls.called("1", "nix build .#x")).toBe("nix build");
		expect(calls.called("2", "ls -la")).toBeUndefined();
		expect(calls.called("3", 42)).toBeUndefined();

		expect(events).toEqual([
			{ take: { subject: "nix build", why: "why: nix build .#x" } },
		]);
	});

	it("give the work up as the last call running it answers", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#a");
		calls.called("2", "nix build .#b");

		calls.answered("1", text("done"));
		expect(events.filter((event) => "release" in event)).toEqual([]);
		calls.answered("2", text("done"));

		expect(events.filter((event) => "release" in event)).toEqual([
			{ release: "nix build" },
		]);
	});

	it("keep the work of a call handed to a job until the job ends", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#a");

		calls.answered("1", text("Running in the background as job 3f2a."));
		expect(events.filter((event) => "release" in event)).toEqual([]);
		calls.finished("1");

		expect(events.filter((event) => "release" in event)).toEqual([
			{ release: "nix build" },
		]);
	});
});
