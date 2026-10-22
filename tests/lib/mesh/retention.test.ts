/**
 * Retention: the mesh lets go of what is past its time, so its folders
 * hold the machine's present rather than its history.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import { createBoard, type Lease } from "../../../lib/mesh/lease.ts";
import { bridgePresences, bridgeTransport } from "../../../lib/mesh/legacy.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import {
	ENDED_MS,
	KEEP_MS,
	sweep,
	sweeper,
} from "../../../lib/mesh/retention.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-22T06:00:00Z");

let root: string;
let messages: string;
let legacy: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-retention-"));
	messages = join(root, "messages");
	legacy = join(root, "pi-mailbox");
	mkdirSync(messages, { recursive: true });
	mkdirSync(join(legacy, ".members"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A file last touched this long before now. */
function aged(path: string, text: string, ago: number): void {
	writeFileSync(path, text);
	const at = new Date(now - ago);
	utimesSync(path, at, at);
}

/** A message file stamped this long before now. */
function stamped(dir: string, ago: number, tail = "LUQ49E-1-aaaa"): string {
	const id = `${now - ago}-${tail}`;
	writeFileSync(
		join(dir, `${id}.json`),
		JSON.stringify({
			v: 1,
			id,
			at: new Date(now - ago).toISOString(),
			from: "LUQ49E",
			to: [ALL],
			intent: "fyi",
			text: "hi",
			pid: 1,
		}),
	);
	return id;
}

const presence = (session: string, at: number): Presence => ({
	session,
	addresses: [session.toUpperCase()],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	at: new Date(at).toISOString(),
});

describe("a folder of messages", () => {
	it("lets go of messages and markers older than it keeps", () => {
		const transport = folderTransport(messages);
		const old = stamped(messages, KEEP_MS + 1000);
		const recent = stamped(messages, KEEP_MS - 1000, "WCJQSG-2-bbbb");
		writeFileSync(join(messages, ".read-GONE"), old);
		writeFileSync(join(messages, ".read-HERE"), recent);
		writeFileSync(join(messages, "notes.json"), "{}");
		aged(join(messages, `.${recent}.json.9.tmp`), "{", KEEP_MS + 1000);

		transport.expire(now - KEEP_MS);

		expect(transport.ids()).toEqual([recent, "notes"]);
		expect(readdirSync(messages).sort()).toEqual([
			".read-HERE",
			`${recent}.json`,
			"notes.json",
		]);
	});

	it("lets go of the legacy mailbox's old mail and markers too", () => {
		const transport = bridgeTransport(folderTransport(messages), legacy);
		const old = stamped(legacy, KEEP_MS + 1000, "P9R1KI-4874");
		const recent = stamped(legacy, 1000, "P9R1KI-4874");
		// The old mailbox kept a marker as the file name it had read.
		writeFileSync(join(legacy, ".read-P9R1KI"), `${old}.json`);
		const mesh = stamped(messages, KEEP_MS + 1000);

		transport.expire(now - KEEP_MS);

		expect(transport.ids()).toEqual([recent]);
		expect(existsSync(join(legacy, ".read-P9R1KI"))).toBe(false);
		expect(existsSync(join(messages, `${mesh}.json`))).toBe(false);
		expect(existsSync(join(legacy, ".members"))).toBe(true);
	});
});

describe("the board", () => {
	it("lets go of a peer's file once none of its leases stands", () => {
		const board = createBoard(join(root, "leases"));
		const lease = (until: number): Lease => ({
			kind: "hold",
			subject: "x",
			since: new Date(until - 1000).toISOString(),
			until: new Date(until).toISOString(),
		});
		board.hold({ session: "ended", leases: [lease(now - 1)] });
		board.hold({
			session: "here",
			leases: [lease(now - 1), lease(now + 60_000)],
		});

		board.expire(now);

		expect(board.all().map((one) => one.session)).toEqual(["here"]);
	});
});

describe("the sweep", () => {
	const kept = () => {
		const presences = createPresences(join(root, "presence"));
		return {
			transport: folderTransport(messages),
			presences,
			board: createBoard(join(root, "leases")),
		};
	};

	it("forgets a peer a day after it ended, and never one still there", async () => {
		const at = kept();
		at.presences.publish(presence("ended-long", now - ENDED_MS - 1000));
		at.presences.publish(presence("ended-lately", now - ENDED_MS + 1000));
		at.presences.publish(presence("quiet", now - 30 * DAY));
		const old = stamped(messages, KEEP_MS + 1000);

		await sweep(at, now, async (everyone) => ({
			present: everyone.filter((one) => one.session === "quiet"),
			gone: everyone.filter((one) => one.session !== "quiet"),
		}));

		expect(
			at.presences
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["ended-lately", "quiet"]);
		expect(at.transport.ids()).not.toContain(old);
	});

	it("runs at most once an hour in a process", async () => {
		const at = kept();
		let clock = now;
		const tidy = sweeper(at, 60 * 60 * 1000, () => clock);
		const first = stamped(messages, KEEP_MS + 1000);
		tidy();
		await new Promise((done) => setTimeout(done, 20));
		expect(at.transport.ids()).not.toContain(first);

		const second = stamped(messages, KEEP_MS + 2000, "WCJQSG-2-cccc");
		clock += 59 * 60 * 1000;
		tidy();
		await new Promise((done) => setTimeout(done, 20));
		expect(at.transport.ids()).toContain(second);

		clock += 2 * 60 * 1000;
		tidy();
		await new Promise((done) => setTimeout(done, 20));
		expect(at.transport.ids()).not.toContain(second);
	});
});

describe("old memberships", () => {
	const member = (session: string, ago: number) =>
		aged(
			join(legacy, ".members", `${session}.json`),
			JSON.stringify({ session, names: [session.slice(0, 6)], channels: [] }),
			ago,
		);

	it("count only while they moved in the last day", () => {
		const presences = bridgePresences(
			createPresences(join(root, "presence")),
			legacy,
		);
		// Aged from the real clock: the day rule reads the machine's time.
		const realNow = Date.now();
		const age = (ago: number) => now - realNow + ago;
		member("p9r1ki-session", age(60 * 60 * 1000));
		member("135ed691-ended", age(DAY + 60 * 60 * 1000));

		expect(presences.all().map((one) => one.session)).toEqual([
			"p9r1ki-session",
		]);
		expect(presences.of("135ed691-ended")).toBeUndefined();
	});

	it("are let go of once nothing has moved them for the week", () => {
		const presences = bridgePresences(
			createPresences(join(root, "presence")),
			legacy,
		);
		member("old", KEEP_MS + 1000);
		member("recent", KEEP_MS - 1000);

		presences.expire(now - KEEP_MS);

		expect(readdirSync(join(legacy, ".members"))).toEqual(["recent.json"]);
	});

	it("go with a mesh peer's presence when it is forgotten", () => {
		const presences = bridgePresences(
			createPresences(join(root, "presence")),
			legacy,
		);
		presences.publish(presence("ended", now));
		expect(readdirSync(join(legacy, ".members"))).toEqual(["ended.json"]);

		presences.forget("ended");

		expect(presences.all()).toEqual([]);
		expect(readdirSync(join(legacy, ".members"))).toEqual([]);
	});
});
