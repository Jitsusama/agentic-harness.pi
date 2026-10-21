/**
 * The mailbox folder: what goes in, what comes out, and how far a
 * session has read.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMailbox,
	isFor,
	type Mail,
	recipients,
} from "../../../lib/mail/mailbox.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mailbox-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const mail = (over: Partial<Mail> = {}): Mail => ({
	at: "2026-10-21T22:00:00.000Z",
	from: "WCJQSG",
	to: ["ALL"],
	text: "hold heavy builds",
	pid: 1,
	...over,
});

describe("a mailbox", () => {
	it("hands back what was sent, oldest first, leaving nothing staged", async () => {
		const box = createMailbox(join(dir, "box"));

		const first = box.send(mail({ text: "one" }));
		await new Promise((wake) => setTimeout(wake, 2));
		const second = box.send(mail({ text: "two" }));

		expect(box.list()).toEqual([first, second]);
		expect(box.read(second)?.text).toBe("two");
		expect(
			readdirSync(join(dir, "box")).filter((f) => f.startsWith(".")),
		).toEqual([]);
	});

	it("keeps two messages sent in the same millisecond", () => {
		const box = createMailbox(dir);

		for (let n = 0; n < 20; n++) box.send(mail({ text: `${n}` }));

		expect(box.list()).toHaveLength(20);
	});

	it("passes over a file that is not a message", () => {
		const box = createMailbox(dir);
		writeFileSync(join(dir, "1-X-1.json"), '{"nope":1}', "utf8");
		writeFileSync(join(dir, "2-X-1.json"), "{torn", "utf8");

		expect(box.read("1-X-1.json")).toBeUndefined();
		expect(box.read("2-X-1.json")).toBeUndefined();
	});

	it("answers an empty listing when the folder is not there yet", () => {
		expect(createMailbox(join(dir, "never")).list()).toEqual([]);
	});

	it("remembers the furthest a session has read, under any of its names", () => {
		const box = createMailbox(dir);
		box.markRead("7M6JKG", "200-A-1.json");
		box.markRead("01A15F3A", "300-A-1.json");

		expect(box.lastRead(["7M6JKG", "01A15F3A"])).toBe("300-A-1.json");
		expect(box.lastRead(["NOBODY"])).toBeUndefined();
	});

	it("never winds a marker back", () => {
		// A watcher can report an older file after a newer one, and a
		// marker wound back hands the newer mail out again.
		const box = createMailbox(dir);
		box.markRead("7M6JKG", "300-A-1.json");
		box.markRead("7M6JKG", "200-A-1.json");

		expect(box.lastRead(["7M6JKG"])).toBe("300-A-1.json");
	});
});

describe("who mail is for", () => {
	it("reaches everyone named, and everyone for ALL", () => {
		expect(isFor(mail({ to: ["7M6JKG"] }), ["7M6JKG", "01A15F3A"], 2)).toBe(
			true,
		);
		expect(isFor(mail(), ["P9R1KI"], 2)).toBe(true);
		expect(isFor(mail({ to: ["OVAE1I"] }), ["P9R1KI"], 2)).toBe(false);
	});

	it("never hands a session its own mail, by name or by process", () => {
		expect(isFor(mail({ from: "P9R1KI" }), ["P9R1KI"], 2)).toBe(false);
		expect(isFor(mail({ from: "CA6H2X", pid: 2 }), ["P9R1KI"], 2)).toBe(false);
	});

	it("reads recipients the way a person types them", () => {
		expect(recipients(" p9r1ki, all ,,")).toEqual(["P9R1KI", "ALL"]);
	});
});
