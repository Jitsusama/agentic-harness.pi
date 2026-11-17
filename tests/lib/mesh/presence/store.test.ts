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
		presences.publish(presence({ session: "s-2", addresses: ["B"] }));
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
		presences.publish(presence({ session: "s-2", addresses: ["B"] }));
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
		const presences = createPresences(root);
		const path = join(root, "s-1.json");

		presences.publish(presence());
		presences.forget("s-1");
		expect(existsSync(path), "gone at once").toBe(false);
		presences.publish(presence({ session: "s-2" }));
		await vi.waitFor(() => {
			expect(existsSync(join(root, "s-2.json")), "a later publish landed").toBe(
				true,
			);
		});
		// Every write sent before s-2's has had as long to land as it had.
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(existsSync(path), "the publish out never brought it back").toBe(
			false,
		);
	});

	it("say a publish that couldn't land once", async () => {
		const failed = vi.fn();
		// A file where its folder should be, so no write can land there.
		const dir = join(root, "not-a-folder");
		writeFileSync(dir, "");
		const presences = createPresences(dir, { failed });

		presences.publish(presence());
		presences.publish(presence({ addresses: ["B"] }));

		await vi.waitFor(() => {
			expect(failed, "said").toHaveBeenCalledTimes(1);
		});
		expect(failed).toHaveBeenCalledWith(
			join(dir, "s-1.json"),
			expect.any(Error),
		);
		expect(presences.of("s-1")?.addresses, "still its own").toEqual(["B"]);
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
