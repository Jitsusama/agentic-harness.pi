/** No new direct process identity, cwd or process-wide session state. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { processSessionSites } from "./session-state.ts";

const ROOT = join(import.meta.dirname, "../..");
const LIST = join(import.meta.dirname, "session-state-waiting.txt");

/** Today's sites await their domain's migration; the allowance only shrinks. */
function waiting(): Map<string, number> {
	return new Map(
		readFileSync(LIST, "utf8")
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => {
				const [key, count] = line.split(" ");
				return [key, Number(count)];
			}),
	);
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
	walk(join(ROOT, "extensions"));
	return found;
}

describe("session state in extensions", () => {
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
			processSessionSites("sessionSlot(name, ctx, make); sessionCwd(ctx);")
				.size,
			"session seam calls add no process-wide state",
		).toBe(0);
	});

	it("adds no process-wide session shortcuts", () => {
		const before = waiting();
		const grown = [...counted()].filter(
			([key, count]) => count > (before.get(key) ?? 0),
		);
		expect(
			grown,
			"use core/session identity, slots and environment, or ctx.cwd; genuine process infrastructure needs an explicit reviewed exemption",
		).toEqual([]);
	});

	it("lowers each waiting count as its domain migrates", () => {
		const now = counted();
		const stale = [...waiting()].filter(
			([key, count]) => count > (now.get(key) ?? 0),
		);
		expect(
			stale,
			"lower tests/package/session-state-waiting.txt to the counts still present, removing zero entries",
		).toEqual([]);
	});
});
