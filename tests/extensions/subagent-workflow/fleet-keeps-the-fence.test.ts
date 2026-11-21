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
import {
	joinSpawns,
	listForStage,
} from "../../../lib/internal/fence/fence-stage.ts";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { activateWith } from "../support/review-extension.ts";

const started: string[][] = [];
const given: (Readonly<Record<string, string>> | undefined)[] = [];

/**
 * Where this package runs from and where the person's settings load it,
 * as the fleet sees them: the fixture's install unless a case says not,
 * since these tests themselves run from a tree.
 */
const place = vi.hoisted(() => ({
	own: "",
	harness: undefined as string | undefined,
}));

vi.mock(
	"../../../lib/internal/fence/installed-only.ts",
	async (
		importOriginal: () => Promise<
			typeof import("../../../lib/internal/fence/installed-only.ts")
		>,
	) => {
		const real = await importOriginal();
		return {
			...real,
			packageRoot: () => place.own,
			settingsHarness: () => place.harness,
			fencedChildrenRefusal: (unisolated: boolean) =>
				real.fencedChildrenRefusal(
					unisolated,
					real.installedPackages(),
					place.own,
					() => place.harness,
				),
		};
	},
);

/** The fence's own extensions, as a fixture install holds them. */
const PACKS = [
	"shell-workflow",
	"sandbox-file-interceptor",
	"secret-scrub-interceptor",
] as const;

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
	const harness = join(root, ".local", "share", "pi-packages", "harness");
	place.own = join(harness, "versions", "a");
	place.harness = place.own;
	for (const pack of PACKS) {
		mkdirSync(join(place.own, "extensions", pack), { recursive: true });
		writeFileSync(join(place.own, "extensions", pack, "index.ts"), "");
	}
	symlinkSync(join("versions", "a"), join(harness, "current"));
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

/** A session id, as pi mints one, for a session the first stage lists. */
const LISTED = "0193a2b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";

describe("a fenced fleet naming extensions", () => {
	beforeEach(() => {
		vi.stubEnv("PI_SANDBOX", "fence");
	});

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
		await fleet([job("a", { isolated: false, extraExtensions: [link] })]);
		expect(each(started[0], "--extension")).toContain(installed);
		expect(each(started[0], "--extension")).not.toContain(link);
	});
});

describe("an unfenced fleet naming extensions", () => {
	it("hands the child what was named, since the parent's commands already run as the person", async () => {
		const planted = join(root, "planted.ts");
		await fleet([job("a", { isolated: false, extraExtensions: [planted] })]);
		expect(each(started[0], "--extension")).toContain(planted);
	});
});

describe("a fleet's children and a folder's own .pi", () => {
	it("starts a fenced session's unisolated child ignoring project-local files", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		await fleet([job("a", { isolated: false })]);
		expect(started[0]).toContain("--no-approve");
		expect(started[0]).not.toContain("--no-extensions");
	});

	it("leaves an unfenced session's unisolated child the folder's .pi, as before", async () => {
		await fleet([job("a", { isolated: false })]);
		expect(started[0]).not.toContain("--no-approve");
	});
});

describe("a fenced session's fleet", () => {
	it("starts no child when this session runs the harness from a tree, whose files each child would load outside the fence", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		place.own = join(root, "src", "harness");
		const text = await fleet([job("a"), job("b", { isolated: false })]);
		expect(text).toContain(`runs the harness from ${place.own}`);
		expect(started).toEqual([]);
	});

	it("starts no unisolated child while the person's settings load the harness from a tree", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		place.harness = join(root, "src", "harness");
		const text = await fleet([job("a", { isolated: false })]);
		expect(text).toContain(`which name ${place.harness}`);
		expect(started).toEqual([]);
	});

	it("starts an isolated child with the fence's own extensions from the install's current version", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		await fleet([job("a")]);
		expect(each(started[0], "--extension").slice(0, PACKS.length)).toEqual(
			PACKS.map((pack) => join(place.own, "extensions", pack, "index.ts")),
		);
		expect(started[0]).toContain("--no-extensions");
		expect(given[0]).toMatchObject({ PI_SANDBOX: "fence" });
	});

	it("starts no isolated child when the install lacks the fence's own extensions", async () => {
		vi.stubEnv("PI_SANDBOX", "fence");
		rmSync(join(place.own, "extensions", "shell-workflow"), {
			recursive: true,
		});
		const text = await fleet([job("a")]);
		expect(text).toContain("needs the fence's own extensions");
		expect(started).toEqual([]);
	});

	it("fences the children of a session the first stage lists, with no PI_SANDBOX to pass on", async () => {
		vi.stubEnv("PI_SANDBOX", undefined);
		vi.stubEnv("PI_SESSION_ID", LISTED);
		listForStage(LISTED, "a test");
		await fleet([job("a", { isolated: false })]);
		expect(given[0]).toMatchObject({ PI_SANDBOX: "fence" });
		expect(started[0]).toContain("--no-approve");
	});

	it("fences an unfenced session's children once subagents join the first stage", async () => {
		joinSpawns("a test");
		const text = await fleet([
			job("a", {
				isolated: false,
				extraExtensions: [join(root, "planted.ts")],
			}),
		]);
		expect(text).toContain("planted.ts lies outside pi's installed packages");
		expect(started).toEqual([]);
	});

	it("starts an unisolated child in its sandbox, which its own extensions fence", async () => {
		vi.stubEnv("PI_SANDBOX", "strict");
		await fleet([job("a", { isolated: false })]);
		expect(given[0]).toMatchObject({ PI_SANDBOX: "strict" });
		expect(started[0]).toContain("--no-approve");
		expect(started[0]).not.toContain("--no-extensions");
		expect(
			each(started[0], "--extension").filter((path) =>
				path.includes("shell-workflow"),
			),
			"an unisolated child loads its own shell-workflow, so none is named",
		).toEqual([]);
	});

	it("leaves an unfenced session's children as they were", async () => {
		await fleet([job("a")]);
		expect(given[0]?.PI_SANDBOX).toBeUndefined();
	});
});
