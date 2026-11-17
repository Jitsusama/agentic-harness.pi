/**
 * The steer inbox: what the person writes to a peer's folder is taken
 * once, oldest first, and what is not a steer is set aside.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	inboxOf,
	isPersonsTalk,
	steerFrom,
	takenSteers,
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

	// Every conversation a host holds looks at its inboxes each minute, so
	// a disk that stalls a synchronous read stalls them all.
	it("takes as it takes at once, letting the thread turn while it reads", async () => {
		const inbox = inboxOf(root, "P9R1KI");
		expect(await takenSteers(inbox, "1"), "made on first look").toEqual({
			steers: [],
			bad: [],
		});
		put(inbox, "2-b.json", JSON.stringify({ text: "then this", from: "joel" }));
		put(inbox, "1-a.json", JSON.stringify({ text: " pivot to the disk " }));
		put(inbox, "4-d.json", "not json");
		writeFileSync(join(inbox, "3-c.json.tmp"), '{"text": "half');
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const taken = await takenSteers(inbox, "1");

		expect(turned, "the thread turned while the inbox was read").toBe(true);
		expect(
			taken.steers.map((steer) => steer.text),
			"oldest name first",
		).toEqual(["pivot to the disk", "then this"]);
		expect(taken.bad, "what is not a steer set aside").toEqual(["4-d.json"]);
		expect(readdirSync(inbox).sort(), "only the half-written one left").toEqual(
			["3-c.json.tmp", "4-d.json.bad"],
		);
		expect((await takenSteers(inbox, "2")).steers, "taken once").toEqual([]);
	});

	// A taker can end while its read waits: a reload, a host's restart,
	// or its watchdog's kill on the stalled disk the read waits on.
	it("leaves a steer waiting while its read stalls, never claimed and lost", async () => {
		const inbox = inboxOf(root, "P9R1KI");
		mkdirSync(inbox, { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ text: "the person's answer" }));
		let land: (raw: string) => void = () => undefined;
		const stalled = new Promise<string>((resolve) => {
			land = resolve;
		});
		let reading = false;

		const taking = takenSteers(inbox, "1", () => {
			reading = true;
			return stalled;
		});
		await vi.waitFor(() => expect(reading, "the read began").toBe(true));

		expect(
			readdirSync(inbox),
			"still waiting under its own name while the read stalls",
		).toEqual(["1-a.json"]);
		land(JSON.stringify({ text: "the person's answer" }));
		expect(
			(await taking).steers.map((steer) => steer.text),
			"taken once the read lands",
		).toEqual(["the person's answer"]);
		expect(readdirSync(inbox), "nothing left behind").toEqual([]);
	});

	// The council on #1721: a taker stopped while a later read stalled
	// still claimed what it read after, for a session that had ended.
	it("claims nothing once its taker stops while a read waits", async () => {
		const inbox = inboxOf(root, "P9R1KI");
		mkdirSync(inbox, { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ text: "first" }));
		put(inbox, "2-b.json", JSON.stringify({ text: "second" }));
		let land: () => void = () => undefined;
		const stalled = new Promise<void>((resolve) => {
			land = resolve;
		});
		let stopped = false;
		let reads = 0;

		const taking = takenSteers(
			inbox,
			"1",
			async (path) => {
				reads += 1;
				if (reads === 2) await stalled;
				return readFileSync(path, "utf8");
			},
			() => !stopped,
		);
		await vi.waitFor(() => expect(reads, "the second read began").toBe(2));
		stopped = true;
		land();

		expect((await taking).steers, "none taken for an ended taker").toEqual([]);
		expect(readdirSync(inbox).sort(), "both still waiting").toEqual([
			"1-a.json",
			"2-b.json",
		]);
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

	// ISXEG8's condition 3, 15 November: an orchestrator's carry is never
	// the person's, so nothing that trusts the person's carry reads it.
	it("reads an orchestrator's ordered carry apart from the person's carry", () => {
		const ordered = {
			act: "ordered-carry",
			to: "penelope",
			why: "its camera work needs the Mac",
			by: "WCJQSG",
			from: "WCJQSG",
			at: "2026-11-15T15:00:00Z",
		};

		const read = steerFrom(JSON.stringify(ordered), "f");

		expect(read).toEqual({
			text: "",
			ordered: {
				to: "penelope",
				why: "its camera work needs the Mac",
				by: "WCJQSG",
			},
			at: "2026-11-15T15:00:00Z",
			from: "WCJQSG",
			file: "f",
		});
		expect(read, "never an act the person's path takes").not.toHaveProperty(
			"act",
		);
	});

	it("takes no ordered carry that claims the person or misses its words", () => {
		const ordered = {
			act: "ordered-carry",
			to: "penelope",
			why: "the Mac",
			by: "WCJQSG",
			from: "WCJQSG",
		};
		for (const [said, body] of [
			["from the person", { ...ordered, from: "person" }],
			["from Joel", { ...ordered, from: "joel" }],
			["from nobody", { ...ordered, from: undefined }],
			["from the machine", { ...ordered, from: "machine" }],
			["by someone else than it is from", { ...ordered, by: "OSPHT4" }],
			["by no address", { ...ordered, by: "../x", from: "../x" }],
			["with no machine", { ...ordered, to: undefined }],
			["to no machine's name", { ...ordered, to: "../x" }],
			["with no why", { ...ordered, why: "  " }],
		] as const) {
			expect(steerFrom(JSON.stringify(body), "f"), said).toBeUndefined();
		}
		expect(
			steerFrom(JSON.stringify({ ...ordered, from: "joel", text: "hi" }), "f"),
			"words from the person stay words, with no carry",
		).toEqual({ text: "hi", from: "joel", file: "f" });
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

	it("reads what waits without taking it, letting the thread turn", async () => {
		const inbox = inboxOf(root, "P9R1KI");
		takeSteers(inbox, "1");
		put(inbox, "1-a.json", JSON.stringify({ act: "carry", to: "penelope" }));
		put(inbox, "2-b.json", "not json");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const waiting = await waitingSteers(inbox);

		expect(turned, "the thread turned while the inbox was read").toBe(true);
		expect(waiting.map((one) => one.act)).toEqual(["carry"]);
		expect(readdirSync(inbox).sort()).toEqual(["1-a.json", "2-b.json"]);
		expect(await waitingSteers(inboxOf(root, "NOBODY"))).toEqual([]);
	});

	it("leaves a talk's replies folder in the inbox alone", () => {
		const inbox = inboxOf(root, "wcjqsg");
		mkdirSync(join(inbox, "replies"), { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ text: "go", id: "t1" }));
		expect(takeSteers(inbox, "1").steers.map((one) => one.id)).toEqual(["t1"]);
		expect(readdirSync(inbox)).toEqual(["replies"]);
	});
});

describe("a steer that is the person's own words", () => {
	it("is a talk or a resume with words that Joel or the node on his word wrote", () => {
		expect(isPersonsTalk({ text: "go on", from: "joel" }), "a talk").toBe(true);
		expect(
			isPersonsTalk({ text: "go on", act: "resume", from: "Joel" }),
			"a resume with words",
		).toBe(true);
		expect(
			isPersonsTalk({ text: "carry on", from: "person" }),
			"the node on his word",
		).toBe(true);
	});

	it("is never an agent's, the machine's, an unnamed writer's, a bare act or an answer", () => {
		const refused = {
			"an agent's steer": { text: "go on", from: "WCJQSG" },
			"the machine's": { text: "leaving at six", from: "machine" },
			"an unnamed writer's": { text: "go on" },
			"an automated resume": { text: "", act: "resume", from: "joel" },
			"a bare pause": { text: "", act: "pause", from: "joel" },
			"words filled into the prompt": {
				text: "draft",
				act: "fill",
				from: "joel",
			},
			"an answer to an ask": { text: "yes", act: "answer", from: "joel" },
		} as const;
		for (const [kind, steer] of Object.entries(refused)) {
			expect(isPersonsTalk(steer), kind).toBe(false);
		}
	});
});
