/**
 * merge-gate.sh as review_offer merge runs it: bash running the script as
 * it stands, in a clone of a bare origin with this harness's Biome
 * installed, the commit to merge as its last word. Each case commits a
 * change on a branch off a main that holds a Biome config and the
 * package.json pinning Biome, so only the change's own files are judged.
 * A change that passes goes on to host-gate.sh, which lets a change that
 * touches nothing hosts run through without a test:host run.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import {
	bareOrigin,
	cloneAt,
	folder,
	removeAll,
} from "../lib/internal/carry/support/machines.ts";
import { git } from "../support/git-fixture.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it runs changes alone; it runs them from their paths below.
import "../../scripts/host-gate.sh";
import "../../scripts/merge-gate.sh";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const GATE = join(ROOT, "scripts", "merge-gate.sh");
/** Biome's own launcher, as this checkout installed it. */
const BIOME = realpathSync(
	join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome"),
);
/** The Biome version this harness pins. */
const PINNED = biomePin(readFileSync(join(ROOT, "package.json"), "utf8"));
/** A config judging as the harness does: tabs, and the recommended rules. */
const CONFIG = `{ "formatter": { "indentStyle": "tab" } }\n`;

const made: string[] = [];
afterEach(() => removeAll(made));

/** The Biome version a package.json pins. */
function biomePin(text: string): string {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.devDependencies)) return "";
	const pin = parsed.devDependencies["@biomejs/biome"];
	return typeof pin === "string" ? pin : "";
}

/** A package.json pinning Biome at `version`. */
function packageJson(version: string): string {
	return `${JSON.stringify(
		{ name: "h", devDependencies: { "@biomejs/biome": version } },
		null,
		"\t",
	)}\n`;
}

/** A harness clone whose main holds a Biome config and pin, Biome installed. */
async function harness(): Promise<string> {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	writeFileSync(join(checkout, "biome.jsonc"), CONFIG);
	writeFileSync(join(checkout, "package.json"), packageJson(PINNED));
	writeFileSync(join(checkout, ".gitignore"), "node_modules\n");
	await git(checkout, "add", "biome.jsonc", "package.json", ".gitignore");
	await git(checkout, "commit", "-q", "-m", "biome");
	await git(checkout, "push", "-q", "origin", "HEAD:main");
	const bin = join(checkout, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(BIOME, join(bin, "biome"));
	return checkout;
}

/** Commits `files` on a branch of their own, answering the commit. */
async function change(
	checkout: string,
	files: Record<string, string>,
): Promise<string> {
	await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
	for (const [file, text] of Object.entries(files)) {
		const path = join(checkout, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		await git(checkout, "add", file);
	}
	await git(checkout, "commit", "-q", "-m", "change");
	return git(checkout, "rev-parse", "HEAD");
}

/**
 * What the gate answers for `sha` in `checkout`, with a proven runtime
 * host-gate.sh can resolve, as on a machine that runs hosts.
 */
async function gate(
	checkout: string,
	sha: string,
): Promise<{ code: number; said: string }> {
	const env = { ...process.env, PI_HOST_RUNTIME: folder(made, "runtime") };
	try {
		const { stdout, stderr } = await run("bash", [GATE, sha], {
			cwd: checkout,
			env,
		});
		return { code: 0, said: stdout + stderr };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		return {
			code: typeof code === "number" ? code : -1,
			said: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

describe("merge-gate.sh", () => {
	it("lets a tidy change through to host-gate", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a change Biome would format, naming the file and the fix", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/untidy.ts": "export const untidy   =   1\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/untidy.ts");
		expect(answered.said).toContain("pnpm lint:fix");
		expect(answered.said).not.toContain("host-gate:");
	});

	it("refuses a change Biome's linter faults", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/faulty.ts":
				"export function faulty(a: number): boolean {\n\treturn a == 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/faulty.ts");
	});

	it("judges only what the change touches, not a fault already on main", async () => {
		const checkout = await harness();
		writeFileSync(join(checkout, "old.ts"), "export const old   =   1\n");
		await git(checkout, "add", "old.ts");
		await git(checkout, "commit", "-q", "-m", "old");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		await git(checkout, "fetch", "-q", "origin");
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(0);
	});

	it("lets a change that only deletes a file through", async () => {
		const checkout = await harness();
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		await git(checkout, "rm", "-q", ".gitignore");
		await git(checkout, "commit", "-q", "-m", "drop");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(0);
	});

	it("refuses when the checkout has no Biome installed, naming the install", async () => {
		const checkout = await harness();
		rmSync(join(checkout, "node_modules"), { recursive: true });
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("pnpm install --frozen-lockfile");
	});

	it("refuses when the installed Biome isn't the one the head pins", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"package.json": packageJson("0.0.1"),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("0.0.1");
		expect(answered.said).toContain(PINNED);
	});
});
