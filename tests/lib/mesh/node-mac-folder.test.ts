// Where a Mac's runtime folder is, and where its node's socket is found while the folder moves.
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Paths = typeof import("../../../lib/internal/paths.ts");
type Node = typeof import("../../../lib/mesh/node.ts");
type Address = typeof import("../../../host/service/address.ts");

/** The folders getconf names on this pretend Mac, set once the test's folder exists. */
const folders = vi.hoisted(() => ({
	cache: "",
	temporary: "",
	failing: 0,
	// The time limit each ask of getconf was given, in ms.
	limits: [] as unknown[],
}));

vi.mock("node:os", async (actual) => ({
	...(await actual<typeof import("node:os")>()),
	platform: () => "darwin",
}));

vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof import("node:child_process")>();
	return {
		...real,
		execFileSync: (...args: Parameters<typeof real.execFileSync>) => {
			const [file, argv, options] = args;
			if (file !== "/usr/bin/getconf") return real.execFileSync(...args);
			folders.limits.push(
				options && "timeout" in options ? options.timeout : undefined,
			);
			if (folders.failing > 0) {
				folders.failing -= 1;
				throw new Error("spawnSync /usr/bin/getconf EAGAIN");
			}
			if (argv?.[0] === "DARWIN_USER_CACHE_DIR") return `${folders.cache}\n`;
			if (argv?.[0] === "DARWIN_USER_TEMP_DIR") return `${folders.temporary}\n`;
			throw new Error(`getconf: no such name: ${String(argv?.[0])}`);
		},
	};
});

let root = "";
let AGENTS_RUNTIME_ENV: Paths["AGENTS_RUNTIME_ENV"];
let formerRuntimeDir: Paths["formerRuntimeDir"];
let runtimeDir: Paths["runtimeDir"];
let nodeSocket: Node["nodeSocket"];
let nodeSockets: Node["nodeSockets"];
let childFolder: Address["childFolder"];
let hostSocketPath: Address["hostSocketPath"];

beforeAll(async () => {
	// tmpdir is the real one: only platform is pretended.
	root = mkdtempSync(join(tmpdir(), "mac-folder-"));
	folders.cache = join(root, "C");
	folders.temporary = join(root, "T");
	// The suite's setup loads the paths module before these mocks, and it
	// keeps what getconf said, so the modules are loaded afresh here.
	vi.resetModules();
	({ AGENTS_RUNTIME_ENV, formerRuntimeDir, runtimeDir } = await import(
		"../../../lib/internal/paths.ts"
	));
	({ nodeSocket, nodeSockets } = await import("../../../lib/mesh/node.ts"));
	({ childFolder, hostSocketPath } = await import(
		"../../../host/service/address.ts"
	));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A Mac session's environment, which names no XDG runtime folder. */
function mac(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		XDG_STATE_HOME: join(root, "state"),
		MYCELIUM_REALM: "work",
		...extra,
	};
}

/** Pretend a node serves `realm` in `folder`'s mycelium folder. */
function serving(folder: string, realm: string): string {
	mkdirSync(join(folder, "mycelium"), { recursive: true });
	const socket = join(folder, "mycelium", `${realm}.sock`);
	writeFileSync(socket, "");
	return socket;
}

/** Pretend a node that served `realm` in `folder` ended a day ago, leaving its socket. */
function leftBehind(folder: string, realm: string): string {
	const socket = serving(folder, realm);
	const dayAgo = new Date(Date.now() - 86_400_000);
	utimesSync(socket, dayAgo, dayAgo);
	return socket;
}

/** Pretend nodes serve `realm` in both folders, their sockets bound at one moment; answers the cache folder's. */
function boundTogether(realm: string): string {
	const cached = serving(folders.cache, realm);
	const temporary = serving(folders.temporary, realm);
	const at = new Date(Date.now() - 60_000);
	utimesSync(cached, at, at);
	utimesSync(temporary, at, at);
	return cached;
}

describe("a Mac's runtime folder", () => {
	it("is the folder AGENTS_RUNTIME_DIR names, before XDG_RUNTIME_DIR and the cache folder", () => {
		expect(
			runtimeDir(
				mac({ [AGENTS_RUNTIME_ENV]: "/agents", XDG_RUNTIME_DIR: "/xdg" }),
			),
		).toBe("/agents");
	});

	it("is the account's cache folder when nothing names one, not its temporary folder", () => {
		expect(runtimeDir(mac())).toBe(folders.cache);
	});

	it("was the account's temporary folder, for a client to try for one release", () => {
		expect(formerRuntimeDir(mac())).toBe(folders.temporary);
	});

	it("was the temporary folder too when AGENTS_RUNTIME_DIR names the cache folder, as a Mac's host start does", () => {
		expect(formerRuntimeDir(mac({ [AGENTS_RUNTIME_ENV]: folders.cache }))).toBe(
			folders.temporary,
		);
	});

	it("was nowhere else when XDG_RUNTIME_DIR names it", () => {
		expect(formerRuntimeDir(mac({ XDG_RUNTIME_DIR: "/xdg" }))).toBeUndefined();
	});

	it("was nowhere else when AGENTS_RUNTIME_DIR names a folder of its own, as a sandbox does", () => {
		expect(
			formerRuntimeDir(mac({ [AGENTS_RUNTIME_ENV]: join(root, "box") })),
		).toBeUndefined();
	});

	it("is asked of getconf again once a while has passed since it couldn't answer", async () => {
		vi.resetModules();
		const fresh = await import("../../../lib/internal/paths.ts");
		folders.failing = 1;
		folders.limits = [];
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			expect(fresh.runtimeDir(mac())).toBeUndefined();
			vi.setSystemTime(Date.now() + fresh.GETCONF_AGAIN_MS - 1);
			expect(fresh.runtimeDir(mac()), "too soon to ask again").toBeUndefined();
			vi.setSystemTime(Date.now() + 1);
			expect(fresh.runtimeDir(mac())).toBe(folders.cache);
		} finally {
			vi.useRealTimers();
		}
		expect(folders.limits, "each ask is held to its time limit").toEqual([
			2000, 2000,
		]);
	});

	it("is asked of getconf again when the clock was set back since it couldn't answer", async () => {
		// Dated by a clock later set back, a miss would otherwise seem not
		// yet a while old for as long as the clock was moved.
		vi.resetModules();
		const fresh = await import("../../../lib/internal/paths.ts");
		folders.failing = 1;
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			expect(fresh.runtimeDir(mac())).toBeUndefined();
			vi.setSystemTime(Date.now() - 3_600_000);
			expect(fresh.runtimeDir(mac())).toBe(folders.cache);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a Mac's node socket while the runtime folder moves", () => {
	it("is in the cache folder before any node serves", () => {
		expect(nodeSocket(mac({ MYCELIUM_REALM: "nowhere" }))).toBe(
			join(folders.cache, "mycelium", "nowhere.sock"),
		);
	});

	it("is the temporary folder's while only a node on the old code serves there", () => {
		const kept = serving(folders.temporary, "former");

		expect(nodeSocket(mac({ MYCELIUM_REALM: "former" }))).toBe(kept);
	});

	it("is the cache folder's once a node serves there, though the old one's is left", () => {
		serving(folders.temporary, "both");
		const moved = serving(folders.cache, "both");

		expect(nodeSocket(mac({ MYCELIUM_REALM: "both" }))).toBe(moved);
	});

	it("is the cache folder's when both were bound at one moment", () => {
		const cached = boundTogether("tied");

		expect(nodeSocket(mac({ MYCELIUM_REALM: "tied" }))).toBe(cached);
	});

	it("is the temporary folder's when a node bound there after one left the cache folder's behind", () => {
		// The cache folder outlasts a reboot, so a node that ended there
		// leaves a socket nothing listens on.
		leftBehind(folders.cache, "stale");
		const live = serving(folders.temporary, "stale");

		expect(nodeSocket(mac({ MYCELIUM_REALM: "stale" }))).toBe(live);
	});

	it("lists another realm from the socket bound later when both folders hold it", () => {
		serving(folders.cache, "home");
		leftBehind(folders.cache, "aside");
		const live = serving(folders.temporary, "aside");

		const listed = nodeSockets(mac({ MYCELIUM_REALM: "home" }));

		expect(listed.filter((socket) => socket.endsWith("aside.sock"))).toEqual([
			live,
		]);
	});

	it("lists the other realms beside the one found in the temporary folder", () => {
		const own = serving(folders.temporary, "kept");
		const other = serving(folders.temporary, "lent");

		expect(nodeSockets(mac({ MYCELIUM_REALM: "kept" }))).toEqual(
			expect.arrayContaining([own, other]),
		);
		expect(nodeSockets(mac({ MYCELIUM_REALM: "kept" }))[0]).toBe(own);
	});

	it("lists a realm still in the temporary folder beside the own one moved to the cache folder", () => {
		const own = serving(folders.cache, "moved");
		const left = serving(folders.temporary, "behind");

		const listed = nodeSockets(mac({ MYCELIUM_REALM: "moved" }));

		expect(listed).toEqual(expect.arrayContaining([own, left]));
		expect(listed.filter((socket) => socket.endsWith("moved.sock"))).toEqual([
			own,
		]);
	});

	it("lists another realm from the cache folder when both were bound at one moment", () => {
		serving(folders.cache, "ours");
		const cached = boundTogether("evenly");

		const listed = nodeSockets(mac({ MYCELIUM_REALM: "ours" }));

		expect(listed.filter((socket) => socket.endsWith("evenly.sock"))).toEqual([
			cached,
		]);
	});

	it("lists a realm once, from the cache folder, when both folders hold it", () => {
		serving(folders.cache, "mine");
		serving(folders.temporary, "twice");
		const moved = serving(folders.cache, "twice");

		const listed = nodeSockets(mac({ MYCELIUM_REALM: "mine" }));

		expect(listed.filter((socket) => socket.endsWith("twice.sock"))).toEqual([
			moved,
		]);
	});
});

describe("a host given only AGENTS_RUNTIME_DIR", () => {
	it("listens, and keeps its children, in the folder it names", () => {
		// Short and apart from `root`, so the socket fits a Unix address
		// under a Mac's deep temporary folder too.
		const named = mkdtempSync(join(tmpdir(), "r"));
		vi.stubEnv(AGENTS_RUNTIME_ENV, named);
		// As core's Mac start leaves it, with no XDG runtime folder.
		vi.stubEnv("XDG_RUNTIME_DIR", undefined);
		try {
			expect(hostSocketPath("work", "attended")).toBe(
				join(named, "pi-host", "work-attended.sock"),
			);
			expect(childFolder("work-attended")).toBe(
				join(named, "pi-host", "work-attended.d"),
			);
		} finally {
			vi.unstubAllEnvs();
			rmSync(named, { recursive: true, force: true });
		}
	});
});
