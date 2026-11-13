/**
 * No new direct process identity, cwd or process-wide session state, in
 * every folder a hosted conversation loads code from: its extensions, the
 * library they import, the host and the packs a subagent loads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { processSessionSites } from "./session-state.ts";

const ROOT = join(import.meta.dirname, "../..");
const LIST = join(import.meta.dirname, "session-state-waiting.txt");
const EXEMPT = join(import.meta.dirname, "session-state-exempt.txt");
const LOADED = ["extensions", "lib", "host", "packs"];
const MANIFEST = join(ROOT, "package.json");
/**
 * How long one walk of every loaded file may take. It takes about 2 s alone,
 * but a whole-suite run starves it of CPU past vitest's 5 s default.
 */
const WALK_MS = 60_000;
const SITE_KEY = new RegExp(
	`^(${LOADED.join("|")})/\\S+:(pid|cwd|global|env-write|module)$`,
);

interface Entry {
	readonly count: number;
	readonly reason: string;
}

/** A list's entries: `path:kind count`, and for an exemption its reason. */
function listed(file: string): Map<string, Entry> {
	return new Map(
		readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const [key = "", count = "", ...reason] = line.split(" ");
				return [key, { count: Number(count), reason: reason.join(" ") }];
			}),
	);
}

/** Today's sites await their domain's migration; the allowance only shrinks. */
function waiting(): Map<string, number> {
	return new Map([...listed(LIST)].map(([key, { count }]) => [key, count]));
}

/** Process infrastructure its owner reviewed, each with why it stays. */
function exempt(): Map<string, Entry> {
	return listed(EXEMPT);
}

/** What a file may hold of a kind: what waits, and what is exempt. */
function allowed(): Map<string, number> {
	const all = waiting();
	for (const [key, { count }] of exempt()) {
		all.set(key, (all.get(key) ?? 0) + count);
	}
	return all;
}

function counted(): Map<string, number> {
	const found = new Map<string, number>();
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(ts|mjs)$/.test(entry.name)) {
				for (const [kind, count] of processSessionSites(
					readFileSync(path, "utf8"),
				)) {
					found.set(`${relative(ROOT, path)}:${kind}`, count);
				}
			}
		}
	}
	for (const folder of LOADED) walk(join(ROOT, folder));
	return found;
}

describe("session state in the code a conversation loads", () => {
	// Walked once for the cases that read it.
	let sites = new Map<string, number>();
	beforeAll(() => {
		sites = counted();
	}, WALK_MS);

	it("finds real sites, including bracket notation, but not prose", () => {
		const sites = processSessionSites(`
			// process.pid process.cwd() process.env.KEY = "no"
			const text = "Symbol.for('no')";
			process["pid"]; process.cwd(); Symbol.for("slot");
			processGlobal("slot", make); globalThis[slot];
			process.env.KEY = "yes"; delete process.env["KEY"];
			process.env["KEY"] ??= "value"; process.env = {};
		`);
		expect(
			Object.fromEntries(sites),
			"direct process shortcuts are counted",
		).toEqual({
			pid: 1,
			cwd: 1,
			global: 3,
			"env-write": 4,
		});
		expect(
			Object.fromEntries(
				processSessionSites(`
					let last; export let shared = 0, other = 1;
					const held = new Map(); const seen = new Set();
					const KINDS = new Set(["a"]); const kept = new WeakMap();
					function inner() { let local = 0; const own = new Map(); }
				`),
			),
			"a module's own state is counted, its constants and a function's locals are not",
		).toEqual({ module: 5 });
		expect(
			processSessionSites("sessionSlot(name, ctx, make); sessionCwd(ctx);")
				.size,
			"session seam calls add no process-wide state",
		).toBe(0);
	});

	it("adds no process-wide session shortcuts", () => {
		const before = allowed();
		const grown = [...sites].filter(
			([key, count]) => count > (before.get(key) ?? 0),
		);
		expect(
			grown,
			"use core/session identity, slots and environment, or ctx.cwd; genuine process infrastructure needs an explicit reviewed exemption",
		).toEqual([]);
	});

	it("lowers each waiting count as its domain migrates", () => {
		const stale = [...allowed()].filter(
			([key, count]) => count > (sites.get(key) ?? 0),
		);
		expect(
			stale,
			"lower tests/package/session-state-waiting.txt, or an exemption, to the counts still present, removing zero entries",
		).toEqual([]);
	});

	it("declares its state keyed only while no site waits", () => {
		const manifest: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"));
		const pi =
			typeof manifest === "object" && manifest !== null && "pi" in manifest
				? manifest.pi
				: undefined;
		const declared =
			typeof pi === "object" &&
			pi !== null &&
			"sessionStateKeyed" in pi &&
			pi.sessionStateKeyed === true;
		if (!declared) return;
		expect(
			[...waiting().keys()],
			"a host shares a package declaring pi.sessionStateKeyed across every folder, so each waiting site is keyed in a session slot or exempted with its reason first",
		).toEqual([]);
	});

	it("says why each exempt site stays process-wide", () => {
		const unexplained = [...exempt()]
			.filter(
				([key, { count, reason }]) =>
					!SITE_KEY.test(key) ||
					!Number.isInteger(count) ||
					count < 1 ||
					reason.trim().length === 0,
			)
			.map(([key]) => key);
		expect(
			unexplained,
			"each line of tests/package/session-state-exempt.txt is `path:kind count reason`, the reason saying why the site is process infrastructure",
		).toEqual([]);
	});
});
