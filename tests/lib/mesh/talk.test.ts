/**
 * Talk files: one JSON line per change, and pruning that keeps the
 * newest talks and the recent ones, whichever keeps more.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	pruneTalks,
	RETAIN_DAYS,
	RETAIN_TALKS,
	sayTalk,
	talkFile,
} from "../../../lib/mesh/talk.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
let inbox: string;

beforeEach(() => {
	inbox = join(mkdtempSync(join(tmpdir(), "talk-")), "WCJQSG");
});

afterEach(() => {
	rmSync(join(inbox, ".."), { recursive: true, force: true });
});

describe("a talk file", () => {
	it("holds one line per change, each stamped with when it was said", () => {
		sayTalk(
			inbox,
			"t1",
			{ stage: "delivered", session: "s", text: "go" },
			new Date("2026-10-26T06:00:00Z"),
		);
		sayTalk(
			inbox,
			"t1",
			{ stage: "replied", text: "done" },
			new Date("2026-10-26T06:01:00Z"),
		);

		const lines = readFileSync(talkFile(inbox, "t1"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{
				stage: "delivered",
				session: "s",
				text: "go",
				at: "2026-10-26T06:00:00.000Z",
			},
			{ stage: "replied", text: "done", at: "2026-10-26T06:01:00.000Z" },
		]);
	});

	it("is pruned only once it is both old and past the newest kept", () => {
		const folder = join(inbox, "replies");
		mkdirSync(folder, { recursive: true });
		const now = Date.parse("2026-10-26T06:00:00Z");
		const old = new Date(now - (RETAIN_DAYS + 1) * DAY_MS);
		// Two old talks, then one more recent talk than the newest kept, so
		// the oldest recent one is past that count and stays by its age.
		const total = RETAIN_TALKS + 3;
		for (let n = 0; n < total; n += 1) {
			const path = join(folder, `t${String(n).padStart(4, "0")}.jsonl`);
			writeFileSync(path, "{}\n");
			const when =
				n < 2
					? new Date(old.getTime() + n * 1000)
					: new Date(now - DAY_MS + n * 1000);
			utimesSync(path, when, when);
		}

		expect(pruneTalks(inbox, now)).toBe(2);
		const kept = readdirSync(folder);
		expect(kept).toHaveLength(RETAIN_TALKS + 1);
		expect(kept).not.toContain("t0000.jsonl");
		expect(kept).not.toContain("t0001.jsonl");
		expect(kept).toContain("t0002.jsonl");
	});

	it("keeps every old talk while there are fewer than the newest kept", () => {
		sayTalk(inbox, "t1", { stage: "replied", text: "x" });
		const path = talkFile(inbox, "t1");
		const old = new Date(Date.now() - (RETAIN_DAYS + 30) * DAY_MS);
		utimesSync(path, old, old);

		expect(pruneTalks(inbox)).toBe(0);
		expect(pruneTalks(join(inbox, "..", "nobody"))).toBe(0);
	});
});
