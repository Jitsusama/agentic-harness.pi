/** The host program judges what it was given before it holds, pins or listens anything. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	conversationBase,
	HostMisconfigured,
	hostInstall,
	hostPackageDir,
	startHostProgram,
} from "../../../host/service/program.ts";

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-program-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("conversationBase", () => {
	it("keeps the realm's environment but not systemd's hand-over or the host's pi", () => {
		const host = {
			HOME: "/home/someone",
			MYCELIUM_REALM: "work",
			SHOPIFY_PROXY_ORIGIN: "https://proxy.example",
			NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
			WATCHDOG_USEC: "1000",
			LISTEN_FDS: "1",
			PI_PACKAGE_DIR: "/nix/store/host-pi",
		};
		expect(conversationBase(host)).toEqual({
			HOME: "/home/someone",
			MYCELIUM_REALM: "work",
			SHOPIFY_PROXY_ORIGIN: "https://proxy.example",
		});
		expect(host.NOTIFY_SOCKET, "the host keeps its own").toBe(
			"/run/user/1000/systemd/notify",
		);
	});
});

describe("hostPackageDir and hostInstall", () => {
	it("takes only an absolute PI_PACKAGE_DIR", () => {
		expect(hostPackageDir({ PI_PACKAGE_DIR: "/pi" })).toBe("/pi");
		for (const env of [{}, { PI_PACKAGE_DIR: "" }, { PI_PACKAGE_DIR: "pi" }])
			expect(() => hostPackageDir(env)).toThrow(
				"PI_PACKAGE_DIR must name the host's pi install",
			);
	});

	it("runs subagents on the host's node and the host's pi", () => {
		expect(hostInstall("/pi", "/bin/node")).toEqual({
			node: "/bin/node",
			entry: "/pi/dist/bundle/cli.js",
			packageDir: "/pi",
		});
	});
});

describe("startHostProgram", () => {
	const good = () => ({
		MYCELIUM_REALM: "work",
		XDG_RUNTIME_DIR: join(dir, "run"),
		PI_PACKAGE_DIR: join(dir, "pi"),
	});

	it("refuses a bad kind, realm or pi install as misconfigured, before anything listens or is pinned", async () => {
		const pinned = Reflect.get(globalThis, STARTUP_INSTALL_KEY);
		const cases: [string[], NodeJS.ProcessEnv, string][] = [
			[["sideways"], good(), "Usage: pi-host attended|background"],
			[
				["attended"],
				{ ...good(), MYCELIUM_REALM: undefined },
				"Host needs MYCELIUM_REALM or PI_HOME_REALM",
			],
			[
				["attended"],
				{ ...good(), PI_PACKAGE_DIR: "relative" },
				"PI_PACKAGE_DIR must name",
			],
			[["attended"], good(), "is incomplete"],
		];
		for (const [argv, env, said] of cases) {
			const started = startHostProgram({
				argv,
				env,
				execPath: process.execPath,
				report: () => {},
			});
			await expect(started).rejects.toBeInstanceOf(HostMisconfigured);
			await expect(started).rejects.toThrow(said);
		}
		expect(await readdir(dir), "nothing made a socket folder").toEqual([]);
		expect(
			Reflect.get(globalThis, STARTUP_INSTALL_KEY),
			"a refused host pins no install",
		).toBe(pinned);
	});
});
