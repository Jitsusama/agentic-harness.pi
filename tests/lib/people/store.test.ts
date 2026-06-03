import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearHandleTypes,
	registerBuiltinHandleTypes,
} from "../../../lib/people/index";
import { createPeopleStore, type PeopleStore } from "../../../lib/people/store";

let dir: string;
let store: PeopleStore;

beforeEach(() => {
	clearHandleTypes();
	registerBuiltinHandleTypes();
	dir = mkdtempSync(join(tmpdir(), "people-store-"));
	store = createPeopleStore({ dir });
});

afterEach(() => {
	clearHandleTypes();
	rmSync(dir, { recursive: true, force: true });
});

describe("addIdentity", () => {
	it("creates a new identity with an explicit id", () => {
		const identity = store.addIdentity({
			id: "joel-gerber",
			names: ["Joel Gerber"],
			handles: ["slack:joel.gerber", "github:Jitsusama"],
		});
		expect(identity.id).toBe("joel-gerber");
		expect(identity.handles).toEqual([
			{ type: "slack", value: "joel.gerber" },
			{ type: "github", value: "Jitsusama" },
		]);
		expect(store.getIdentity("joel-gerber")).toEqual(identity);
	});

	it("derives an id from the first name when none is given", () => {
		const identity = store.addIdentity({ names: ["Joel Gerber"] });
		expect(identity.id).toBe("joel-gerber");
	});

	it("throws when no id can be derived and none is provided", () => {
		expect(() => store.addIdentity({})).toThrow(/needs either/);
	});

	it("rejects a duplicate derived id", () => {
		store.addIdentity({ names: ["Joel Gerber"] });
		expect(() => store.addIdentity({ names: ["Joel Gerber"] })).toThrow(
			/already exists/,
		);
	});

	it("allows overwrite when an explicit id is provided", () => {
		store.addIdentity({ id: "joel", names: ["Old Name"] });
		const updated = store.addIdentity({
			id: "joel",
			names: ["Joel Gerber"],
		});
		expect(updated.names).toEqual(["Joel Gerber"]);
	});

	it("rejects an unparseable handle", () => {
		expect(() =>
			store.addIdentity({
				id: "x",
				names: ["X"],
				handles: ["slack:"],
			}),
		).toThrow(/Cannot parse handle/);
	});

	it("rejects a handle whose type is not registered", () => {
		expect(() =>
			store.addIdentity({
				id: "x",
				names: ["X"],
				handles: ["graphite:something"],
			}),
		).toThrow(/Cannot parse handle/);
	});

	it("writes an actual markdown file to disk", () => {
		store.addIdentity({
			id: "joel-gerber",
			names: ["Joel Gerber"],
			handles: ["slack:joel.gerber"],
		});
		const file = readFileSync(join(dir, "joel-gerber.md"), "utf8");
		expect(file).toContain("id: joel-gerber");
		expect(file).toContain("slack:joel.gerber");
		expect(file).toContain("# Joel Gerber");
	});
});

describe("addHandle / addName / removeHandle / removeName", () => {
	beforeEach(() => {
		store.addIdentity({
			id: "joel-gerber",
			names: ["Joel Gerber"],
			handles: ["slack:joel.gerber"],
		});
	});

	it("addHandle adds a new handle and persists", () => {
		const identity = store.addHandle("joel-gerber", "github:Jitsusama");
		expect(identity.handles).toContainEqual({
			type: "github",
			value: "Jitsusama",
		});
		const reloaded = createPeopleStore({ dir });
		expect(reloaded.getIdentity("joel-gerber")?.handles).toContainEqual({
			type: "github",
			value: "Jitsusama",
		});
	});

	it("addHandle is idempotent on a duplicate", () => {
		const identity = store.addHandle("joel-gerber", "slack:joel.gerber");
		const handles = identity.handles.filter((h) => h.type === "slack");
		expect(handles).toHaveLength(1);
	});

	it("addName adds a nickname", () => {
		const identity = store.addName("joel-gerber", "Joel");
		expect(identity.names).toEqual(["Joel Gerber", "Joel"]);
	});

	it("removeHandle drops the handle", () => {
		store.addHandle("joel-gerber", "github:Jitsusama");
		const identity = store.removeHandle("joel-gerber", "github:Jitsusama");
		expect(identity.handles).not.toContainEqual({
			type: "github",
			value: "Jitsusama",
		});
	});

	it("removeName drops the nickname but keeps canonical", () => {
		store.addName("joel-gerber", "Joel");
		const identity = store.removeName("joel-gerber", "Joel");
		expect(identity.names).toEqual(["Joel Gerber"]);
	});
});

describe("metadata", () => {
	beforeEach(() => {
		store.addIdentity({
			id: "joel-gerber",
			names: ["Joel Gerber"],
		});
	});

	it("setMetadata and getMetadata round-trip", () => {
		store.setMetadata("joel-gerber", "quest-workflow", {
			lastSeenAs: "originator",
			touched: "2026-06-03",
		});
		expect(store.getMetadata("joel-gerber", "quest-workflow")).toEqual({
			lastSeenAs: "originator",
			touched: "2026-06-03",
		});
	});

	it("metadata is namespaced per extension", () => {
		store.setMetadata("joel-gerber", "quest-workflow", { a: 1 });
		store.setMetadata("joel-gerber", "mastery", { manager: "Mark" });
		expect(store.getMetadata("joel-gerber", "quest-workflow")).toEqual({
			a: 1,
		});
		expect(store.getMetadata("joel-gerber", "mastery")).toEqual({
			manager: "Mark",
		});
	});

	it("metadata persists across store instances", () => {
		store.setMetadata("joel-gerber", "quest-workflow", { a: 1 });
		const reloaded = createPeopleStore({ dir });
		expect(reloaded.getMetadata("joel-gerber", "quest-workflow")).toEqual({
			a: 1,
		});
	});

	it("getMetadata returns undefined for an absent namespace", () => {
		expect(store.getMetadata("joel-gerber", "no-such")).toBeUndefined();
	});

	it("getMetadata returns undefined for an absent identity", () => {
		expect(store.getMetadata("ghost", "anything")).toBeUndefined();
	});

	it("setMetadata throws for an absent identity", () => {
		expect(() => store.setMetadata("ghost", "ns", {})).toThrow(/No identity/);
	});
});

describe("lookup", () => {
	beforeEach(() => {
		store.addIdentity({
			id: "joel-gerber",
			names: ["Joel Gerber", "Joel"],
			handles: ["slack:joel.gerber", "github:Jitsusama"],
		});
		store.addIdentity({
			id: "xiao-li",
			names: ["Xiao Li"],
			handles: ["slack:xiao.li"],
		});
	});

	it("getIdentity returns by exact id", () => {
		expect(store.getIdentity("joel-gerber")?.names[0]).toBe("Joel Gerber");
	});

	it("findIdentity returns the highest-scoring identity", () => {
		expect(store.findIdentity("Joel")?.id).toBe("joel-gerber");
		expect(store.findIdentity("xiao")?.id).toBe("xiao-li");
	});

	it("findIdentity matches handle values", () => {
		expect(store.findIdentity("@joel.gerber")?.id).toBe("joel-gerber");
		expect(store.findIdentity("Jitsusama")?.id).toBe("joel-gerber");
	});

	it("findIdentity returns undefined when nothing matches", () => {
		expect(store.findIdentity("nobody")).toBeUndefined();
	});

	it("findIdentities returns all matches in score order", () => {
		store.addIdentity({
			id: "joel-other",
			names: ["Joel Other"],
		});
		const matches = store.findIdentities("Joel");
		expect(matches.map((i) => i.id)).toEqual(["joel-gerber", "joel-other"]);
	});

	it("listIdentities returns every identity", () => {
		const all = store.listIdentities();
		expect(all.map((i) => i.id).sort()).toEqual(["joel-gerber", "xiao-li"]);
	});
});

describe("deleteIdentity", () => {
	it("removes the identity from disk and memory", () => {
		store.addIdentity({ id: "joel", names: ["Joel"] });
		store.deleteIdentity("joel");
		expect(store.getIdentity("joel")).toBeUndefined();
		const reloaded = createPeopleStore({ dir });
		expect(reloaded.getIdentity("joel")).toBeUndefined();
	});

	it("is idempotent on a missing id", () => {
		expect(() => store.deleteIdentity("ghost")).not.toThrow();
	});

	it("refuses delete for ids that fail filename validation", () => {
		expect(() => store.deleteIdentity("../oops")).toThrow(/Invalid/);
		expect(() => store.deleteIdentity("UPPERCASE")).toThrow(/Invalid/);
	});
});

describe("round-trip preserves prose between known metadata blocks", () => {
	it("keeps prose around namespace JSON blocks across a metadata write", async () => {
		const writeFileSync = (await import("node:fs")).writeFileSync;
		writeFileSync(
			join(dir, "jane.md"),
			[
				"---",
				"id: jane",
				"names:",
				"  - Jane Doe",
				"handles: []",
				"---",
				"",
				"# Jane Doe",
				"",
				"Jane is on the privacy engineering team.",
				"",
				"## mastery",
				"",
				"Lead reviewer: Mark.",
				"",
				"```json",
				'{ "team": "Privacy Engineering" }',
				"```",
				"",
				"Notes after the block.",
				"",
			].join("\n"),
		);
		store.reload();
		store.setMetadata("jane", "mastery", { team: "Security Engineering" });
		const text = readFileSync(join(dir, "jane.md"), "utf8");
		expect(text).toContain("Jane is on the privacy engineering team.");
		expect(text).toContain("Notes after the block.");
		expect(text).toContain('"team": "Security Engineering"');
		expect(text).not.toContain('"team": "Privacy Engineering"');
	});
});

describe("reload", () => {
	it("picks up a file written outside the store after a prior load", async () => {
		const writeFileSync = (await import("node:fs")).writeFileSync;
		// Force the store to load (and cache) the initial
		// state. Without a prior load, the next read would
		// see the new file anyway and `reload` would be a
		// no-op.
		store.addIdentity({ id: "seed", names: ["Seed"] });
		store.listIdentities();

		writeFileSync(
			join(dir, "manual.md"),
			[
				"---",
				"id: manual",
				"names:",
				"  - Manual Entry",
				"handles: []",
				"---",
				"",
				"# Manual Entry",
				"",
			].join("\n"),
		);
		// Cache is stale; new file is invisible.
		expect(store.getIdentity("manual")).toBeUndefined();
		store.reload();
		expect(store.getIdentity("manual")?.names).toEqual(["Manual Entry"]);
	});
});
