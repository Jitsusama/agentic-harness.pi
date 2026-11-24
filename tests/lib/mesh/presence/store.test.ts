/**
 * Presences as kept on disk: what a peer's file says once read back,
 * read again only once it changes, what a malformed one reads as, and
 * how a host's conversations read them from one mirror.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHost } from "../../../../lib/core/session/index.ts";
import {
	clearRefusedWake,
	writeRefusedWake,
} from "../../../../lib/internal/session/refused-wake.ts";
import type { Wanted } from "../../../../lib/internal/write-whole.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { presence, session } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("presences", () => {
	it("keep a peer's presence by its session id", () => {
		createPresences(root).publish(presence());

		expect(createPresences(root).of("s-1")).toEqual(presence());
		expect(createPresences(root).of("s-2")).toBeUndefined();
	});

	it("list every peer, passing over one that will not read", () => {
		const presences = createPresences(root);
		presences.publish(presence());
		presences.publish(presence({ session: "s-2", addresses: ["BRAVO2"] }));
		writeFileSync(join(root, "torn.json"), "{", "utf8");

		expect(
			presences
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-1", "s-2"]);
	});

	it("keep the words a window on a hosted conversation runs, only when they are words", () => {
		const view = ["node", "host-join.ts", "--session", "s-1", "--", "pi"];
		const presences = createPresences(root);
		presences.publish(
			presence({
				hosted: { host: "work-attended", conversation: "s-1", view },
			}),
		);
		writeFileSync(
			join(root, "s-2.json"),
			JSON.stringify({
				...presence({ session: "s-2" }),
				hosted: { host: "work-attended", conversation: "s-2", view: [] },
			}),
			"utf8",
		);

		expect(presences.of("s-1")?.hosted?.view).toEqual(view);
		expect(presences.of("s-2")?.hosted).toBeUndefined();
	});

	// As a mycelium node writes a session that runs on another machine.
	it("say which machine a session elsewhere runs on", () => {
		writeFileSync(
			join(root, "s-3.json"),
			JSON.stringify({
				...presence({ session: "s-3" }),
				machine: "equilibrius",
			}),
			"utf8",
		);

		createPresences(root).publish(presence());

		const read = createPresences(root).of("s-3");
		expect(read?.machine).toBe("equilibrius");
		expect(read?.owner).toBeUndefined();
		const here = createPresences(root).of("s-1");
		expect(here?.machine).toBeUndefined();
	});

	it("read a file again only once it has changed", () => {
		const presences = createPresences(root);
		presences.publish(presence());
		const first = presences.all()[0];
		expect(presences.all()[0], "an unchanged file is not parsed again").toBe(
			first,
		);

		presences.publish(presence({ busy: true }));
		expect(presences.all()[0]?.busy, "a publish is read").toBe(true);

		// As another writer does it, in place and inside one clock tick.
		const path = join(root, "s-1.json");
		const at = new Date("2026-11-11T11:00:00Z");
		writeFileSync(path, JSON.stringify(presence({ worksOn: "aaaa" })));
		utimesSync(path, at, at);
		expect(presences.of("s-1")?.worksOn).toBe("aaaa");
		writeFileSync(path, JSON.stringify(presence({ worksOn: "a longer one" })));
		utimesSync(path, at, at);
		expect(presences.of("s-1")?.worksOn, "a size that changed is read").toBe(
			"a longer one",
		);

		rmSync(path);
		expect(presences.all(), "a removed file is gone").toEqual([]);
		expect(presences.of("s-1")).toBeUndefined();
	});

	// A clock lists them in every conversation a host holds, and a disk
	// stalled at 09:14 on 16 November held a host's thread 5 to 17 s at a
	// time inside a synchronous listing.
	it("list every peer as all() does, letting the thread turn while they are read", async () => {
		const presences = createPresences(root);
		presences.publish(presence());
		presences.publish(presence({ session: "s-2", addresses: ["BRAVO2"] }));
		writeFileSync(join(root, "torn.json"), "{", "utf8");
		let turned = false;
		setImmediate(() => {
			turned = true;
		});

		const listed = await presences.listed();

		expect(turned, "the thread turned while the folder was read").toBe(true);
		expect(
			listed.map((one) => one.session).sort(),
			"the torn file passed over",
		).toEqual(["s-1", "s-2"]);
		expect(listed, "what all() lists").toEqual(presences.all());
	});

	it("keep one parse of a file between a listing and all()", async () => {
		const presences = createPresences(root);
		presences.publish(presence());
		const first = (await presences.listed())[0];
		expect(presences.all()[0], "all() keeps the listing's parse").toBe(first);
		expect((await presences.listed())[0], "a listing keeps all()'s parse").toBe(
			first,
		);

		presences.publish(presence({ busy: true }));
		expect((await presences.listed())[0]?.busy, "a publish is read").toBe(true);
		rmSync(join(root, "s-1.json"));
		expect(await presences.listed(), "a removed file is gone").toEqual([]);
		expect(presences.of("s-1")).toBeUndefined();
	});

	it("list none for a folder not made yet", async () => {
		await expect(
			createPresences(join(root, "never")).listed(),
		).resolves.toEqual([]);
	});

	it("say why a parked peer's host refused its last wake, reading it again only once it changed", () => {
		const presences = createPresences(root);
		const wake = join(root, "a", "wake");
		mkdirSync(dirname(wake), { recursive: true });
		const parked = presence({ state: "parked", wake });
		expect(presences.refusal(parked), "none kept").toBeUndefined();

		const refused = {
			messageId: "2f95756a",
			reason: "the host is stopping",
			at: "2026-11-11T14:00:00.000Z",
		};
		writeRefusedWake(wake, refused);
		const first = presences.refusal(parked);
		expect(first, "the kept refusal").toEqual(refused);
		expect(
			presences.refusal(parked),
			"an unchanged file is not read again",
		).toBe(first);
		expect(
			presences.refusal(presence({ state: "listening", wake })),
			"none for a peer no longer parked",
		).toBeUndefined();

		writeRefusedWake(wake, { ...refused, reason: "the gate said no" });
		expect(presences.refusal(parked)?.reason, "a new refusal is read").toBe(
			"the gate said no",
		);
		clearRefusedWake(wake);
		expect(presences.refusal(parked), "gone once cleared").toBeUndefined();
	});
});

describe("this session's peer", () => {
	it("reads an older presence with no quest, folder or repository as it was", () => {
		const presences = createPresences(join(root, "presence"));
		presences.publish({
			session,
			addresses: ["24B025FE"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});

		const read = presences.of(session);
		expect(read?.questInfo).toBeUndefined();
		expect(read?.cwd).toBeUndefined();
		expect(read?.repo).toBeUndefined();
	});

	it("reads no move it can't make sense of", () => {
		const presences = createPresences(join(root, "presence"));
		mkdirSync(join(root, "presence"), { recursive: true });
		writeFileSync(
			join(root, "presence", "s-1.json"),
			JSON.stringify({
				...presence(),
				moving: { to: "penelope", since: "2026-11-10T09:00:00.000Z" },
				moveOff: { to: "attended", since: "2026-11-10T09:00:00.000Z" },
			}),
		);
		expect(presences.of("s-1")).not.toHaveProperty("moving");
		expect(presences.of("s-1"), "one saying no why").not.toHaveProperty(
			"moveOff",
		);
	});

	it("reads a presence whose terminal is malformed as naming none", () => {
		const dir = join(root, "presence");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${presence().session}.json`),
			JSON.stringify({
				...presence(),
				terminal: { driverId: "kitty", value: 8 },
			}),
		);

		expect(
			createPresences(dir).of(presence().session)?.terminal,
		).toBeUndefined();
	});

	// Every address is minted as a quest's six letters or a session's
	// eight, so anything else in a file was written by something else, and
	// each of the many lines that print a peer by its first address would
	// print it as it stands, newlines and all.
	it("reads a presence's addresses as only those shaped as addresses", () => {
		const dir = join(root, "presence");
		mkdirSync(dir, { recursive: true });
		const write = (session: string, addresses: unknown) =>
			writeFileSync(
				join(dir, `${session}.json`),
				JSON.stringify({ ...presence({ session }), addresses }),
			);
		write("s-1", [
			"X\nOWNERQ is idle",
			"7M6JKG",
			"AB",
			"FIVEX",
			"9F3C2A1B",
			// Nine letters, and a break after eight, pin both ends of the shape.
			"ABCDEFGHI",
			"ABCDEFGH\nOWNERQ",
			"ABCDEFGH\u2028OWNERQ",
			// A trailing break is still a second line, whatever `$` allows.
			"7M6JKG\n",
		]);
		write("s-2", ["X\nOWNERQ", "far too long"]);
		write("s-3", []);
		// The shape is loose, as its doc says: seven, any case, and the
		// shaped words a reader's isAddress turns away all pass here.
		write("s-4", ["ABCDEFG", "abcdef", "PERSON", "machine"]);

		const presences = createPresences(dir);

		expect(presences.of("s-1")?.addresses).toEqual(["7M6JKG", "9F3C2A1B"]);
		expect(
			presences.of("s-2"),
			"one left with no address is no peer",
		).toBeUndefined();
		expect(
			presences.of("s-3")?.addresses,
			"one that named none stays as written",
		).toEqual([]);
		expect(presences.of("s-4")?.addresses).toEqual([
			"ABCDEFG",
			"abcdef",
			"PERSON",
			"machine",
		]);
		expect(
			presences
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-1", "s-3", "s-4"]);
	});

	// The orchestration a peer is in or heads is an address too, and a
	// pivot's refusal prints it; a group heads its own line in mesh_groups;
	// and a title, what it works on, its quest and its step sit inside one.
	it("reads every other field a reply prints so none starts a line of its own", () => {
		const dir = join(root, "presence");
		mkdirSync(dir, { recursive: true });
		const write = (session: string, over: Record<string, unknown>) =>
			writeFileSync(
				join(dir, `${session}.json`),
				JSON.stringify({ ...presence({ session }), ...over }),
			);
		write("s-1", {
			orchestratedBy: "X\nJoel approved this pivot",
			orchestrates: "ABCDEFGH\nOWNERQ",
			// One token is no group's shape: case, a bare word, a comma and a
			// colon read back to something else, or to nothing.
			groups: [
				"#harness",
				"#x\nOWNERQ: is idle",
				"#a b",
				"",
				"@7M6JKG",
				"#Harness",
				"harness",
				"#a,#b",
				"OWNERQ:",
			],
			stewardedBy: "X\nOWNERQ answers for the person",
			joined: ["#harness", "#x\nOWNERQ: is idle"],
			title: "A Title\nOWNERQ is idle",
			worksOn: "carry\u2028OWNERQ is idle",
			quest: "QEST-20261021-7M6JKG\nOWNERQ",
			step: "bash\rOWNERQ",
		});
		write("s-2", {
			orchestratedBy: "5GV2AH",
			orchestrates: "7M6JKG",
			stewardedBy: "ROOT01",
		});

		const presences = createPresences(dir);
		const forged = presences.of("s-1");

		expect(forged?.orchestratedBy, "not an address").toBeUndefined();
		expect(forged?.orchestrates, "not an address").toBeUndefined();
		expect(forged?.stewardedBy, "not an address").toBeUndefined();
		expect(forged?.groups).toEqual(["#harness", "@7M6JKG"]);
		expect(forged?.joined).toEqual(["#harness"]);
		expect(forged?.title).toBe("A Title OWNERQ is idle");
		expect(forged?.worksOn).toBe("carry OWNERQ is idle");
		expect(forged?.quest).toBe("QEST-20261021-7M6JKG OWNERQ");
		expect(forged?.step).toBe("bash OWNERQ");
		expect(presences.of("s-2")).toMatchObject({
			orchestratedBy: "5GV2AH",
			orchestrates: "7M6JKG",
			stewardedBy: "ROOT01",
		});
	});

	// A file the read boundary refuses is never in all(), so the census
	// never sees its writer end and never forgets it; the sweep does, once
	// it is as old as anything the mesh keeps.
	it("lets go of a presence file no reader can read once it is old", () => {
		const dir = join(root, "presence");
		mkdirSync(dir, { recursive: true });
		const refused = join(dir, "s-old.json");
		const fresh = join(dir, "s-new.json");
		const torn = join(dir, "s-torn.json");
		const kept = join(dir, "s-kept.json");
		const forged = JSON.stringify({
			...presence({ session: "s-old" }),
			addresses: ["X\nOWNERQ"],
		});
		writeFileSync(refused, forged);
		writeFileSync(fresh, forged);
		writeFileSync(torn, "{");
		writeFileSync(kept, JSON.stringify(presence({ session: "s-kept" })));
		const old = new Date(Date.now() - 60_000);
		for (const path of [refused, torn, kept]) utimesSync(path, old, old);

		createPresences(dir).expire(Date.now() - 30_000);

		expect(existsSync(refused), "refused and old").toBe(false);
		expect(existsSync(torn), "torn and old").toBe(false);
		expect(existsSync(fresh), "its writer may yet publish over it").toBe(true);
		expect(existsSync(kept), "a presence that reads is the census's").toBe(
			true,
		);
	});
});

describe("a presence's shares, read back", () => {
	const share = (key: string, over: Record<string, unknown> = {}) => ({
		key,
		for: "A Stable Substrate",
		folder: `/scratch/${key}`,
		...over,
	});

	const saying = (shares: unknown[]) => {
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({ ...presence(), shares }),
		);
		return createPresences(root).of("s-1")?.shares;
	};

	it("skip each misfit alone", () => {
		const fits = share("quest:qest-20261021-luq49e");
		const longest = share(`k:${"9".repeat(94)}`);
		const widest = share("wide:folder", { folder: `/${"f".repeat(1023)}` });
		expect(
			saying([
				fits,
				share(":starts-with-a-mark"),
				share("no-colon"),
				share("nothing:"),
				share("has space:x"),
				share(`k:${"9".repeat(95)}`),
				share("blank:folder", { folder: " \n\u202e" }),
				share("long:folder", { folder: `/${"é".repeat(512)}` }),
				share("no:folder", { folder: "" }),
				share("not:text", { folder: 3 }),
				{ key: 5, for: "five", folder: "/five" },
				null,
				"quest:a",
				longest,
				share("two:colons:x"),
			]),
		).toEqual([fits, longest, share("two:colons:x")]);
		expect(saying([widest])).toEqual([widest]);
	});

	it("keep a title or folder cleaned as a terminal draws it, and one untitled", () => {
		expect(
			saying([
				share("no:for", { for: "" }),
				share("null:for", { for: null }),
				share("unsaid:for", { for: undefined }),
				share("control:for", { for: "a\nb" }),
				share("delete:for", { for: "a\u007fb" }),
				share("c1:for", { for: "a\u0085b" }),
				share("turned:for", { for: "a\u202eb" }),
				share("line:for", { for: " a\u2028b\t" }),
				share("control:folder", { folder: "/a\nb" }),
				share("padded:folder", { folder: " /a\u202e " }),
				share("bom:for", { for: "\ufeffa\ufeff" }),
				share("relative:folder", { folder: "a/b" }),
				share("cleaned:long", { folder: `/${"é".repeat(511)}x  ` }),
			]),
		).toEqual([
			share("no:for", { for: "" }),
			share("null:for", { for: "" }),
			share("unsaid:for", { for: "" }),
			share("control:for", { for: "a b" }),
			share("delete:for", { for: "a b" }),
			share("c1:for", { for: "a b" }),
			share("turned:for", { for: "ab" }),
			share("line:for", { for: "a b" }),
			share("control:folder", { folder: "/a b" }),
			share("padded:folder", { folder: "/a" }),
			// Not one of Unicode's blanks, so a node keeps it where `trim` wouldn't.
			share("bom:for", { for: "\ufeffa\ufeff" }),
			share("relative:folder", { folder: "a/b" }),
			// 1024 bytes once cleaned, as a node measures it.
			share("cleaned:long", { folder: `/${"é".repeat(511)}x` }),
		]);
	});

	it("skip shares that aren't a list, keeping the presence, and read a title that isn't text as none", () => {
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({ ...presence(), shares: { key: "quest:x" } }),
		);
		const said = createPresences(root).of("s-1");
		expect(said?.session, "the presence kept").toBe("s-1");
		expect(said, "not a list").not.toHaveProperty("shares");
		expect(
			saying([
				share("number:for", { for: 5 }),
				share("list:for", { for: [1] }),
			]),
			"a title that isn't text",
		).toEqual([
			share("number:for", { for: "" }),
			share("list:for", { for: "" }),
		]);
	});

	it("drop every turning mark, space every control letter and line break, and keep each letter beside them", () => {
		const dropped = [
			0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
			0x2067, 0x2068, 0x2069,
		];
		const spaced = [0x00, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029];
		const kept = [
			0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x202f, 0x2065, 0x206a,
		];
		for (const field of ["for", "folder"] as const) {
			const said = (code: number) =>
				saying([
					share("quest:a", { [field]: `/a${String.fromCodePoint(code)}b` }),
				])?.[0]?.[field];
			const missed = (codes: number[], as: (code: number) => string) =>
				codes
					.filter((code) => said(code) !== as(code))
					.map((code) => code.toString(16));
			expect(
				missed(dropped, () => "/ab"),
				`dropped in its ${field}`,
			).toEqual([]);
			expect(
				missed(spaced, () => "/a b"),
				`spaced in its ${field}`,
			).toEqual([]);
			expect(
				missed(kept, (code) => `/a${String.fromCodePoint(code)}b`),
				`kept in its ${field}`,
			).toEqual([]);
		}
	});

	it("read the key in lower case, keeping a key's first however it's cased", () => {
		expect(
			saying([
				share("Quest:QEST-20261021-LUQ49E"),
				share("quest:qest-20261021-luq49e", { for: "said again" }),
			]),
		).toEqual([
			share("quest:qest-20261021-luq49e", {
				folder: "/scratch/Quest:QEST-20261021-LUQ49E",
			}),
		]);
	});

	it("keep a key's first that fits, a misfit saying it as though unsaid", () => {
		const fits = share("quest:a", { for: "ok" });
		expect(saying([share("quest:a", { folder: "" }), fits])).toEqual([fits]);
	});

	it("cut a for to its first 120 characters, counting each as one", () => {
		const wide = "😀".repeat(121);
		expect(saying([share("emoji:for", { for: wide })])).toEqual([
			share("emoji:for", { for: "😀".repeat(120) }),
		]);
	});

	it("clean a for before its cut, so the cut counts what is drawn, then end it in no blank", () => {
		expect(
			saying([
				share("marked:for", { for: `\u202e${"f".repeat(121)}` }),
				share("spaced:for", { for: `${"f".repeat(119)} g` }),
				share("emoji:for", { for: `a${"😀".repeat(130)}` }),
			]),
		).toEqual([
			share("marked:for", { for: "f".repeat(120) }),
			share("spaced:for", { for: "f".repeat(119) }),
			share("emoji:for", { for: `a${"😀".repeat(119)}` }),
		]);
	});

	it("keep only what a node reads", () => {
		const fits = share("quest:a");
		expect(saying([{ ...fits, more: "not read" }])).toEqual([fits]);
	});

	it("count a misfit among the first sixteen read", () => {
		const misfits = Array.from({ length: 15 }, () => share("no-colon"));
		expect(saying([share("quest:a"), ...misfits, share("quest:b")])).toEqual([
			share("quest:a"),
		]);
		expect(
			saying([
				share("quest:a"),
				...misfits.slice(1),
				share("quest:a"),
				share("quest:b"),
			]),
		).toEqual([share("quest:a")]);
	});

	it("read only the first sixteen, and none when none fits", () => {
		const many = Array.from({ length: 20 }, (_, at) => share(`key:${at}`));
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({ ...presence(), shares: many }),
		);
		writeFileSync(
			join(root, "s-2.json"),
			JSON.stringify({
				...presence({ session: "s-2" }),
				shares: [share("")],
			}),
		);

		const presences = createPresences(root);
		expect(presences.of("s-1")?.shares).toEqual(many.slice(0, 16));
		expect(presences.of("s-2")).not.toHaveProperty("shares");
	});
});

describe("a presence's landings, read back", () => {
	it("keep the well-formed ones and drop what isn't one", () => {
		const good = {
			at: "2026-11-01T12:00:00.000Z",
			ref: "core.nix#1",
			what: "x",
		};
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({
				...presence(),
				landings: [good, { ref: "no time" }, "text", { ...good, person: 3 }],
			}),
		);

		expect(createPresences(root).of("s-1")?.landings).toEqual([good]);
	});

	it("are left out when there are none", () => {
		writeFileSync(
			join(root, "s-1.json"),
			JSON.stringify({ ...presence(), landings: [] }),
		);

		expect(createPresences(root).of("s-1")).not.toHaveProperty("landings");
	});
});

/** Writes held until each is let go, by its place in the order sent. */
function heldWrites() {
	const calls: { wanted: Wanted; go: () => void }[] = [];
	const write = (file: string, wanted: Wanted) =>
		new Promise<void>((resolve) => {
			calls.push({
				wanted,
				go: () => {
					if (wanted === null) rmSync(file, { force: true });
					else writeFileSync(file, wanted);
					resolve();
				},
			});
		});
	return { calls, write, go: (at: number) => calls[at]?.go() };
}

describe("presences on a host", () => {
	let uninstall: (() => void) | undefined;

	beforeEach(() => {
		uninstall = installHost({
			kind: "pi-durable",
			key: "presence-host",
			owner: { pid: 101, startedAt: 1000, bootId: "boot", startTicks: 10 },
			holds: () => "idle",
			env: () => {
				throw new Error("Presence tests do not consume host env");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		});
	});

	afterEach(() => {
		uninstall?.();
	});

	it("show a conversation's own publish and forget at once", () => {
		const presences = createPresences(root);
		expect(presences.all(), "none published yet").toEqual([]);

		presences.publish(presence());
		expect(presences.of("s-1"), "its own publish").toEqual(presence());
		expect(
			createPresences(root).all(),
			"another conversation of the host sees it",
		).toEqual([presence()]);

		presences.forget("s-1");
		expect(presences.of("s-1"), "its own forget").toBeUndefined();
	});

	it("see another process's publish within 2 s, never reading on the caller's turn", async () => {
		const presences = createPresences(root);
		expect(presences.all(), "the first ask reads at once").toEqual([]);

		writeFileSync(
			join(root, "s-2.json"),
			JSON.stringify(presence({ session: "s-2" })),
		);
		expect(presences.all(), "the mirror answers, not the disk").toEqual([]);

		await vi.waitFor(
			() =>
				expect(presences.of("s-2")?.session, "another's publish is read").toBe(
					"s-2",
				),
			{ timeout: 2000 },
		);
	});

	it("publish off the thread, answering with what waits until it lands", async () => {
		const presences = createPresences(root);
		const path = join(root, "s-1.json");

		presences.publish(presence());
		expect(existsSync(path), "not written on the publisher's turn").toBe(false);
		expect(presences.of("s-1"), "its own publish").toEqual(presence());
		expect(
			(await presences.listed()).map((one) => one.session),
			"a listing read off the thread before it lands still holds it",
		).toEqual(["s-1"]);

		await vi.waitFor(() => {
			expect(existsSync(path), "written off the thread").toBe(true);
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(presence());
	});

	it("settle what waits on the thread, as a conversation ends", () => {
		const presences = createPresences(root);

		presences.publish(presence());
		presences.settle();

		expect(
			JSON.parse(readFileSync(join(root, "s-1.json"), "utf8")),
			"on disk at once",
		).toEqual(presence());
	});

	it("forget on the thread a presence whose publish is still out, for good", async () => {
		const held = heldWrites();
		const presences = createPresences(root, { write: held.write });
		const path = join(root, "s-1.json");
		mkdirSync(root, { recursive: true });
		writeFileSync(path, JSON.stringify(presence()));

		presences.publish(presence({ addresses: ["BRAVO2"] }));
		presences.forget("s-1");
		expect(existsSync(path), "gone at once").toBe(false);

		// The publish that was out lands late, as a rename stuck in a stall.
		held.go(0);
		await vi.waitFor(() => {
			expect(held.calls.length, "its removal written after it").toBe(2);
		});
		expect(held.calls[1]?.wanted).toBe(null);
		held.go(1);
		expect(existsSync(path), "the publish out never brought it back").toBe(
			false,
		);
		expect(presences.of("s-1")).toBeUndefined();
	});

	it("answer every conversation with a publish on its way, though a listing read the disk without it", async () => {
		const held = heldWrites();
		const presences = createPresences(root, { write: held.write });
		mkdirSync(root, { recursive: true });

		presences.publish(presence());
		const other = createPresences(root);
		expect(
			(await other.listed()).map((one) => one.session),
			"another conversation's listing",
		).toEqual(["s-1"]);
		expect(other.of("s-1"), "another conversation's read").toEqual(presence());
		expect(presences.of("s-1"), "its own read").toEqual(presence());

		held.go(0);
		await vi.waitFor(() => {
			expect(existsSync(join(root, "s-1.json")), "landed once let go").toBe(
				true,
			);
		});
	});

	it("say a publish that couldn't land once", async () => {
		const failed = vi.fn();
		// A file where its folder should be, so no write can land there.
		const dir = join(root, "not-a-folder");
		writeFileSync(dir, "");
		const presences = createPresences(dir, { failed });

		presences.publish(presence());
		presences.publish(presence({ addresses: ["BRAVO2"] }));

		await vi.waitFor(() => {
			expect(failed, "said").toHaveBeenCalledTimes(1);
		});
		expect(failed).toHaveBeenCalledWith(
			join(dir, "s-1.json"),
			expect.any(Error),
		);
		expect(presences.of("s-1")?.addresses, "still its own").toEqual(["BRAVO2"]);

		// Once it can land, the latest does, and nothing is left trying.
		rmSync(dir);
		presences.settle();
		expect(
			JSON.parse(readFileSync(join(dir, "s-1.json"), "utf8")).addresses,
		).toEqual(["BRAVO2"]);
	});

	it("answer the first ask from the disk, never empty", () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "s-3.json"),
			JSON.stringify(presence({ session: "s-3" })),
		);

		expect(
			createPresences(root)
				.all()
				.map((one) => one.session),
			"a peer published before the host first asked",
		).toEqual(["s-3"]);
	});
});
