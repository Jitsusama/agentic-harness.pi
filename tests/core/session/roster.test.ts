/** Whether a hosted conversation is held reads doubt as unknown, never unheld. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	heldSessionStatus,
	rosterPath,
} from "../../../lib/core/session/roster.ts";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "roster-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function entry(sessionId: string) {
	return {
		sessionId,
		file: `/sessions/${sessionId}.jsonl`,
		cwd: "/work",
		attended: true,
		since: "2026-11-09T15:00:00.000Z",
	};
}

async function roster(key: string, sessions: unknown[]) {
	await writeFile(
		rosterPath(key, dir),
		JSON.stringify({ v: 1, key, sessions }),
	);
}

describe("heldSessionStatus", () => {
	it("answers held when any roster holds the conversation", async () => {
		await roster("work-attended", [entry(A)]);
		await roster("work-background", []);
		expect(await heldSessionStatus(A, { dir })).toBe("held");
	});

	it("answers unheld only after every roster was read whole", async () => {
		await roster("work-attended", [entry(A)]);
		await roster("home-background", []);
		expect(await heldSessionStatus(B, { dir })).toBe("unheld");
	});

	it("answers unknown with no folder or no rosters at all", async () => {
		expect(await heldSessionStatus(A, { dir: join(dir, "absent") })).toBe(
			"unknown",
		);
		expect(await heldSessionStatus(A, { dir })).toBe("unknown");
	});

	it("answers unknown when the named host's roster is missing", async () => {
		await roster("work-attended", []);
		expect(
			await heldSessionStatus(A, { dir, hostKey: "work-background" }),
		).toBe("unknown");
		expect(await heldSessionStatus(A, { dir, hostKey: "work-attended" })).toBe(
			"unheld",
		);
	});

	it("reads a corrupt or mismatched roster as doubt, but held still wins", async () => {
		await writeFile(rosterPath("work-attended", dir), "{half");
		expect(await heldSessionStatus(A, { dir })).toBe("unknown");
		await roster("home-attended", [entry(A)]);
		expect(await heldSessionStatus(A, { dir })).toBe("held");
		await rm(rosterPath("home-attended", dir));
		await writeFile(
			rosterPath("work-attended", dir),
			JSON.stringify({ v: 1, key: "home-attended", sessions: [] }),
		);
		expect(await heldSessionStatus(B, { dir })).toBe("unknown");
	});

	it("refuses entries a reaper could misread: duplicates, relative paths, bad ids", async () => {
		for (const sessions of [
			[entry(A), entry(A)],
			[{ ...entry(A), file: "relative.jsonl" }],
			[{ ...entry(A), sessionId: "not-a-uuid" }],
			[{ ...entry(A), extra: undefined, since: "yesterday" }],
		]) {
			await roster("work-attended", sessions);
			expect(await heldSessionStatus(B, { dir })).toBe("unknown");
		}
	});

	it("ignores the staging folder and lock files beside the rosters", async () => {
		await roster("work-attended", []);
		await mkdir(join(dir, ".writing"));
		await writeFile(join(dir, "work-attended.json.lock"), "{}");
		expect(await heldSessionStatus(A, { dir })).toBe("unheld");
	});
});
