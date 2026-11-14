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
import {
	inboxOf,
	steerFrom,
	takeSteers,
	waitingSteers,
} from "../../../lib/mesh/steer.ts";

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

	it("keeps now only when it is true, so a steer waits unless it says so", () => {
		expect(steerFrom('{"text":"go","now":true}', "f")?.now, "now true").toBe(
			true,
		);
		for (const now of ['"yes"', "1", "false"]) {
			expect(
				steerFrom(`{"text":"go","now":${now}}`, "f"),
				`now ${now}`,
			).not.toHaveProperty("now");
		}
		expect(
			steerFrom('{"act":"pause","now":true}', "f"),
			"an act",
		).not.toHaveProperty("now");
	});

	it("keeps a talk id only when it can name a file in the replies folder", () => {
		expect(steerFrom('{"text":"go","id":"t-01.a"}', "f")?.id).toBe("t-01.a");
		expect(steerFrom('{"text":"go","id":"../x"}', "f")?.id).toBeUndefined();
		expect(steerFrom('{"text":"go","id":".hidden"}', "f")?.id).toBeUndefined();
		expect(steerFrom('{"text":"go","id":7}', "f")?.id).toBeUndefined();
	});

	it("keeps the talk a steer answers only when it can name a talk", () => {
		expect(steerFrom('{"text":"go","id":"t2","re":"t1"}', "f")?.re).toBe("t1");
		expect(steerFrom('{"text":"go","re":"../x"}', "f")?.re).toBeUndefined();
		expect(steerFrom('{"text":"go","re":7}', "f")?.re).toBeUndefined();
	});

	it("reads an act with no text, and keeps words only beside resume", () => {
		expect(steerFrom('{"act":"pause"}', "f")).toEqual({
			text: "",
			act: "pause",
			file: "f",
		});
		expect(steerFrom('{"act":"stop","text":"now"}', "f")?.text).toBe("");
		expect(steerFrom('{"act":"close","text":"bye"}', "f")).toEqual({
			text: "",
			act: "close",
			file: "f",
		});
		expect(steerFrom('{"act":"resume","text":"go on"}', "f")).toMatchObject({
			act: "resume",
			text: "go on",
		});
		expect(steerFrom('{"act":"reboot"}', "f")).toBeUndefined();
	});

	it("lets only the person act, so a machine's steer can't pause or stop", () => {
		// A machine about to leave says so through its node (4UHC5Q, d0038fd8).
		expect(
			steerFrom(
				'{"from":"machine","act":"stop","text":"this machine leaves at 17:00"}',
				"f",
			),
		).toEqual({
			text: "this machine leaves at 17:00",
			from: "machine",
			file: "f",
		});
		expect(steerFrom('{"from":"machine","act":"pause"}', "f")).toBeUndefined();
		expect(steerFrom('{"from":"machine","act":"close"}', "f")).toBeUndefined();
		expect(steerFrom('{"from":"Joel","act":"pause"}', "f")?.act).toBe("pause");
	});

	it("keeps which of the machine's programs wrote a steer, and only a machine's", () => {
		// nix-offload telling integration no builder answers (5FWIUS, 8 November).
		const said =
			'{"from":"machine","by":"nix-offload","text":"no builder answers"}';
		expect(steerFrom(said, "f")).toMatchObject({
			from: "machine",
			by: "nix-offload",
		});
		expect(
			steerFrom('{"from":"joel","by":"nix-offload","text":"x"}', "f"),
		).not.toHaveProperty("by");
		expect(
			steerFrom('{"from":"machine","by":"the person","text":"x"}', "f"),
		).not.toHaveProperty("by");
	});

	// Joel, 8 November: "it should give me a prompt that gets filled into it".
	it("reads a fill with its words, and no fill without words or not the person's", () => {
		expect(
			steerFrom(
				'{"act":"fill","from":"joel","text":" ready if still valid "}',
				"f",
			),
		).toEqual({
			text: "ready if still valid",
			act: "fill",
			from: "joel",
			file: "f",
		});
		expect(steerFrom('{"act":"fill"}', "f")).toBeUndefined();
		// A machine's fill is only words, said as a message, never typed in.
		expect(
			steerFrom('{"act":"fill","from":"machine","text":"x"}', "f"),
		).not.toHaveProperty("act");
	});

	it("reads a carry with the machine it goes to, and no carry that names none", () => {
		expect(steerFrom('{"act":"carry","to":"penelope"}', "f")).toEqual({
			text: "",
			act: "carry",
			to: "penelope",
			file: "f",
		});
		expect(steerFrom('{"act":"carry"}', "f")).toBeUndefined();
		expect(steerFrom('{"act":"carry","to":"../x"}', "f")).toBeUndefined();
		expect(steerFrom('{"act":"close","to":"penelope"}', "f")).toEqual({
			text: "",
			act: "close",
			file: "f",
		});
		expect(
			steerFrom('{"from":"machine","act":"carry","to":"penelope"}', "f"),
		).toBeUndefined();
		// mycelium carry steers on the person's word, saying so.
		expect(
			steerFrom('{"from":"person","act":"carry","to":"penelope"}', "f"),
		).toMatchObject({ act: "carry", to: "penelope" });
	});

	it("reads a move with where it goes, and no move that names nowhere a session goes", () => {
		for (const to of ["attended", "background", "pi"]) {
			expect(steerFrom(`{"act":"move","to":"${to}"}`, "f")).toEqual({
				text: "",
				act: "move",
				to,
				file: "f",
			});
		}
		expect(steerFrom('{"act":"move"}', "f")).toBeUndefined();
		expect(steerFrom('{"act":"move","to":"penelope"}', "f")).toBeUndefined();
		// A carry's machine is no move's host, nor a host a carry's machine.
		expect(steerFrom('{"act":"carry","to":"pi"}', "f")).toMatchObject({
			act: "carry",
			to: "pi",
		});
		// Words beside a move would start a run it waits out.
		expect(
			steerFrom('{"act":"move","to":"background","text":"hi"}', "f"),
		).toMatchObject({ text: "", act: "move" });
		// Only the person moves a session.
		expect(
			steerFrom('{"from":"machine","act":"move","to":"pi"}', "f"),
		).toBeUndefined();
	});

	it("reads an answer with its want and a choice or words, and none missing either", () => {
		const want = "question@2026-11-12T06:00:00.000Z";
		expect(
			steerFrom(
				`{"act":"answer","from":"joel","want":"${want}","value":"keep","text":"hi"}`,
				"f",
			),
			"a choice, its words dropped so no run starts",
		).toEqual({
			text: "",
			act: "answer",
			from: "joel",
			want,
			given: { value: "keep" },
			file: "f",
		});
		expect(
			steerFrom(`{"act":"answer","want":"${want}","other":"Shorter"}`, "f"),
			"words of the person's own",
		).toMatchObject({ act: "answer", given: { other: "Shorter" } });
		expect(
			steerFrom('{"act":"answer","value":"keep"}', "f"),
			"no want named",
		).toBeUndefined();
		expect(
			steerFrom(`{"act":"answer","want":"${want}"}`, "f"),
			"nothing given",
		).toBeUndefined();
		expect(
			steerFrom(
				`{"act":"answer","from":"machine","want":"${want}","value":"keep"}`,
				"f",
			),
			"only the person answers",
		).toBeUndefined();
	});

	it("reads an answer to a look by its id, with a choice and never words", () => {
		expect(
			steerFrom(
				'{"act":"answer","from":"joel","look":"ab12","value":"Posted"}',
				"f",
			),
			"a look's choice",
		).toEqual({
			text: "",
			act: "answer",
			from: "joel",
			look: "ab12",
			given: { value: "Posted" },
			file: "f",
		});
		expect(
			steerFrom('{"act":"answer","look":"ab12","other":"Later"}', "f"),
			"a look offers choices only",
		).toBeUndefined();
		expect(
			steerFrom('{"act":"answer","look":7,"value":"Posted"}', "f"),
			"a look named by no id",
		).toBeUndefined();
	});

	it("reads what waits without taking it", () => {
		const inbox = inboxOf(root, "P9R1KI");
		takeSteers(inbox, "1");
		put(inbox, "1-a.json", JSON.stringify({ act: "carry", to: "penelope" }));
		put(inbox, "2-b.json", "not json");

		expect(waitingSteers(inbox).map((one) => one.act)).toEqual(["carry"]);
		expect(readdirSync(inbox).sort()).toEqual(["1-a.json", "2-b.json"]);
		expect(waitingSteers(inboxOf(root, "NOBODY"))).toEqual([]);
	});

	it("leaves a talk's replies folder in the inbox alone", () => {
		const inbox = inboxOf(root, "wcjqsg");
		mkdirSync(join(inbox, "replies"), { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ text: "go", id: "t1" }));
		expect(takeSteers(inbox, "1").steers.map((one) => one.id)).toEqual(["t1"]);
		expect(readdirSync(inbox)).toEqual(["replies"]);
	});
});
