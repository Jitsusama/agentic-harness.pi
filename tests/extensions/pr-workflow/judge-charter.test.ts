import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultJudgeCharter,
	resolveJudgeCharter,
} from "../../../extensions/pr-workflow/judge-charter.js";

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function dirWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pr-workflow-judge-charter-"));
	tempDirs.push(dir);
	await Promise.all(
		Object.entries(files).map(([name, body]) =>
			writeFile(join(dir, name), body),
		),
	);
	return dir;
}

describe("defaultJudgeCharter", () => {
	it("states the judge's identity and no-persona stance", () => {
		const charter = defaultJudgeCharter();
		expect(charter).toMatch(/judge/i);
		expect(charter).toMatch(/synthesize|consolidat/i);
		// The defining stance: the judge holds no lens of its own.
		expect(charter).toMatch(/no lens|not a reviewer|no persona/i);
	});

	it("carries the synthesis discipline and priority order", () => {
		const charter = defaultJudgeCharter();
		expect(charter).toMatch(/security/i);
		expect(charter).toMatch(/keep over drop|favour keep|cannot resurface/i);
	});
});

describe("resolveJudgeCharter", () => {
	it("uses judge.md when present", async () => {
		const dir = await dirWith({ "judge.md": "Custom judge law." });
		expect(await resolveJudgeCharter(dir)).toBe("Custom judge law.");
	});

	it("falls back to the default when judge.md is absent", async () => {
		const dir = await dirWith({});
		expect(await resolveJudgeCharter(dir)).toBe(defaultJudgeCharter());
	});

	it("falls back to the default when judge.md is blank", async () => {
		const dir = await dirWith({ "judge.md": "   \n  " });
		expect(await resolveJudgeCharter(dir)).toBe(defaultJudgeCharter());
	});
});
