/**
 * The subagent tool keeping a fenced command's code out of its
 * children, end to end: driven through the registered tool with the
 * runner stubbed, so what is checked is what a child is started with.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { activateWith } from "../support/review-extension.ts";

const started: string[][] = [];
const given: (Readonly<Record<string, string>> | undefined)[] = [];

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: (): RunPi => async (input) => {
		started.push([...input.args]);
		given.push(input.env);
		return { exitCode: 0, finalAssistantText: "done", warnings: [] };
	},
}));

let root: string;
let installed: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-fence-")));
	vi.stubEnv("HOME", root);
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	installed = join(root, ".local", "share", "pi-packages", "own.ts");
	mkdirSync(join(root, ".local", "share", "pi-packages"), { recursive: true });
	writeFileSync(installed, "");
	writeFileSync(join(root, "planted.ts"), "");
	vi.stubEnv("PI_SANDBOX", "off");
	started.length = 0;
	given.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Run a fleet, answering with the tool's text. */
async function fleet(jobs: object[]): Promise<string> {
	const stub = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	);
	const tool = stub.definitions.get("subagent");
	if (!tool) throw new Error("no subagent tool was registered");
	const answer = (await tool.execute("c", { jobs }, undefined, undefined, {
		hasUI: false,
		cwd: root,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
	})) as { content: { text: string }[] };
	return answer.content[0]?.text ?? "";
}

/** Every value given after `name` in a child's arguments. */
function each(args: string[] | undefined, name: string): string[] {
	return (args ?? []).flatMap((arg, at, all) =>
		arg === name && all[at + 1] !== undefined ? [all[at + 1] as string] : [],
	);
}

const job = (id: string, extra: object = {}) => ({
	id,
	cwd: root,
	userPrompt: "go",
	...extra,
});

describe("a fleet naming extensions", () => {
	it("starts nothing when one job names an extension outside the install", async () => {
		const text = await fleet([
			job("a"),
			job("b", { extraExtensions: [join(root, "planted.ts")] }),
		]);
		expect(text).toContain("b: ");
		expect(text).toContain("planted.ts lies outside pi's installed packages");
		expect(started).toEqual([]);
	});

	it("hands the child an installed extension as followed, not the link named", async () => {
		const link = join(root, "link.ts");
		symlinkSync(installed, link);
		await fleet([job("a", { extraExtensions: [link] })]);
		expect(each(started[0], "--extension")).toContain(installed);
		expect(each(started[0], "--extension")).not.toContain(link);
	});
});

describe("a fleet's children and a folder's own .pi", () => {
	it("starts an unisolated child ignoring project-local files", async () => {
		await fleet([job("a", { isolated: false })]);
		expect(started[0]).toContain("--no-approve");
		expect(started[0]).not.toContain("--no-extensions");
	});

	it("starts an isolated child ignoring them too", async () => {
		await fleet([job("a")]);
		expect(started[0]).toContain("--no-approve");
		expect(started[0]).toContain("--no-extensions");
	});
});

describe("a fenced session's fleet", () => {
	it("starts an isolated child in its sandbox, with the fence's own bash", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		await fleet([job("a")]);
		expect(given[0]).toMatchObject({ PI_SANDBOX: "fence" });
		expect(
			each(started[0], "--extension").some((path) =>
				path.endsWith(join("extensions", "shell-workflow", "index.ts")),
			),
		).toBe(true);
	});

	it("starts an unisolated child in its sandbox, which its own extensions fence", async () => {
		vi.stubEnv("PI_SANDBOX", "strict");
		await fleet([job("a", { isolated: false })]);
		expect(given[0]).toMatchObject({ PI_SANDBOX: "strict" });
		expect(
			each(started[0], "--extension").some((path) =>
				path.includes("shell-workflow"),
			),
		).toBe(false);
	});

	it("leaves an unfenced session's children as they were", async () => {
		await fleet([job("a")]);
		expect(given[0]?.PI_SANDBOX).toBeUndefined();
	});
});
