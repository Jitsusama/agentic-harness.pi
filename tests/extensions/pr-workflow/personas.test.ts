import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadPersonas,
	parsePersona,
	personasDir,
	serializePersona,
} from "../../../extensions/pr-workflow/personas.js";

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function personaDir(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pr-workflow-personas-"));
	tempDirs.push(dir);
	await Promise.all(
		Object.entries(files).map(([name, body]) =>
			writeFile(join(dir, name), body),
		),
	);
	return dir;
}

function persona(name: string, description: string, charter: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n${charter}\n`;
}

const PERSONA = `---
name: Privilege Escalation Hunter
description: Reads every diff as a path to higher privilege.
---
You hunt for privilege escalation. Assume the author is a careful
engineer who nonetheless left one door unlocked. Trace every new
capability to who can reach it.
`;

describe("parsePersona", () => {
	it("splits frontmatter identity from the charter body", () => {
		const result = parsePersona("escalation", PERSONA);
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		expect(result.persona.id).toBe("escalation");
		expect(result.persona.name).toBe("Privilege Escalation Hunter");
		expect(result.persona.description).toBe(
			"Reads every diff as a path to higher privilege.",
		);
		expect(result.persona.charter).toContain("You hunt for privilege");
		expect(result.persona.charter).toContain("one door unlocked");
		// The charter is the body only — no frontmatter bleed.
		expect(result.persona.charter).not.toContain("---");
		expect(result.persona.charter).not.toContain("name:");
	});

	it("rejects a document with no frontmatter fence", () => {
		const result = parsePersona("x", "just a charter, no fence");
		expect(result.ok).toBe(false);
	});

	it("rejects an unterminated frontmatter block", () => {
		const result = parsePersona("x", "---\nname: A\ndescription: b\nbody");
		expect(result.ok).toBe(false);
	});

	it("rejects frontmatter missing name or description", () => {
		expect(parsePersona("x", "---\ndescription: b\n---\nbody").ok).toBe(false);
		expect(parsePersona("x", "---\nname: A\n---\nbody").ok).toBe(false);
	});

	it("rejects an empty charter body", () => {
		const result = parsePersona("x", "---\nname: A\ndescription: b\n---\n  \n");
		expect(result.ok).toBe(false);
	});
});

describe("personasDir", () => {
	it("honours an explicit override", () => {
		expect(
			personasDir({ PR_WORKFLOW_PERSONAS_DIR: "/custom/personas" }, "/home/x"),
		).toBe("/custom/personas");
	});

	it("sits under XDG_CONFIG_HOME/pi when set", () => {
		expect(personasDir({ XDG_CONFIG_HOME: "/cfg" }, "/home/x")).toBe(
			"/cfg/pi/personas",
		);
	});

	it("falls back to ~/.config/pi/personas", () => {
		expect(personasDir({}, "/home/x")).toBe("/home/x/.config/pi/personas");
	});
});

describe("loadPersonas", () => {
	it("reads every persona file, deriving the id from the filename", async () => {
		const dir = await personaDir({
			"escalation.md": persona("Esc", "escalation lens", "Hunt escalation."),
			"perf.md": persona("Perf", "performance lens", "Watch hot paths."),
		});
		const { personas, errors } = await loadPersonas(dir);
		expect(errors).toEqual([]);
		expect(personas.map((p) => p.id)).toEqual(["escalation", "perf"]);
		expect(personas[0]?.charter).toBe("Hunt escalation.");
	});

	it("reports a per-file error without dropping the good files", async () => {
		const dir = await personaDir({
			"good.md": persona("Good", "a lens", "Charter."),
			"broken.md": "no frontmatter here",
		});
		const { personas, errors } = await loadPersonas(dir);
		expect(personas.map((p) => p.id)).toEqual(["good"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.id).toBe("broken");
	});

	it("ignores non-markdown files", async () => {
		const dir = await personaDir({
			"keep.md": persona("Keep", "a lens", "Charter."),
			"README.txt": "not a persona",
			"pr-workflow.json": "{}",
		});
		const { personas } = await loadPersonas(dir);
		expect(personas.map((p) => p.id)).toEqual(["keep"]);
	});

	it("ignores a README.md alongside the personas", async () => {
		const dir = await personaDir({
			"keep.md": persona("Keep", "a lens", "Charter."),
			"README.md": "# Personas\n\nNot a persona, just docs.",
		});
		const { personas, errors } = await loadPersonas(dir);
		expect(personas.map((p) => p.id)).toEqual(["keep"]);
		expect(errors).toEqual([]);
	});

	it("treats a missing directory as empty, not an error", async () => {
		const { personas, errors } = await loadPersonas(
			join(tmpdir(), "pr-workflow-personas-does-not-exist-zzz"),
		);
		expect(personas).toEqual([]);
		expect(errors).toEqual([]);
	});
});

describe("serializePersona", () => {
	it("round-trips through parsePersona", () => {
		const text = serializePersona({
			name: "Privilege Escalation Hunter",
			description: "Reads every diff as a path to higher privilege.",
			charter: "Hunt escalation.\nTrace every new capability.",
		});
		const result = parsePersona("escalation", text);
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		expect(result.persona.name).toBe("Privilege Escalation Hunter");
		expect(result.persona.description).toBe(
			"Reads every diff as a path to higher privilege.",
		);
		expect(result.persona.charter).toBe(
			"Hunt escalation.\nTrace every new capability.",
		);
	});
});
