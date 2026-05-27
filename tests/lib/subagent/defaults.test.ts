import { afterEach, describe, expect, it } from "vitest";
import {
	clearSubagentDefaults,
	getSubagentDefaults,
	type RunPi,
	registerSubagentDefaultExtension,
	registerSubagentDefaultSkill,
	runReviewer,
} from "../../../lib/subagent";

// The registry is process-global on purpose so a
// Shopify-style credentials extension can register once
// at activation and have every later subagent run pick
// the path up. The tests below pin that promise: the
// registry round-trips, dedupes, hands a deterministic
// snapshot back, and `runReviewer` injects the registered
// paths into its `--extension` / `--skill` argv even when
// the per-call options pass nothing of their own.

function recordingRunPi(): {
	runPi: RunPi;
	calls: Array<{ args: readonly string[] }>;
} {
	const calls: Array<{ args: readonly string[] }> = [];
	const runPi: RunPi = async ({ args }) => {
		calls.push({ args });
		return {
			exitCode: 0,
			lines: [],
			finalAssistantText: "ok",
			stderr: "",
			warnings: [],
		};
	};
	return { runPi, calls };
}

describe("subagent defaults registry", () => {
	afterEach(() => {
		clearSubagentDefaults();
	});

	it("round-trips registered extensions and skills", () => {
		// The snapshot returned by getSubagentDefaults must
		// reflect what was registered, in insertion order.
		// Insertion order matters because composeArgs emits
		// `--extension a --extension b` in that sequence;
		// pi's load order is observable to callers.
		registerSubagentDefaultExtension("/abs/a.ts");
		registerSubagentDefaultExtension("/abs/b.ts");
		registerSubagentDefaultSkill("/abs/x.md");
		const snapshot = getSubagentDefaults();
		expect(snapshot.extensions).toEqual(["/abs/a.ts", "/abs/b.ts"]);
		expect(snapshot.skills).toEqual(["/abs/x.md"]);
	});

	it("deduplicates repeated registrations", () => {
		// The same extension path registered twice (e.g. two
		// pi extensions both pointing at the same shared
		// credentials helper) collapses to a single load —
		// pi would otherwise be told to load it twice.
		registerSubagentDefaultExtension("/abs/auth.ts");
		registerSubagentDefaultExtension("/abs/auth.ts");
		registerSubagentDefaultSkill("/abs/conv.md");
		registerSubagentDefaultSkill("/abs/conv.md");
		const snapshot = getSubagentDefaults();
		expect(snapshot.extensions).toEqual(["/abs/auth.ts"]);
		expect(snapshot.skills).toEqual(["/abs/conv.md"]);
	});

	it("clearSubagentDefaults empties the registry", () => {
		registerSubagentDefaultExtension("/abs/a.ts");
		registerSubagentDefaultSkill("/abs/x.md");
		clearSubagentDefaults();
		expect(getSubagentDefaults()).toEqual({ extensions: [], skills: [] });
	});
});

describe("runReviewer + defaults integration", () => {
	afterEach(() => {
		clearSubagentDefaults();
	});

	it("injects registered defaults into --extension / --skill argv", async () => {
		// The whole point of the registry: a subagent
		// spawned without any per-call `extraExtensions` /
		// `extraSkills` must still receive the registered
		// defaults via pi's flags. This is what lets a
		// Shopify credentials extension survive an
		// `isolated: true` run.
		registerSubagentDefaultExtension("/abs/auth.ts");
		registerSubagentDefaultSkill("/abs/conv.md");
		const { runPi, calls } = recordingRunPi();
		await runReviewer({
			reviewer: { id: "r" },
			prompt: "hi",
			cwd: "/tmp",
			runPi,
		});
		const args = calls[0].args.join(" ");
		expect(args).toContain("--extension /abs/auth.ts");
		expect(args).toContain("--skill /abs/conv.md");
	});

	it("merges defaults with per-call extras without duplicating shared paths", async () => {
		// If a caller passes a path that's also registered
		// as a default, the engine emits one `--extension`
		// for it, not two. Pi loading the same extension
		// twice would either fail or double-register tools.
		registerSubagentDefaultExtension("/abs/auth.ts");
		registerSubagentDefaultExtension("/abs/telemetry.ts");
		const { runPi, calls } = recordingRunPi();
		await runReviewer({
			reviewer: { id: "r" },
			prompt: "hi",
			cwd: "/tmp",
			runPi,
			extraExtensions: ["/abs/auth.ts", "/abs/verify.ts"],
		});
		const args = calls[0].args;
		const extensions = args.filter(
			(_, i) => i > 0 && args[i - 1] === "--extension",
		);
		expect(extensions).toEqual([
			"/abs/auth.ts",
			"/abs/telemetry.ts",
			"/abs/verify.ts",
		]);
	});

	it("preserves defaults even when the caller passes no extras", async () => {
		// Without an explicit `extraExtensions` array, the
		// merge still has to fire and emit the registered
		// defaults. Catches the easy regression where the
		// merge is gated on `options.extraExtensions` being
		// truthy.
		registerSubagentDefaultExtension("/abs/auth.ts");
		const { runPi, calls } = recordingRunPi();
		await runReviewer({
			reviewer: { id: "r" },
			prompt: "hi",
			cwd: "/tmp",
			runPi,
		});
		expect(calls[0].args.join(" ")).toContain("--extension /abs/auth.ts");
	});

	it("emits no --extension / --skill flags when nothing is registered or passed", async () => {
		// With an empty registry and no per-call extras pi
		// should see a clean argv — no spurious flag pairs
		// that would force pi to consume the next token as
		// a path.
		const { runPi, calls } = recordingRunPi();
		await runReviewer({
			reviewer: { id: "r" },
			prompt: "hi",
			cwd: "/tmp",
			runPi,
		});
		const args = calls[0].args;
		expect(args).not.toContain("--extension");
		expect(args).not.toContain("--skill");
	});

	it("defaults survive --no-extensions / --no-skills under isolated", async () => {
		// `isolated: true` strips ambient inheritance via
		// the three --no-* flags, but pi still honours
		// explicit `--extension` / `--skill` injections
		// AFTER those flags. The registry's whole purpose is
		// to exploit that: registered paths must show up in
		// argv alongside the --no-* flags.
		registerSubagentDefaultExtension("/abs/auth.ts");
		const { runPi, calls } = recordingRunPi();
		await runReviewer({
			reviewer: { id: "r" },
			prompt: "hi",
			cwd: "/tmp",
			isolated: true,
			runPi,
		});
		const args = calls[0].args.join(" ");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--extension /abs/auth.ts");
	});
});
