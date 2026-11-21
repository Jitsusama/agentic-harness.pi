/** The durable roster: one lock per host key, holds that outlive every stop. */
import {
	lstat,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRoster, ROSTER_WAIT_MS } from "../../../host/service/roster.ts";
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

/** A clock that moves only as the start pauses, so a minute takes none. */
function clock(onPause: () => Promise<void> = async () => {}) {
	const at = { now: 0 };
	return {
		at,
		wait: {
			now: () => at.now,
			pause: async (ms: number) => {
				at.now += ms;
				await onPause();
			},
		},
	};
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

	it("refuses while the lock's holder runs or cannot be judged, a minute on and no later", async () => {
		const live = await openRoster({ key: KEY, dir, owner: first });
		const said = {
			running:
				"Another host holds this roster: pid 101 still runs after waiting 60 s",
			unknown:
				"Cannot tell whether the roster's last host, pid 101, still runs after waiting 60 s",
		};
		for (const verdict of ["running", "unknown"] as const) {
			const { at, wait } = clock();
			await expect(
				openRoster({
					key: KEY,
					dir,
					owner: second,
					standing: judged(verdict),
					wait,
				}),
			).rejects.toThrow(said[verdict]);
			expect(at.now, `waited the minute on a holder ${verdict}`).toBe(
				ROSTER_WAIT_MS,
			);
		}
		await live.hold(entry(A));
		expect(live.entries()).toHaveLength(1);
		await live.close();
	});

	it("writes a seed over what its file held only once the lock is its own, checked as a hold is", async () => {
		const earlier = await openRoster({ key: KEY, dir, owner: first });
		await earlier.hold(entry(A));
		await expect(
			openRoster({
				key: KEY,
				dir,
				owner: second,
				standing: judged("running"),
				wait: clock().wait,
				seed: [entry(B)],
			}),
		).rejects.toThrow("Another host holds this roster");
		const untouched = JSON.parse(await readFile(rosterPath(KEY, dir), "utf8"));
		expect(untouched.sessions, "the holder's roster, unwritten").toEqual([
			entry(A),
		]);
		await earlier.close();
		await expect(
			openRoster({
				key: KEY,
				dir,
				owner: second,
				seed: [{ ...entry(B), launch: { "EXP ARM": "x" } }],
			}),
		).rejects.toThrow("takes only variable names: EXP ARM");
		const seeded = await openRoster({
			key: KEY,
			dir,
			owner: second,
			seed: [entry(B)],
		});
		expect(seeded.entries().map((held) => held.sessionId)).toEqual([B]);
		const written = JSON.parse(await readFile(rosterPath(KEY, dir), "utf8"));
		expect(written.sessions).toEqual([entry(B)]);
		await seeded.close();
	});

	it("takes over from a last host that ends within the minute", async () => {
		const stopping = await openRoster({ key: KEY, dir, owner: first });
		await stopping.hold(entry(A));
		let looks = 0;
		const told: number[] = [];
		const { at, wait } = clock();
		const next = await openRoster({
			key: KEY,
			dir,
			owner: second,
			standing: async () => {
				looks += 1;
				return looks < 5 ? "running" : "gone";
			},
			wait: {
				...wait,
				waiting: async ({ pid }) => {
					told.push(pid);
				},
			},
		});
		expect(at.now, "four looks a second apart").toBe(4_000);
		expect(told, "told once that it waits, and on whom").toEqual([101]);
		expect(next.entries().map((held) => held.sessionId)).toEqual([A]);
		expect(
			JSON.parse(await readFile(`${rosterPath(KEY, dir)}.lock`, "utf8")),
		).toMatchObject({ owner: second });
		await next.close();
	});

	it("takes the lock a last host lets go of as it stops", async () => {
		const stopping = await openRoster({ key: KEY, dir, owner: first });
		await stopping.hold(entry(A));
		const { at, wait } = clock(() => stopping.close());
		const next = await openRoster({
			key: KEY,
			dir,
			owner: second,
			standing: judged("running"),
			wait,
		});
		expect(at.now, "one look, then the lock was free").toBe(1_000);
		expect(next.entries().map((held) => held.sessionId)).toEqual([A]);
		await next.close();
	});

	it("takes the lock a dead host's lock leaves as it is judged", async () => {
		await openRoster({ key: KEY, dir, owner: first });
		const lock = `${rosterPath(KEY, dir)}.lock`;
		const next = await openRoster({
			key: KEY,
			dir,
			owner: second,
			standing: async () => {
				await unlink(lock);
				return "gone";
			},
		});
		expect(
			JSON.parse(await readFile(lock, "utf8")),
			"nothing left to move aside, so it simply takes the lock",
		).toMatchObject({ owner: second });
		await next.close();
	});

	it("refuses a lock left empty past the wait, naming it", async () => {
		await openRoster({ key: KEY, dir, owner: first }).then((r) => r.close());
		const lock = `${rosterPath(KEY, dir)}.lock`;
		await writeFile(lock, "");
		const { at, wait } = clock();
		await expect(
			openRoster({ key: KEY, dir, owner: second, wait }),
		).rejects.toThrow(
			`Roster lock is still missing, empty or unreadable after waiting 60 s; inspect ${lock}`,
		);
		expect(at.now, "looked again for the whole minute").toBe(ROSTER_WAIT_MS);
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
