// Where a Mac's runtime folder is, and where its node's socket is found while the folder moves.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AGENTS_RUNTIME_ENV,
	formerRuntimeDir,
	runtimeDir,
} from "../../../lib/internal/paths.ts";
import { nodeSocket, nodeSockets } from "../../../lib/mesh/node.ts";

/** The folders getconf names on this pretend Mac, set once the test's folder exists. */
const folders = vi.hoisted(() => ({ cache: "", temporary: "" }));

vi.mock("node:os", async (actual) => ({
	...(await actual<typeof import("node:os")>()),
	platform: () => "darwin",
}));

vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof import("node:child_process")>();
	return {
		...real,
		execFileSync: (...args: Parameters<typeof real.execFileSync>) => {
			const [file, argv] = args;
			if (file !== "getconf") return real.execFileSync(...args);
			return argv?.[0] === "DARWIN_USER_CACHE_DIR"
				? `${folders.cache}\n`
				: `${folders.temporary}\n`;
		},
	};
});

let root = "";

beforeAll(() => {
	// tmpdir is the real one: only platform is pretended.
	root = mkdtempSync(join(tmpdir(), "mac-folder-"));
	folders.cache = join(root, "C");
	folders.temporary = join(root, "T");
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

	it("was nowhere else when XDG_RUNTIME_DIR names it", () => {
		expect(formerRuntimeDir(mac({ XDG_RUNTIME_DIR: "/xdg" }))).toBeUndefined();
	});
});

describe("a Mac's node socket while the runtime folder moves", () => {
	it("is in the cache folder before any node serves, so a node started there is found", () => {
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

	it("lists the other realms beside the one found in the temporary folder", () => {
		const own = serving(folders.temporary, "kept");
		const other = serving(folders.temporary, "lent");

		expect(nodeSockets(mac({ MYCELIUM_REALM: "kept" }))).toEqual(
			expect.arrayContaining([own, other]),
		);
		expect(nodeSockets(mac({ MYCELIUM_REALM: "kept" }))[0]).toBe(own);
	});
});
