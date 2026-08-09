/**
 * A fleet is written down, so one can be found after its session is
 * gone.
 *
 * The reason is the reason the review side has a ledger, arrived at
 * the same way and one layer down. A fleet's answers exist in exactly
 * two places: the tool result handed back to the session that asked,
 * and the transcripts on disk. When the session dies mid-fleet the
 * first never happens, and nothing records that the second is worth
 * keeping, so the retention sweep takes it on the ordinary window.
 * The work was paid for and nobody ever reads it.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";
import { createFleetLedger } from "../../../lib/subagent/fleet.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-ledger-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A fleet as the tool dispatches one. */
function fleet(id: string, jobs: string[] = ["one", "two"]) {
	return { id, startedAt: new Date().toISOString(), jobs };
}

describe("a fleet ledger", () => {
	it("holds a fleet from before it is dispatched", async () => {
		// Before, not after. A fleet recorded when it finishes is a
		// fleet that is recorded exactly when nothing needed it to be:
		// the whole population this exists for is the fleets that never
		// reached their own ending.
		const ledger = createFleetLedger(root);

		await ledger.open(fleet("fleet-a"));

		expect((await ledger.everyFleet()).runs).toEqual([
			expect.objectContaining({ id: "fleet-a", open: true }),
		]);
	});

	it("marks a fleet settled without forgetting it", async () => {
		// Kept rather than deleted, because the transcripts outlive the
		// answer and somebody reading a summary a day later still needs
		// to be able to find what a job actually said.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));

		await ledger.settle("fleet-a");

		const { runs } = await ledger.everyFleet();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.open).toBeUndefined();
		expect(runs[0]?.settledAt).toEqual(expect.any(String));
	});

	it("names every fleet nothing has read yet", async () => {
		// What the sweep is told. A settled fleet has been handed back
		// to whoever asked for it, so its transcripts are a
		// convenience; an open one is the only copy there is.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-open"));
		await ledger.open(fleet("fleet-done"));
		await ledger.settle("fleet-done");

		const { open, unreadable } = await ledger.openFleets();

		expect(open).toEqual(new Set(["fleet-open"]));
		expect(unreadable).toEqual([]);
	});

	it("names a file it could not read rather than passing over it", async () => {
		// The lesson the review ledger paid for. A torn file read as
		// "no open fleets" is not the cautious answer, it is the
		// destructive one: the sweep is then told nothing needs keeping
		// and deletes exactly the work this protects.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-open"));
		writeFileSync(join(root, "torn.json"), "{ not json", "utf8");

		const { open, unreadable } = await ledger.openFleets();

		expect(open).toEqual(new Set(["fleet-open"]));
		expect(unreadable).toEqual([join(root, "torn.json")]);
	});

	it("answers an empty ledger without making one", async () => {
		// Read on every session start, including the overwhelming
		// majority that never dispatch a fleet at all. Creating a
		// directory to discover it is empty is a write on a read path.
		const ledger = createFleetLedger(join(root, "not-yet"));

		expect((await ledger.everyFleet()).runs).toEqual([]);
		expect((await ledger.openFleets()).open).toEqual(new Set());
		expect(await readdir(root)).toEqual([]);
	});

	it("keeps a fleet whose id is nothing like a filename", async () => {
		// Ids arrive from a caller. One with a slash in it would write
		// outside the ledger, or fail, and the run it belonged to would
		// go unprotected either way. The id itself is kept in the file,
		// so what comes back is what was asked for rather than the name
		// it was stored under.
		const ledger = createFleetLedger(root);

		await ledger.open(fleet("../../etc/fleet a"));

		expect((await ledger.openFleets()).open).toEqual(
			new Set(["../../etc/fleet a"]),
		);
		const files = await readdir(root);
		expect(files).toHaveLength(1);
		expect(files[0]).not.toContain("/");
	});

	it("refuses a record whose owner is half written", async () => {
		// Which way a half-written owner falls is the whole reason to
		// check it. A pid with no birthday cannot be identified, so it
		// reads as a session that has gone, and that is the reading
		// which offers somebody a live fleet's protection to delete.
		// Refusing the record stops the sweep instead, which is the
		// outcome that costs nothing but a message.
		writeFileSync(
			join(root, "fleet-a.json"),
			JSON.stringify({
				id: "fleet-a",
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				open: true,
				owner: { pid: 4242 },
			}),
			"utf8",
		);

		const { open, unreadable } = await createFleetLedger(root).openFleets();

		expect(open.size).toBe(0);
		expect(unreadable).toEqual([join(root, "fleet-a.json")]);
	});

	it("settles a fleet it has never heard of without inventing one", async () => {
		// A settle whose open write failed, which is the ordering this
		// uses on purpose: recording a fleet must never cost the fleet,
		// so the open write is best effort. Writing a settled record
		// here would put a fleet on the ledger that nothing protected
		// while it ran, which reads as evidence that it was safe.
		const ledger = createFleetLedger(root);

		await ledger.settle("never-opened");

		expect((await ledger.everyFleet()).runs).toEqual([]);
	});

	it("refuses to settle over a record it cannot read", async () => {
		// One file, one answer. Returning quietly here while the sweep
		// calls the same file unreadable and stops on this machine for
		// good gives two readings of one fault, and the quiet one
		// overwrites the evidence the loud one is refusing over.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		const path = join(root, "fleet-a.json");
		writeFileSync(path, "{ not json", "utf8");

		await expect(ledger.settle("fleet-a")).rejects.toThrow(path);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	it("survives two fleets settling at once", async () => {
		// One file per fleet rather than one file holding all of them.
		// Two sessions running fleets at the same time is ordinary, and
		// a read-modify-write over a shared file loses one of them.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		await ledger.open(fleet("fleet-b"));

		await Promise.all([ledger.settle("fleet-a"), ledger.settle("fleet-b")]);

		expect((await ledger.openFleets()).open).toEqual(new Set());
		expect((await ledger.everyFleet()).runs).toHaveLength(2);
	});

	it("keeps two writes for one fleet from staging over each other", async () => {
		// The collision that does exist in one process, where two fleets
		// in two files is not one at all: an open and a settle for the
		// same id, staged under a name keyed only on the pid, race for
		// one path and rename a mixed document into place.
		const ledger = createFleetLedger(root);

		await Promise.all([
			ledger.open(fleet("fleet-a", ["one"])),
			ledger.open(fleet("fleet-a", ["two", "three", "four"])),
			ledger.open(fleet("fleet-a", ["five", "six"])),
		]);

		const { runs, unreadable } = await ledger.everyFleet();
		expect(unreadable).toEqual([]);
		expect(runs).toHaveLength(1);
		expect(await readdir(root)).toEqual(["fleet-a.json"]);
		// What landed, not merely that something did. A torn rename
		// leaves a document that parses and says the wrong thing, so a
		// count of files cannot see the failure this is named for: the
		// job lists differ in length, and the survivor has to be exactly
		// one of the three.
		expect([["one"], ["two", "three", "four"], ["five", "six"]]).toContainEqual(
			runs[0]?.jobs,
		);
	});

	it("reclaims a write that never got as far as its rename", async () => {
		// The failure the write-and-rename pair exists for leaves its
		// staging file behind, and nothing reaches those again. In the
		// one directory whose whole purpose is to stay small, that is
		// the leak arriving by the door the safety measure opened.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		await ledger.settle("fleet-a");
		const abandoned = join(root, "fleet-b.json.999.1.staging");
		writeFileSync(abandoned, "{}", "utf8");
		const long = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(abandoned, long, long);

		await ledger.forgetSettledBefore(new Date("2020-01-01T00:00:00.000Z"));

		// The settled fleet is inside the window and stays; the staging
		// file is nobody's and goes.
		expect(await readdir(root)).toEqual(["fleet-a.json"]);
	});

	it("leaves a staging file another process may be mid-write on", async () => {
		// The gap a staging name covers is a write and a rename, which
		// is microseconds, so a fresh one is somebody's. Deleting every
		// one a listing turns up means a session start can destroy
		// another process's ledger write in flight, which is a fleet
		// losing its protection at the moment it was being granted.
		const ledger = createFleetLedger(root);
		const live = join(root, "fleet-b.json.999.1.staging");
		await ledger.open(fleet("fleet-a"));
		writeFileSync(live, "{}", "utf8");

		await ledger.forgetSettledBefore(new Date());

		expect(existsSync(live)).toBe(true);
	});

	it("keeps a record whose settled time will not parse", async () => {
		// Asking whether an unreadable date is recent enough to keep
		// answers no, because every comparison against NaN is false, so
		// the record goes whatever the cutoff says. One small file is
		// cheaper than a fleet forgotten on the strength of a field
		// nothing could read.
		writeFileSync(
			join(root, "fleet-odd.json"),
			JSON.stringify({
				id: "fleet-odd",
				startedAt: "2019-01-01T00:00:00.000Z",
				jobs: ["one"],
				settledAt: "the other day",
			}),
			"utf8",
		);
		const ledger = createFleetLedger(root);

		expect(await ledger.forgetSettledBefore(new Date())).toBe(0);
		expect(await readdir(root)).toEqual(["fleet-odd.json"]);
	});

	it("forgets the file it read, not one derived from the record", async () => {
		// The two are the same path for every record this wrote, and are
		// not for one somebody put there by hand. Deriving deletes a
		// different fleet's record and leaves this one to be found again
		// on the next pass, which is a sweep that reports progress and
		// destroys a neighbour.
		writeFileSync(
			join(root, "put-here-by-hand.json"),
			JSON.stringify({
				id: "fleet-live",
				startedAt: "2019-01-01T00:00:00.000Z",
				jobs: ["one"],
				settledAt: "2019-01-01T00:00:00.000Z",
			}),
			"utf8",
		);
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-live"));

		expect(await ledger.forgetSettledBefore(new Date())).toBe(1);

		expect(await readdir(root)).toEqual(["fleet-live.json"]);
		expect((await ledger.openFleets()).open).toEqual(new Set(["fleet-live"]));
	});

	it("will not let an id climb out of the ledger", async () => {
		// Two dots name the parent directory. The spelling escapes a
		// leading dot, so this lands inside as a name that reads rather
		// than one that walks; the same spelling keys the transcripts,
		// where an id is a bare directory segment and the escape is what
		// stops it being the parent. Held here as well because this is
		// the caller taking an id straight from a tool parameter.
		const ledger = createFleetLedger(join(root, "inside"));

		await ledger.open(fleet(".."));

		expect(await readdir(root)).toEqual(["inside"]);
		expect((await ledger.openFleets()).open).toEqual(new Set([".."]));
	});

	it("spells an id the way the transcripts spell it", async () => {
		// The ledger record and the run directory are keyed by the same
		// id, so they have to sanitize it the same way. Two spellings
		// means two ways for distinct ids to collide, differently, and a
		// pair sharing one ledger record while owning separate
		// directories: settling either releases the protection on both.
		//
		// Compared against the transcripts rather than against
		// `safeSegment`, which would only say this file calls the
		// function it calls. The agreement is with the other caller.
		const awkward = "../../etc/fleet a";
		const ledger = createFleetLedger(root);
		const store = new ReviewerArtifactsStore(join(root, "transcripts"));

		await ledger.open(fleet(awkward));

		const [named] = await readdir(root);
		expect(named).toBe(`${basename(store.paths(awkward, "one").runDir)}.json`);
	});

	it("forgets a settled fleet once its transcripts would be gone", async () => {
		// Without a window of its own the ledger is the unbounded thing
		// it was built to bound: one file per fleet ever dispatched, all
		// of them read at every session start, long after the
		// transcripts they point at have been reclaimed.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-old"));
		await ledger.settle("fleet-old");
		await ledger.open(fleet("fleet-recent"));
		await ledger.settle("fleet-recent");
		await ledger.open(fleet("fleet-open"));
		// Aged by rewriting the record, since the window is read from
		// what the record says rather than from the file's mtime.
		const path = join(root, "fleet-old.json");
		const old = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...old, settledAt: "2020-01-01T00:00:00.000Z" }),
			"utf8",
		);

		const forgotten = await ledger.forgetSettledBefore(
			new Date("2021-01-01T00:00:00.000Z"),
		);

		expect(forgotten).toBe(1);
		expect(
			(await ledger.everyFleet()).runs.map((run) => run.id).sort(),
		).toEqual(["fleet-open", "fleet-recent"]);
	});

	it("never forgets a fleet nobody has collected, however old", async () => {
		// Protection is absolute, and a record dropped is protection
		// dropped: the next sweep would take the transcripts it named.
		const ledger = createFleetLedger(root);
		await ledger.open({
			id: "fleet-ancient",
			startedAt: "2019-01-01T00:00:00.000Z",
			jobs: ["one"],
		});

		expect(await ledger.forgetSettledBefore(new Date())).toBe(0);
		expect((await ledger.openFleets()).open).toEqual(
			new Set(["fleet-ancient"]),
		);
	});

	it("never forgets an open fleet, even one carrying a settled time", async () => {
		// Written straight to disk, because nothing here produces this
		// shape and that is the point: the window has to turn on the
		// mark meaning "nobody has read this", not on whichever field
		// happens to be a date. A record another version wrote, or a
		// settle that got half way, is what reaches this branch.
		writeFileSync(
			join(root, "fleet-muddled.json"),
			JSON.stringify({
				id: "fleet-muddled",
				startedAt: "2019-01-01T00:00:00.000Z",
				jobs: ["one"],
				open: true,
				settledAt: "2019-01-01T00:00:00.000Z",
			}),
			"utf8",
		);
		const ledger = createFleetLedger(root);

		expect(await ledger.forgetSettledBefore(new Date())).toBe(0);
		expect((await ledger.openFleets()).open).toEqual(
			new Set(["fleet-muddled"]),
		);
	});

	it("clears the settled time when an id is dispatched again", async () => {
		// A caller may reuse a run id, and the ledger takes whatever
		// record it is handed. Carrying the old settled time forward
		// leaves the new fleet open and stamped with a date from the
		// last one, which is the contradiction above arriving by an
		// ordinary route.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		await ledger.settle("fleet-a");
		const settled = (await ledger.everyFleet()).runs[0];
		if (settled === undefined) throw new Error("nothing was settled");

		await ledger.open(settled);

		const again = (await ledger.everyFleet()).runs[0];
		expect(again?.open).toBe(true);
		expect(again?.settledAt).toBeUndefined();
	});

	it("passes over anything that is not a ledger file", async () => {
		// The directory is somebody's state directory and will collect
		// editor droppings and half-written temporary files.
		const ledger = createFleetLedger(root);
		await ledger.open(fleet("fleet-a"));
		writeFileSync(join(root, "notes.txt"), "not a ledger", "utf8");
		// Named the way a ledger file is named, because the extension
		// filter above catches anything else before the read: this is
		// the only shape that reaches the branch that tells a directory
		// from a file that will not parse.
		mkdirSync(join(root, "looks-like.json"));

		const { runs, unreadable } = await ledger.everyFleet();
		expect(runs).toHaveLength(1);
		expect(unreadable).toEqual([]);
	});

	it("names a record of the wrong shape, rather than dropping it", async () => {
		// A file that parses but is not a fleet is no more readable than
		// one that does not parse, and reading it as "nothing to keep"
		// is how a sweep deletes work while reporting a clean run.
		const ledger = createFleetLedger(root);
		writeFileSync(join(root, "wrong-shape.json"), '{"nope":1}', "utf8");

		expect((await ledger.openFleets()).unreadable).toEqual([
			join(root, "wrong-shape.json"),
		]);
	});

	it("names the directory itself when that is what will not open", async () => {
		// The branch that declines every sweep on the machine. A ledger
		// directory that exists and cannot be listed says nothing about
		// which fleets are open, which is the one thing the caller has
		// to know before it deletes anything.
		const shut = join(root, "shut");
		mkdirSync(shut);
		chmodSync(shut, 0o000);

		try {
			expect((await createFleetLedger(shut).openFleets()).unreadable).toEqual([
				shut,
			]);
		} finally {
			chmodSync(shut, 0o700);
		}
	});
});
