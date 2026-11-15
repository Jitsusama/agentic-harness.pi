/**
 * A quest's documents on disk: the focused one's stage, sealing the
 * ones still open when a quest ends, and scaffolding a new one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDocument,
	focusDocument,
	sealQuestDocuments,
	writeDocumentStage,
} from "../../../lib/core/quest/lifecycle.ts";
import { mintId } from "../../../lib/internal/quest/id.ts";
import { serializeDocumentFrontMatter } from "../../../lib/quest/index.ts";
import {
	documentOnDisk,
	LONG_AGO,
	loadIntoState,
	questOnDisk,
	seedDocument,
	seedQuest,
	useQuestsRoot,
} from "./support/quests.ts";

const state = useQuestsRoot();

describe("writeDocumentStage", () => {
	it("writes nothing when no document is focused", () => {
		expect(writeDocumentStage(state(), "draft")).toBe(false);
	});

	it("writes the stage to disk, stamps it and mirrors it in state", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const path = seedDocument(dir);
		focusDocument(s, path);
		expect(writeDocumentStage(s, "build")).toBe(true);
		expect(documentOnDisk(path)).toMatchObject({ stage: "build" });
		expect(documentOnDisk(path).updated).not.toBe(LONG_AGO);
		expect(s.documentStage).toBe("build");
	});

	it("keeps the body as it was", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const path = seedDocument(dir, {}, "\n# A Plan\n\nWords kept.\n");
		focusDocument(s, path);
		writeDocumentStage(s, "draft");
		expect(readFileSync(path, "utf8")).toContain("\n# A Plan\n\nWords kept.\n");
	});

	it("leaves state where it was when the document no longer parses", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const path = seedDocument(dir);
		focusDocument(s, path);
		writeFileSync(path, "no front matter\n");
		expect(writeDocumentStage(s, "build")).toBe(false);
		expect(s.documentStage).toBe("think");
		expect(readFileSync(path, "utf8")).toBe("no front matter\n");
	});
});

describe("sealQuestDocuments", () => {
	it("seals every open document and counts them", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		const open = [
			seedDocument(dir, { stage: "think" }),
			seedDocument(dir, { stage: "draft", kind: "research", id: mintId("RSCH") }),
			seedDocument(dir, { stage: "build", kind: "report", id: mintId("RPRT") }),
		];
		const done = seedDocument(dir, { stage: "concluded" });
		expect(sealQuestDocuments(dir, "retired")).toBe(3);
		expect(open.map((path) => documentOnDisk(path).stage)).toEqual([
			"retired",
			"retired",
			"retired",
		]);
		expect(documentOnDisk(done)).toMatchObject({
			stage: "concluded",
			updated: LONG_AGO,
		});
	});

	it("passes over a document that won't parse and a quest with none", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		expect(sealQuestDocuments(dir, "concluded")).toBe(0);
		const kept = seedDocument(dir);
		writeFileSync(join(dir, "plans", "broken.md"), "not a document\n");
		expect(sealQuestDocuments(dir, "concluded")).toBe(1);
		expect(documentOnDisk(kept).stage).toBe("concluded");
		expect(readFileSync(join(dir, "plans", "broken.md"), "utf8")).toBe(
			"not a document\n",
		);
	});
});

describe("createDocument", () => {
	function scaffold(questId: string, id: string): string {
		const frontMatter = serializeDocumentFrontMatter({
			id,
			kind: "brief",
			quest: questId,
			stage: "draft",
			updated: LONG_AGO,
		});
		return `${frontMatter}\n\n# A Brief\n`;
	}

	it("writes nothing when no quest is loaded", () => {
		const id = mintId("BRIF");
		expect(
			createDocument(state(), {
				id,
				kind: "brief",
				title: "A Brief",
				stage: "draft",
				scaffoldBody: scaffold("QEST-20260101-AAAAAA", id),
			}),
		).toBeUndefined();
	});

	it("writes the scaffold into the kind's folder and answers its path", () => {
		const s = state();
		const dir = seedQuest(s, "A");
		loadIntoState(s, dir);
		const id = mintId("BRIF");
		const body = scaffold(questOnDisk(dir).id, id);
		const path = createDocument(s, {
			id,
			kind: "brief",
			title: "A Brief",
			stage: "draft",
			scaffoldBody: body,
		});
		expect(path).toBe(join(dir, "briefs", `${id}.md`));
		expect(readFileSync(join(dir, "briefs", `${id}.md`), "utf8")).toBe(body);
	});
});
