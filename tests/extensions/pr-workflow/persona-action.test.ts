import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPersona,
	editPersona,
	formatPersonaList,
	removePersona,
} from "../../../extensions/pr-workflow/persona-action.js";
import { loadPersonas } from "../../../extensions/pr-workflow/personas.js";

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function emptyDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pr-workflow-persona-action-"));
	tempDirs.push(dir);
	return dir;
}

const DRAFT = {
	name: "Privilege Escalation Hunter",
	description: "Reads every diff as a path to higher privilege.",
	charter: "Hunt escalation. Trace every new capability.",
};

describe("addPersona", () => {
	it("writes a new persona file that loads back", async () => {
		const dir = await emptyDir();
		const result = await addPersona(dir, { id: "escalation", ...DRAFT });
		expect(result.ok).toBe(true);
		const { personas } = await loadPersonas(dir);
		expect(personas.map((p) => p.id)).toEqual(["escalation"]);
		expect(personas[0]?.name).toBe("Privilege Escalation Hunter");
		expect(personas[0]?.charter).toBe(
			"Hunt escalation. Trace every new capability.",
		);
	});

	it("refuses to overwrite an existing persona", async () => {
		const dir = await emptyDir();
		await addPersona(dir, { id: "escalation", ...DRAFT });
		const second = await addPersona(dir, {
			id: "escalation",
			...DRAFT,
			charter: "different charter",
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("expected failure");
		expect(second.error).toMatch(/escalation.*exists|already/i);
		// Original charter is untouched.
		const { personas } = await loadPersonas(dir);
		expect(personas[0]?.charter).toBe(
			"Hunt escalation. Trace every new capability.",
		);
	});
});

describe("editPersona", () => {
	it("rewrites an existing persona in place", async () => {
		const dir = await emptyDir();
		await addPersona(dir, { id: "escalation", ...DRAFT });
		const result = await editPersona(dir, {
			id: "escalation",
			...DRAFT,
			charter: "Revised charter.",
		});
		expect(result.ok).toBe(true);
		const { personas } = await loadPersonas(dir);
		expect(personas).toHaveLength(1);
		expect(personas[0]?.charter).toBe("Revised charter.");
	});

	it("refuses to edit a persona that does not exist", async () => {
		const dir = await emptyDir();
		const result = await editPersona(dir, { id: "ghost", ...DRAFT });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/ghost.*not|does not exist|no persona/i);
	});
});

describe("formatPersonaList", () => {
	it("lists id, name and description per persona", () => {
		const text = formatPersonaList({
			personas: [
				{
					id: "escalation",
					name: "Escalation Hunter",
					description: "Hunts privilege escalation.",
					charter: "...",
				},
			],
			errors: [],
		});
		expect(text).toContain("escalation");
		expect(text).toContain("Escalation Hunter");
		expect(text).toContain("Hunts privilege escalation.");
	});

	it("notes files that failed to parse", () => {
		const text = formatPersonaList({
			personas: [],
			errors: [{ id: "broken", error: "missing a name" }],
		});
		expect(text).toMatch(/broken/);
		expect(text).toMatch(/missing a name/);
	});

	it("says so when the library is empty", () => {
		const text = formatPersonaList({ personas: [], errors: [] });
		expect(text).toMatch(/no personas|empty/i);
	});
});

describe("removePersona", () => {
	it("deletes an existing persona", async () => {
		const dir = await emptyDir();
		await addPersona(dir, { id: "escalation", ...DRAFT });
		const result = await removePersona(dir, "escalation");
		expect(result.ok).toBe(true);
		const { personas } = await loadPersonas(dir);
		expect(personas).toEqual([]);
	});

	it("refuses to remove a persona that does not exist", async () => {
		const dir = await emptyDir();
		const result = await removePersona(dir, "ghost");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.error).toMatch(/ghost.*not|does not exist|no persona/i);
	});
});
