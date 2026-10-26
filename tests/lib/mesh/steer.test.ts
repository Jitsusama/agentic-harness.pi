/**
 * The steer inbox: what the person writes to a peer's folder is taken
 * once, oldest first, and what is not a steer is set aside.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { inboxOf, steerFrom, takeSteers } from "../../../lib/mesh/steer.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "steer-"));
});

/** Written as the launcher writes: a temporary name, renamed in. */
function put(inbox: string, name: string, body: string) {
	writeFileSync(join(inbox, `${name}.tmp`), body);
	renameSync(join(inbox, `${name}.tmp`), join(inbox, name));
}

describe("the steer inbox", () => {
	it("is a folder per address, upper-cased as addresses are", () => {
		expect(inboxOf("/s", "p9r1ki")).toBe("/s/P9R1KI");
	});

	it("makes the folder on first look, so a writer finds it", () => {
		const inbox = inboxOf(root, "P9R1KI");
		expect(takeSteers(inbox, "1")).toEqual({ steers: [], bad: [] });
		expect(readdirSync(inbox)).toEqual([]);
	});

	it("takes each steer once, oldest name first, leaving nothing behind", () => {
		const inbox = inboxOf(root, "P9R1KI");
		takeSteers(inbox, "1");
		put(inbox, "2-b.json", JSON.stringify({ text: "then this", from: "joel" }));
		put(inbox, "1-a.json", JSON.stringify({ text: " pivot to the disk " }));
		const taken = takeSteers(inbox, "1");
		expect(taken.steers.map((steer) => steer.text)).toEqual([
			"pivot to the disk",
			"then this",
		]);
		expect(taken.steers[1]?.from).toBe("joel");
		expect(readdirSync(inbox)).toEqual([]);
		expect(takeSteers(inbox, "2").steers).toEqual([]);
	});

	it("leaves a file still being written, under its temporary name", () => {
		const inbox = inboxOf(root, "P9R1KI");
		takeSteers(inbox, "1");
		writeFileSync(join(inbox, "3-c.json.tmp"), '{"text": "half');
		expect(takeSteers(inbox, "1").steers).toEqual([]);
		expect(readdirSync(inbox)).toEqual(["3-c.json.tmp"]);
	});

	it("sets aside what is not a steer, never trying it again", () => {
		const inbox = inboxOf(root, "P9R1KI");
		takeSteers(inbox, "1");
		put(inbox, "4-d.json", "not json");
		put(inbox, "5-e.json", JSON.stringify({ text: "  " }));
		expect(takeSteers(inbox, "1")).toEqual({
			steers: [],
			bad: ["4-d.json", "5-e.json"],
		});
		expect(readdirSync(inbox).sort()).toEqual(["4-d.json.bad", "5-e.json.bad"]);
		expect(takeSteers(inbox, "1").bad).toEqual([]);
	});

	it("reads only text, at and from, as strings", () => {
		expect(steerFrom('{"text":"go","at":3,"from":"joel"}', "f")).toEqual({
			text: "go",
			from: "joel",
			file: "f",
		});
		expect(steerFrom('["go"]', "f")).toBeUndefined();
	});

	it("keeps a talk id only when it can name a file in the replies folder", () => {
		expect(steerFrom('{"text":"go","id":"t-01.a"}', "f")?.id).toBe("t-01.a");
		expect(steerFrom('{"text":"go","id":"../x"}', "f")?.id).toBeUndefined();
		expect(steerFrom('{"text":"go","id":".hidden"}', "f")?.id).toBeUndefined();
		expect(steerFrom('{"text":"go","id":7}', "f")?.id).toBeUndefined();
	});

	it("reads an act with no text, and keeps words only beside resume", () => {
		expect(steerFrom('{"act":"pause"}', "f")).toEqual({
			text: "",
			act: "pause",
			file: "f",
		});
		expect(steerFrom('{"act":"stop","text":"now"}', "f")?.text).toBe("");
		expect(steerFrom('{"act":"resume","text":"go on"}', "f")).toMatchObject({
			act: "resume",
			text: "go on",
		});
		expect(steerFrom('{"act":"reboot"}', "f")).toBeUndefined();
	});

	it("leaves a talk's replies folder in the inbox alone", () => {
		const inbox = inboxOf(root, "wcjqsg");
		mkdirSync(join(inbox, "replies"), { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ text: "go", id: "t1" }));
		expect(takeSteers(inbox, "1").steers.map((one) => one.id)).toEqual(["t1"]);
		expect(readdirSync(inbox)).toEqual(["replies"]);
	});
});
