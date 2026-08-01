import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocument } from "../../../extensions/quest-workflow/lifecycle";
import type { QuestState } from "../../../extensions/quest-workflow/state";

let questDir: string;

function state(): QuestState {
	return { questDir } as QuestState;
}

/** A document body whose front matter the strict parser accepts. */
function readableBody(): string {
	return [
		"---",
		"id: PLAN-20260101-AAAAAA",
		"kind: plan",
		"quest: QEST-20260101-AAAAAA",
		"stage: draft",
		"updated: 2026-01-01",
		"---",
		"",
		"# A plan",
	].join("\n");
}

beforeEach(() => {
	questDir = mkdtempSync(join(tmpdir(), "born-readable-"));
});

afterEach(() => {
	rmSync(questDir, { recursive: true, force: true });
});

describe("creating a document that discovery will be able to find", () => {
	it("writes one whose front matter parses", () => {
		const path = createDocument(state(), {
			id: "PLAN-20260101-AAAAAA",
			kind: "plan",
			title: "A plan",
			stage: "draft",
			scaffoldBody: readableBody(),
		});

		expect(path).toBeDefined();
		expect(existsSync(path as string)).toBe(true);
	});

	it("refuses one whose front matter will not parse", () => {
		// This is the writer that produced the five documents found
		// invisible to discovery. Repairing the reader to fail open and
		// explain itself left this end untouched: an unreadable document
		// was written, reported as drafted, and never listed again.
		const path = createDocument(state(), {
			id: "PLAN-20260101-BBBBBB",
			kind: "plan",
			title: "A plan",
			stage: "draft",
			scaffoldBody: "# A plan with no front matter at all\n",
		});

		expect(path).toBeUndefined();
	});

	it("leaves nothing on disk when it refuses", () => {
		// A refusal that still wrote the file would be the worse outcome:
		// the caller reports failure and the unreadable document exists
		// anyway, which is the state the repair sweep had to clean up.
		createDocument(state(), {
			id: "PLAN-20260101-CCCCCC",
			kind: "plan",
			title: "A plan",
			stage: "draft",
			scaffoldBody: "# No front matter\n",
		});

		const plans = join(questDir, "plans");
		expect(existsSync(plans) ? readdirSync(plans) : []).toEqual([]);
	});
});
