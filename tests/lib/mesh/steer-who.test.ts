/**
 * Who a steer says carries it: an orchestrator's ordered carry, kept
 * apart from the person's, and this machine's node's own, read by
 * node@ and its machine against this machine's record of its name.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	inboxOf,
	type Steer,
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

describe("a carry an orchestrator ordered or a node chose", () => {
	it("reads when an ordered carry was put in the inbox from the millisecond its name opens with", () => {
		const raw =
			'{"act":"ordered-carry","to":"tern","why":"it needs the camera","by":"WCJQSG","from":"WCJQSG"}';
		expect(
			steerFrom(raw, "1795093200000-0a1b.json.ready")?.ordered?.put,
		).toEqual(new Date(1795093200000));
		expect(
			steerFrom(raw, "f")?.ordered,
			"none where its name says no time",
		).not.toHaveProperty("put");
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
			["by the person", { ...ordered, by: "person", from: "person" }],
			["by the machine", { ...ordered, by: "Machine", from: "machine" }],
			["by someone else than it is from", { ...ordered, by: "OSPHT4" }],
			["by no address", { ...ordered, by: "../x", from: "../x" }],
			["with no machine", { ...ordered, to: undefined }],
			["to no machine's name", { ...ordered, to: "../x" }],
			["with no why", { ...ordered, why: "  " }],
		] as const) {
			expect(steerFrom(JSON.stringify(body), "f"), said).toBeUndefined();
		}
		expect(
			steerFrom(
				JSON.stringify({ ...ordered, by: "WcJqSg", from: "wcjqsg" }),
				"f",
			)?.ordered?.by,
			"an address in any letters, said in capitals",
		).toBe("WCJQSG");
		expect(
			steerFrom(JSON.stringify({ ...ordered, from: "joel", text: "hi" }), "f"),
			"words from the person stay words, with no carry",
		).toEqual({ text: "hi", from: "joel", file: "f" });
	});

	// ISXEG8's conditions for mycelium's item 11, 17 November: a carry the
	// node chose to ease its machine is said as the node's, never as an
	// orchestrator's or the person's.
	it("reads a node's own carry by node@ and its machine, kept as written", () => {
		const eased = {
			act: "ordered-carry",
			to: "tern",
			why: "skiff has stalled for ten minutes and tern has room",
			by: "node@skiff",
			from: "node@skiff",
		};

		expect(steerFrom(JSON.stringify(eased), "f", "skiff")).toEqual({
			text: "",
			ordered: {
				to: "tern",
				why: "skiff has stalled for ten minutes and tern has room",
				by: "node@skiff",
			},
			from: "node@skiff",
			file: "f",
		});
		const lettered = { ...eased, by: "node@Skiff-2", from: "node@Skiff-2" };
		expect(
			steerFrom(JSON.stringify(lettered), "f", "Skiff-2")?.ordered?.by,
			"its machine's name in its own letters",
		).toBe("node@Skiff-2");
		expect(
			steerFrom(JSON.stringify(lettered), "f", "skiff-2"),
			"a name that matches this machine's only in other letters",
		).toBeUndefined();
	});

	it("takes no node's carry when no machine is given, even its record's own, since only the inbox's readers say which machine is here", () => {
		const state = mkdtempSync(join(tmpdir(), "steer-state-"));
		mkdirSync(join(state, "mycelium"), { recursive: true });
		writeFileSync(join(state, "mycelium", "machine"), "skiff\n");
		vi.stubEnv("XDG_STATE_HOME", state);
		try {
			const eased = (node: string) =>
				JSON.stringify({
					act: "ordered-carry",
					to: "tern",
					why: "skiff has stalled",
					by: node,
					from: node,
				});
			expect(
				steerFrom(eased("node@skiff"), "f"),
				"the node its record names",
			).toBeUndefined();
			expect(
				steerFrom(eased("node@kestrel"), "f"),
				"another machine's node than the record names",
			).toBeUndefined();
			expect(
				steerFrom(eased("node@skiff"), "f", "skiff")?.ordered?.by,
				"the node of the machine given",
			).toBe("node@skiff");
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("takes this machine's node's carry through every inbox reader, reading its record off the thread where the reader is", async () => {
		const state = mkdtempSync(join(tmpdir(), "steer-state-"));
		mkdirSync(join(state, "mycelium"), { recursive: true });
		const record = join(state, "mycelium", "machine");
		writeFileSync(record, "skiff\n");
		vi.stubEnv("XDG_STATE_HOME", state);
		const eased = (node: string) =>
			JSON.stringify({
				act: "ordered-carry",
				to: "tern",
				why: "skiff has stalled",
				by: node,
				from: node,
			});
		try {
			const inbox = inboxOf(root, "WAITS1");
			mkdirSync(inbox, { recursive: true });
			// The record read off the thread names kestrel, the disk skiff: only
			// a record read the way the steers are read takes kestrel's carry.
			const readOff = (path: string) =>
				path === record
					? Promise.resolve("kestrel\n")
					: Promise.resolve(readFileSync(path, "utf8"));
			put(inbox, "1-a.json", eased("node@kestrel"));
			expect(
				(await waitingSteers(inbox, readOff)).map((steer) => steer.ordered?.by),
				"waiting, for a parked peer, the record read as the steers are",
			).toEqual(["node@kestrel"]);
			rmSync(join(inbox, "1-a.json"));

			put(inbox, "2-a.json", eased("node@skiff"));
			expect(
				takeSteers(inbox, "WAITS1").steers.map((s) => s.ordered?.by),
				"taken on the thread",
			).toEqual(["node@skiff"]);

			put(inbox, "3-a.json", eased("node@kestrel").replaceAll("@", "\\u0040"));
			expect(
				(await takenSteers(inbox, "WAITS1", readOff)).steers.map(
					(steer) => steer.ordered?.by,
				),
				"an @ written as an escape is read off the thread too",
			).toEqual(["node@kestrel"]);

			put(inbox, "4-a.json", eased("node@kestrel"));
			const own = (await takenSteers(inbox, "WAITS1", readOff)).steers;
			expect(
				own.map((steer) => steer.ordered?.by),
				"taken off the thread, the record read as the steers are",
			).toEqual(["node@kestrel"]);
			expect(
				own.map((steer) => steer.ordered?.refused),
				"this machine's own node's carry, unrefused",
			).toEqual([undefined]);

			// Another machine's node than each reader's record names is handed
			// on refused, naming both, so the session says why it took none;
			// no node here began it, so none waits on that refusal.
			const refusedOf = (steers: Steer[]) =>
				steers.map((steer) => steer.ordered?.refused);
			const notHere = (named: string, here: string) =>
				`it names node@${named}, but this machine is ${here}, so it isn't this machine's node's carry`;
			// Named as the node names its steers, from the millisecond it put it.
			put(inbox, "1795093200005-a.json", eased("node@skiff"));
			expect(
				refusedOf(await waitingSteers(inbox, readOff)),
				"waiting, another machine's node",
			).toEqual([notHere("skiff", "kestrel")]);
			const taken = await takenSteers(inbox, "WAITS1", readOff);
			expect(
				refusedOf(taken.steers),
				"taken off the thread, another machine's node",
			).toEqual([notHere("skiff", "kestrel")]);
			expect(
				taken.steers[0]?.ordered?.put,
				"refused, it keeps when it was put, which its refusal is stamped by",
			).toEqual(new Date(1795093200005));
			expect(taken.bad).toEqual([]);
			put(inbox, "6-a.json", eased("node@kestrel"));
			expect(
				refusedOf(takeSteers(inbox, "WAITS1").steers),
				"taken on the thread, another machine's node",
			).toEqual([notHere("kestrel", "skiff")]);

			// A record that doesn't answer is unread, so the person's stop
			// taken with it waits no longer than the deadline.
			put(inbox, "7-a.json", eased("node@kestrel"));
			put(inbox, "8-a.json", JSON.stringify({ act: "stop", from: "joel" }));
			const stalled = (path: string) =>
				path === record
					? new Promise<string>(() => {})
					: Promise.resolve(readFileSync(path, "utf8"));
			const late = await takenSteers(inbox, "WAITS1", stalled, () => true, 10);
			expect(late.steers.map((steer) => steer.act ?? "carry")).toEqual([
				"carry",
				"stop",
			]);
			expect(late.steers[0]?.ordered?.refused).toContain(
				"can't be read (no answer within 0.01 s)",
			);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("hands on a node's carry refused, saying why, while its machine's record is there but unread", async () => {
		// A read on the thread would find osprey, so the node's carry is
		// handed on only if it is read as its own node would have it, with
		// no read on the thread.
		const state = mkdtempSync(join(tmpdir(), "steer-state-"));
		try {
			mkdirSync(join(state, "mycelium"), { recursive: true });
			writeFileSync(join(state, "mycelium", "machine"), "osprey\n");
			vi.stubEnv("XDG_STATE_HOME", state);
			// Home is the state folder, so the record is said from home
			// wherever the run's temporary folder lies.
			vi.stubEnv("HOME", state);
			const inbox = inboxOf(root, "WAITS2");
			mkdirSync(inbox, { recursive: true });
			put(
				inbox,
				"1-a.json",
				JSON.stringify({
					act: "ordered-carry",
					to: "tern",
					why: "skiff has stalled",
					by: "node@skiff",
					from: "node@skiff",
				}),
			);
			put(
				inbox,
				"2-a.json",
				JSON.stringify({
					act: "fill",
					from: "joel",
					text: "go on",
					by: "node@skiff",
				}),
			);
			put(inbox, "3-a.json", JSON.stringify({ act: "stop", from: "joel" }));
			put(
				inbox,
				"4-a.json",
				JSON.stringify({
					act: "ordered-carry",
					to: "penelope",
					why: "its camera work needs the Mac",
					by: "WCJQSG",
					from: "WCJQSG",
				}),
			);
			const unread = (path: string) =>
				path.startsWith(inbox)
					? Promise.resolve(readFileSync(path, "utf8"))
					: Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
			const every = ["1-a.json", "2-a.json", "3-a.json", "4-a.json"];
			const refusedOf = (steers: Steer[]) =>
				steers.map((steer) => steer.ordered?.refused);
			const why =
				"this machine's record of its name, ~/mycelium/machine, can't be read (EIO), so whose node's carry it is can't be told";
			const waiting = await waitingSteers(inbox, unread);
			expect(
				waiting.map((steer) => steer.file),
				"each waits, so a parked session wakes to take the node's, reading the record again",
			).toEqual(every);
			expect(refusedOf(waiting)).toEqual([
				why,
				undefined,
				undefined,
				undefined,
			]);
			const taken = await takenSteers(inbox, "WAITS2", unread);
			expect(taken.steers.map((steer) => steer.file)).toEqual(every);
			expect(
				refusedOf(taken.steers),
				"only the node's carry is refused, and says why",
			).toEqual([why, undefined, undefined, undefined]);
			expect(taken.steers[0]?.ordered?.by).toBe("node@skiff");
			expect(taken.bad).toEqual([]);
			expect(readdirSync(inbox), "every steer taken").toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("takes a node's carry refused on the thread too while its machine's record is there but unread", () => {
		const state = mkdtempSync(join(tmpdir(), "steer-state-"));
		try {
			// A folder where the record goes: there, but never read as one.
			mkdirSync(join(state, "mycelium", "machine"), { recursive: true });
			vi.stubEnv("XDG_STATE_HOME", state);
			// Said from home, as the handover it goes in says every path.
			vi.stubEnv("HOME", state);
			const inbox = inboxOf(root, "WAITS4");
			mkdirSync(inbox, { recursive: true });
			put(
				inbox,
				"1-a.json",
				JSON.stringify({
					act: "ordered-carry",
					to: "tern",
					why: "skiff has stalled",
					by: "node@skiff",
					from: "node@skiff",
				}),
			);
			put(inbox, "2-a.json", JSON.stringify({ act: "stop", from: "joel" }));

			const taken = takeSteers(inbox, "WAITS4");

			expect(taken.steers.map((steer) => steer.ordered?.refused)).toEqual([
				"this machine's record of its name, ~/mycelium/machine, can't be read (EISDIR), so whose node's carry it is can't be told",
				undefined,
			]);
			// Written nowhere: whose node's it is can't be told.
			expect(taken.steers[1]?.act).toBe("stop");
			expect(taken.bad).toEqual([]);

			// A record that reads but names nothing says so, not that it
			// couldn't be read.
			rmSync(join(state, "mycelium", "machine"), {
				recursive: true,
				force: true,
			});
			writeFileSync(join(state, "mycelium", "machine"), "  \n");
			put(
				inbox,
				"3-a.json",
				JSON.stringify({
					act: "ordered-carry",
					to: "tern",
					why: "skiff has stalled",
					by: "node@skiff",
					from: "node@skiff",
				}),
			);
			expect(
				takeSteers(inbox, "WAITS4").steers.map(
					(steer) => steer.ordered?.refused,
				),
			).toEqual([
				"this machine's record of its name, ~/mycelium/machine, names no machine, so whose node's carry it is can't be told",
			]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("reads no machine record for an inbox holding no node's carry", async () => {
		const state = mkdtempSync(join(tmpdir(), "steer-state-"));
		vi.stubEnv("XDG_STATE_HOME", state);
		const inbox = inboxOf(root, "WAITS3");
		mkdirSync(inbox, { recursive: true });
		put(inbox, "1-a.json", JSON.stringify({ from: "joel", text: "go on" }));
		// An orchestrator's order, a node's carry naming no machine, and a
		// node's name on what is no carry: none is a node's carry to read
		// the record for.
		const carry = { act: "ordered-carry", to: "tern", why: "it has stalled" };
		put(
			inbox,
			"2-a.json",
			JSON.stringify({ ...carry, by: "WCJQSG", from: "WCJQSG" }),
		);
		put(
			inbox,
			"3-a.json",
			JSON.stringify({ ...carry, by: "node@../x", from: "node@../x" }),
		);
		put(
			inbox,
			"4-a.json",
			JSON.stringify({
				from: "node@skiff",
				by: "node@skiff",
				text: "skiff is easing",
			}),
		);
		const asked: string[] = [];
		const readOff = (path: string) => {
			asked.push(path);
			return Promise.resolve(readFileSync(path, "utf8"));
		};
		try {
			expect(
				(await waitingSteers(inbox, readOff)).map((steer) => steer.file),
			).toEqual(expect.arrayContaining(["1-a.json", "2-a.json"]));
			const taken = (await takenSteers(inbox, "WAITS3", readOff)).steers;
			expect(taken.map((steer) => steer.file)).toEqual(
				expect.arrayContaining(["1-a.json", "2-a.json"]),
			);
			expect(
				taken.find((steer) => steer.file === "2-a.json")?.ordered?.by,
				"the orchestrator's order taken as ever",
			).toBe("WCJQSG");
			expect(asked.filter((path) => !path.startsWith(inbox))).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("takes no node's carry but this machine's own, from it, by its name", () => {
		const eased = {
			act: "ordered-carry",
			to: "tern",
			why: "skiff has stalled",
			by: "node@skiff",
			from: "node@skiff",
		};
		for (const [said, body] of [
			["from another machine's node", { ...eased, from: "node@kestrel" }],
			[
				"by another machine's node",
				{ ...eased, by: "node@kestrel", from: "node@kestrel" },
			],
			["from an orchestrator", { ...eased, from: "WCJQSG" }],
			["from the person", { ...eased, from: "person" }],
			["from the machine", { ...eased, from: "machine" }],
			["from the node in other letters", { ...eased, from: "NODE@SKIFF" }],
			[
				"by no machine's name",
				{ ...eased, by: "node@../x", from: "node@../x" },
			],
			["by a node of no machine", { ...eased, by: "node@", from: "node@" }],
			[
				"by a node in other letters",
				{ ...eased, by: "NODE@skiff", from: "NODE@skiff" },
			],
		] as const) {
			expect(
				steerFrom(JSON.stringify(body), "f", "skiff"),
				said,
			).toBeUndefined();
		}
	});
});
