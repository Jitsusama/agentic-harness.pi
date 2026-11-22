/**
 * A host spawn left unanswered: which id a spawn asked again sends, for
 * how long, and for which quest and kind of host.
 */
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearUnanswered,
	noteUnanswered,
	pendingId,
} from "../../../../extensions/quest-workflow/verbs/spawn-pending.ts";
import { REPEAT_WINDOW_MS } from "../../../../host/service/repeats.ts";
import { WRITING } from "../../../../lib/internal/write-whole.ts";

let dir: string;

/** What the folder keeps, leaving out the folder whole writes stage in. */
const keptIn = (folder: string): string[] =>
	readdirSync(folder).filter((name) => name !== WRITING);
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "spawn-pending-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const alpha = { questId: "QEST-A", kind: "background" as const };
const open = {
	v: 1,
	id: "first",
	op: "open",
	cwd: "/work",
	env: { TOKEN_LIKE: "never kept" },
};

describe("a spawn left unanswered", () => {
	it("repeats its id for the same ask within the window, and no longer once past it", () => {
		noteUnanswered(alpha, open, { dir, now: 1000 });
		const again = { ...open, id: "fresh" };
		expect(
			pendingId(alpha, again, "fresh", { dir, now: 1000 + REPEAT_WINDOW_MS }),
			"within the window",
		).toBe("first");
		expect(
			pendingId(alpha, again, "fresh", {
				dir,
				now: 1001 + REPEAT_WINDOW_MS,
			}),
			"past it",
		).toBe("fresh");
	});

	it("keeps its id to its own quest and kind of host", () => {
		noteUnanswered(alpha, open, { dir, now: 1000 });
		const again = { ...open, id: "fresh" };
		expect(
			pendingId({ ...alpha, questId: "QEST-B" }, again, "fresh", {
				dir,
				now: 1000,
			}),
			"another quest",
		).toBe("fresh");
		expect(
			pendingId({ ...alpha, kind: "attended" }, again, "fresh", {
				dir,
				now: 1000,
			}),
			"another kind of host",
		).toBe("fresh");
	});

	it("sends a new id once cleared", () => {
		noteUnanswered(alpha, open, { dir, now: 1000 });
		clearUnanswered(alpha, open, { dir });
		expect(
			pendingId(alpha, { ...open, id: "fresh" }, "fresh", { dir, now: 1000 }),
		).toBe("fresh");
	});

	it("keeps each unanswered ask apart, so neither a second nor its answer loses the first's id", () => {
		const elsewhere = { ...open, id: "second", cwd: "/elsewhere" };
		noteUnanswered(alpha, open, { dir, now: 1000 });
		noteUnanswered(alpha, elsewhere, { dir, now: 1000 });
		expect(
			pendingId(alpha, { ...open, id: "fresh" }, "fresh", { dir, now: 1000 }),
			"the first, once a second was noted",
		).toBe("first");
		clearUnanswered(alpha, elsewhere, { dir });
		expect(
			pendingId(alpha, { ...open, id: "fresh" }, "fresh", { dir, now: 1000 }),
			"the first, once the second was answered",
		).toBe("first");
	});

	it("sends a new id when what was kept is torn or of the wrong shape", () => {
		noteUnanswered(alpha, open, { dir, now: 1000 });
		const [file] = keptIn(dir);
		if (file === undefined) throw new Error("nothing was kept");
		const again = { ...open, id: "fresh" };
		writeFileSync(join(dir, file), '{"id":"first","wh');
		expect(pendingId(alpha, again, "fresh", { dir, now: 1000 }), "torn").toBe(
			"fresh",
		);
		writeFileSync(join(dir, file), '{"id":7,"what":"x","askedAt":1000}');
		expect(
			pendingId(alpha, again, "fresh", { dir, now: 1000 }),
			"wrong shape",
		).toBe("fresh");
	});

	it("keeps only a hash of what was asked, never its environment", () => {
		noteUnanswered(alpha, open, { dir, now: 1000 });
		const files = keptIn(dir);
		expect(files).toHaveLength(1);
		const kept = readFileSync(join(dir, files[0] ?? ""), "utf8");
		expect(kept).not.toContain("never kept");
		expect(kept).not.toContain("/work");
		expect(files[0]).not.toContain("never kept");
	});
});
