/** The durable roster: one lock per host key, holds that outlive every stop. */
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRoster } from "../../../host/service/roster.ts";
import {
	heldSessionStatus,
	rosterPath,
} from "../../../lib/core/session/roster.ts";
import type {
	Standing,
	TickedOwner,
} from "../../../lib/internal/process-ticks.ts";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const KEY = "work-attended";
const first: TickedOwner = { pid: 101, startedAt: 1, startTicks: 11 };
const second: TickedOwner = { pid: 202, startedAt: 2, startTicks: 22 };

let dir: string;
beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "host-roster-")), "rosters");
});
afterEach(async () => {
	await rm(join(dir, ".."), { recursive: true, force: true });
});

function entry(sessionId: string, file = `/sessions/${sessionId}.jsonl`) {
	return {
		sessionId,
		file,
		cwd: "/work",
		attended: true,
		since: "2026-11-09T15:00:00.000Z",
	};
}

function judged(verdict: Standing) {
	return async () => verdict;
}

describe("openRoster", () => {
	it("creates a private folder and an empty roster that names the key", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		expect((await lstat(dir)).mode & 0o777).toBe(0o700);
		expect(await heldSessionStatus(A, { dir, hostKey: KEY })).toBe("unheld");
		await roster.close();
	});

	it("persists holds before returning, and only a drop removes one", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		await roster.hold(entry(A));
		expect(await heldSessionStatus(A, { dir })).toBe("held");
		await roster.close();
		expect(await heldSessionStatus(A, { dir })).toBe("held");
		const again = await openRoster({ key: KEY, dir, owner: second });
		expect(again.entries().map((held) => held.sessionId)).toEqual([A]);
		await again.drop(A);
		expect(await heldSessionStatus(A, { dir })).toBe("unheld");
		await again.close();
	});

	it("writes a launch environment only when it holds something, and refuses a name no shell takes", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		await roster.hold({ ...entry(A), launch: {} });
		await roster.hold({ ...entry(B), launch: { SHOPIFY_EXP_ARM: "control" } });
		await expect(
			roster.hold({
				...entry("c0000000-0000-4000-8000-000000000003"),
				launch: { "EXP ARM": "x" },
			}),
		).rejects.toThrow("takes only variable names: EXP ARM");
		await roster.close();
		const written = JSON.parse(await readFile(rosterPath(KEY, dir), "utf8"));
		expect(written.sessions).toEqual([
			entry(A),
			{ ...entry(B), launch: { SHOPIFY_EXP_ARM: "control" } },
		]);
	});

	it("keeps every hold when the host dies without closing, and takes over a dead lock", async () => {
		const crashed = await openRoster({ key: KEY, dir, owner: first });
		await crashed.hold(entry(A));
		const recovered = await openRoster({
			key: KEY,
			dir,
			owner: second,
			standing: judged("gone"),
		});
		expect(recovered.entries().map((held) => held.sessionId)).toEqual([A]);
		expect(
			JSON.parse(await readFile(`${rosterPath(KEY, dir)}.lock`, "utf8")),
		).toMatchObject({ owner: second });
		await recovered.close();
	});

	it("refuses while the lock's holder runs or cannot be judged", async () => {
		const live = await openRoster({ key: KEY, dir, owner: first });
		for (const verdict of ["running", "unknown"] as const)
			await expect(
				openRoster({ key: KEY, dir, owner: second, standing: judged(verdict) }),
			).rejects.toThrow();
		await live.hold(entry(A));
		expect(live.entries()).toHaveLength(1);
		await live.close();
	});

	it("refuses a malformed lock instead of taking it", async () => {
		await openRoster({ key: KEY, dir, owner: first }).then((r) => r.close());
		await writeFile(`${rosterPath(KEY, dir)}.lock`, "not json");
		await expect(
			openRoster({ key: KEY, dir, owner: second, standing: judged("gone") }),
		).rejects.toThrow("unreadable");
	});

	it("puts back a lock another host took between judging and takeover", async () => {
		await openRoster({ key: KEY, dir, owner: first });
		const lock = `${rosterPath(KEY, dir)}.lock`;
		const rival = JSON.stringify({
			key: KEY,
			owner: { pid: 303, startedAt: 3 },
		});
		await expect(
			openRoster({
				key: KEY,
				dir,
				owner: second,
				standing: async () => {
					await writeFile(lock, rival);
					return "gone";
				},
			}),
		).rejects.toThrow("took this roster");
		expect(await readFile(lock, "utf8")).toBe(rival);
	});

	it("refuses to start over an unreadable roster and leaves it for inspection", async () => {
		await openRoster({ key: KEY, dir, owner: first }).then((r) => r.close());
		await writeFile(rosterPath(KEY, dir), "{half");
		await expect(openRoster({ key: KEY, dir, owner: second })).rejects.toThrow(
			"unreadable",
		);
		expect(await readFile(rosterPath(KEY, dir), "utf8")).toBe("{half");
		await expect(openRoster({ key: KEY, dir, owner: second })).rejects.toThrow(
			"unreadable",
		);
	});

	it("serializes concurrent holds and refuses a second hold of one id or file", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		await Promise.all([roster.hold(entry(A)), roster.hold(entry(B))]);
		await expect(
			roster.hold(entry(A, "/sessions/other.jsonl")),
		).rejects.toThrow("already held");
		await expect(
			roster.hold(
				entry("c0000000-0000-4000-8000-000000000003", `/sessions/${A}.jsonl`),
			),
		).rejects.toThrow("already held");
		expect(roster.entries().map((held) => held.sessionId)).toEqual([A, B]);
		expect(await heldSessionStatus(B, { dir })).toBe("held");
		await roster.close();
	});

	it("replaces a hold in its place in one write, and refuses one it can't make whole", async () => {
		const C = "c0000000-0000-4000-8000-000000000003";
		const roster = await openRoster({ key: KEY, dir, owner: first });
		await roster.hold(entry(A));
		await roster.hold(entry(B));
		await roster.replace(A, entry(C));
		expect(roster.entries().map((held) => held.sessionId)).toEqual([C, B]);
		const written = JSON.parse(await readFile(rosterPath(KEY, dir), "utf8"));
		expect(
			written.sessions.map((held: { sessionId: string }) => held.sessionId),
		).toEqual([C, B]);
		expect(await heldSessionStatus(A, { dir })).toBe("unheld");

		await expect(roster.replace(A, entry(A))).rejects.toThrow("not held");
		await expect(
			roster.replace(
				C,
				entry("d0000000-0000-4000-8000-000000000004", `/sessions/${B}.jsonl`),
			),
		).rejects.toThrow("already held");
		await expect(
			roster.replace(C, {
				...entry("e0000000-0000-4000-8000-000000000005"),
				launch: { API_TOKEN: "x" },
			}),
		).rejects.toThrow("never holds a credential");
		expect(roster.entries().map((held) => held.sessionId)).toEqual([C, B]);
		await roster.close();
	});

	it("replaces a hold with one keeping its own file, as a resume of the same session would", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		await roster.hold(entry(A));
		await roster.replace(A, entry(B, `/sessions/${A}.jsonl`));
		expect(roster.entries()).toEqual([entry(B, `/sessions/${A}.jsonl`)]);
		await roster.close();
	});

	it("refuses changes after close and leaves another host's lock alone", async () => {
		const roster = await openRoster({ key: KEY, dir, owner: first });
		const lock = `${rosterPath(KEY, dir)}.lock`;
		const other = JSON.stringify({ key: KEY, owner: second });
		await writeFile(lock, other);
		await roster.close();
		expect(await readFile(lock, "utf8")).toBe(other);
		await expect(roster.hold(entry(A))).rejects.toThrow("closed");
	});
});
