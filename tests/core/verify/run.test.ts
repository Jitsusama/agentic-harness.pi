import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runVerify,
	stripAnsi,
	truncate,
} from "../../../lib/core/verify/run.ts";

// Built via fromCharCode rather than string escapes: a literal escape
// sequence typed into this file is easy to mistake for the control
// byte itself (or the other way around), so the control characters
// are constructed explicitly instead of embedded.
// The detected command is `npm run lint`, so those cases need an npm
// that runs. Some machines' npm runs only inside a project's own
// shell, and there they skip rather than fail for the machine.
const NPM_RUNS =
	spawnSync("npm", ["--version"], { cwd: tmpdir(), encoding: "utf8" })
		.status === 0;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("stripAnsi", () => {
	it("removes colour SGR sequences but keeps the text", () => {
		expect(stripAnsi(`${ESC}[31mRED${ESC}[0m done`)).toBe("RED done");
	});

	it("removes cursor-control sequences that smear a TUI", () => {
		expect(stripAnsi(`line${ESC}[2K${ESC}[1Aover`)).toBe("lineover");
	});

	it("removes an OSC sequence terminated by BEL", () => {
		expect(stripAnsi(`${ESC}]0;title${BEL}text`)).toBe("text");
	});

	it("removes an OSC sequence terminated by ST (ESC backslash)", () => {
		expect(stripAnsi(`${ESC}]0;title${ESC}\\text`)).toBe("text");
	});

	it("removes a CSI sequence with an extended parameter class", () => {
		expect(stripAnsi(`a${ESC}[38:5:200mb${ESC}[0m`)).toBe("ab");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("Tests 2220 passed")).toBe("Tests 2220 passed");
	});

	it("strips repeated sequences across the whole string", () => {
		expect(stripAnsi(`${ESC}[32m✓${ESC}[39m a ${ESC}[32m✓${ESC}[39m b`)).toBe(
			"✓ a ✓ b",
		);
	});
});

describe("truncate", () => {
	it("returns short output trimmed and untouched", () => {
		expect(truncate("a\nb\nc")).toBe("a\nb\nc");
	});

	it("keeps only the tail when the output runs long", () => {
		const output = Array.from({ length: 250 }, (_, i) => `line ${i}`).join(
			"\n",
		);

		const result = truncate(output, 200);

		expect(result).toContain("50 earlier lines omitted");
		expect(result).toContain("line 249");
		expect(result).not.toContain("line 49\n");
	});
});

describe("runVerify", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "run-verify-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports no command found when the project has no relevant scripts", async () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { build: "echo build" } }),
		);

		const result = await runVerify({ cwd: dir });

		expect(result.ok).toBe(false);
		expect(result.output).toContain("No verification command found");
	});

	it.skipIf(!NPM_RUNS)(
		"runs and reports a passing detected command",
		async () => {
			writeFileSync(join(dir, "package-lock.json"), JSON.stringify({}));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ scripts: { lint: "true" } }),
			);

			const result = await runVerify({ cwd: dir });

			expect(result.ok).toBe(true);
			expect(result.command).toBe("npm run lint");
			expect(result.output).toContain("Passed:");
		},
	);

	it.skipIf(!NPM_RUNS)(
		"runs and reports a failing detected command with its output",
		async () => {
			writeFileSync(join(dir, "package-lock.json"), JSON.stringify({}));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ scripts: { lint: "echo boom && false" } }),
			);

			const result = await runVerify({ cwd: dir });

			expect(result.ok).toBe(false);
			expect(result.output).toContain("Failed");
			expect(result.output).toContain("boom");
		},
	);

	it("prefers questVerify over any package script", async () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { lint: "false" } }),
		);

		const result = await runVerify({ cwd: dir, questVerify: "true" });

		expect(result.ok).toBe(true);
		expect(result.command).toBe("true");
	});
});
