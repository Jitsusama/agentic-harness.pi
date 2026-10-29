/**
 * Which realm a session lives in, and where its realm keeps its own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	dataDir,
	everyRealmsDir,
	stateDir,
} from "../../../lib/internal/paths.ts";
import { restoreFilePath } from "../../../lib/internal/quest/restore-file.ts";
import {
	meshRefusal,
	realmSegments,
	sessionRealm,
} from "../../../lib/internal/realm.ts";
import { nodeSocket } from "../../../lib/mesh/node.ts";

describe("a session's realm", () => {
	it("is home on a machine in one realm, keeping the paths it always had", () => {
		expect(sessionRealm({ MYCELIUM_REALM: "work" })).toEqual({ kind: "home" });
		expect(sessionRealm({})).toEqual({ kind: "home" });
		expect(realmSegments({ kind: "home" })).toEqual([]);
	});

	it("is home when it is the machine's home realm, and its own when it isn't", () => {
		const both = { PI_HOME_REALM: "work" };
		expect(sessionRealm({ ...both, MYCELIUM_REALM: "work" })).toEqual({
			kind: "home",
		});
		const personal = sessionRealm({ ...both, MYCELIUM_REALM: "personal" });
		expect(personal).toEqual({ kind: "other", name: "personal" });
		expect(realmSegments(personal)).toEqual(["realms", "personal"]);
	});

	it("is home on a machine whose only realm is personal", () => {
		expect(
			sessionRealm({ MYCELIUM_REALM: "personal", PI_HOME_REALM: "personal" }),
		).toEqual({ kind: "home" });
	});

	it("keeps it off any mesh when its name can't be a folder", () => {
		const odd = sessionRealm({
			MYCELIUM_REALM: "../work",
			PI_HOME_REALM: "work",
		});
		expect(odd.kind).toBe("unnamed");
		expect(realmSegments(odd)).toEqual([]);
		expect(meshRefusal(odd)).toMatch(/isn't a realm name/);
		expect(meshRefusal({ kind: "home" })).toBeUndefined();
	});
});

describe("where a realm keeps its own", () => {
	let root: string;
	const saved: Record<string, string | undefined> = {};
	const vars = [
		"XDG_STATE_HOME",
		"XDG_DATA_HOME",
		"XDG_RUNTIME_DIR",
		"MYCELIUM_REALM",
		"PI_HOME_REALM",
	];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "realm-"));
		for (const name of vars) saved[name] = process.env[name];
		process.env.XDG_STATE_HOME = join(root, "state");
		process.env.XDG_DATA_HOME = join(root, "data");
		process.env.PI_HOME_REALM = "work";
	});
	afterEach(() => {
		for (const name of vars) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		rmSync(root, { recursive: true, force: true });
	});
	const harness = (kind: "state" | "data", ...rest: string[]) =>
		join(root, kind, "pi", "agentic-harness.pi", ...rest);

	it("puts a personal session's quests, mesh and inboxes under its realm, and leaves the machine's alone", () => {
		process.env.MYCELIUM_REALM = "personal";

		expect(dataDir("quest-workflow")).toBe(
			harness("data", "realms", "personal", "quest-workflow"),
		);
		expect(stateDir("mesh-workflow")).toBe(
			harness("state", "realms", "personal", "mesh-workflow"),
		);
		expect(stateDir("steer")).toBe(
			harness("state", "realms", "personal", "steer"),
		);
		expect(stateDir("priority-workflow")).toBe(
			harness("state", "priority-workflow"),
		);
		expect(stateDir("work")).toBe(harness("state", "work"));
		expect(restoreFilePath(join(root, "state"))).toBe(
			harness("state", "realms", "personal", "restore.json"),
		);
	});

	it("leaves a work session's paths where they always were", () => {
		process.env.MYCELIUM_REALM = "work";

		expect(dataDir("quest-workflow")).toBe(harness("data", "quest-workflow"));
		expect(stateDir("steer")).toBe(harness("state", "steer"));
		expect(restoreFilePath(join(root, "state"))).toBe(
			join(root, "state", "pi", "restore.json"),
		);
	});

	it("lists every realm's own folder for what the machine holds once, home's first", () => {
		mkdirSync(harness("data", "realms", "personal", "quest-workflow"), {
			recursive: true,
		});
		process.env.MYCELIUM_REALM = "personal";

		expect(everyRealmsDir("data", "quest-workflow")).toEqual([
			harness("data", "quest-workflow"),
			harness("data", "realms", "personal", "quest-workflow"),
		]);
	});

	it("asks the session's own realm's node, not the one the machine first kept", () => {
		const kept = join(root, "state", "mycelium");
		mkdirSync(kept, { recursive: true });
		writeFileSync(join(kept, "realm"), "work\n");
		const env = {
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "run"),
			MYCELIUM_REALM: "personal",
		};
		expect(nodeSocket(env)).toBe(
			join(root, "run", "mycelium", "personal.sock"),
		);
	});
});
