/**
 * The host beside plain pi, both from one install and loading this tree's
 * own extensions: six scenarios, each recorded on both sides, must send the
 * provider the same requests and show pi's extensions the same events. The
 * one difference allowed is the host's by being the host: the harness
 * journal confirms each turn durable. Each scenario also checks, on plain
 * pi, that it did what it is for, so two sides that both skip it can't pass.
 *
 * It needs a pi built with the host's patches, found as
 * tests/host/end-to-end/support/host-pi.ts finds it; without one each
 * scenario is skipped saying how to get one, and fails under `pnpm
 * test:host`. PI_PARITY_EXTENSIONS may
 * name a file listing more extension paths, one a line, to load on both
 * sides as well, and PI_PARITY_ROOT a folder to record under and keep, for
 * reading what differed. Run it before merging a change to host/, with
 * `pnpm test:host`, or on one build:
 *
 *   PI_HOST_PACKAGE_DIR=<root> pnpm exec vitest run --project process \
 *     tests/host/parity/parity.test.ts
 */
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";
import { compareRecordings, expectedOfTheHost } from "./compare.ts";
import { SCENARIOS, type Scenario } from "./mock-provider.ts";
import { type Recording, record } from "./record.ts";

/** Two recordings of a scenario, each loading every extension, on a loaded machine. */
const SCENARIO_MS = 900_000;

const EXTENSIONS_DIR = fileURLToPath(
	new URL("../../../extensions/", import.meta.url),
);

/** This tree's extensions, then any the environment lists, each past its symlinks. */
function extensions(): string[] {
	const own = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(EXTENSIONS_DIR, entry.name))
		.sort();
	const listed = process.env.PI_PARITY_EXTENSIONS;
	const more = listed
		? readFileSync(listed, "utf8").split("\n").filter(Boolean)
		: [];
	return [...own, ...more].map((path) => realpathSync(path));
}

/** The trace's events of a type. */
function eventsOf(
	recording: Recording,
	type: string,
): Readonly<Record<string, unknown>>[] {
	return recording.trace.filter((event) => event.type === type);
}

/** The names of the tools a request declared. */
function declared(recording: Recording): unknown[] {
	const tools = recording.requests.at(0)?.tools;
	return Array.isArray(tools)
		? tools.map((tool: unknown) =>
				tool !== null && typeof tool === "object"
					? Reflect.get(tool, "name")
					: undefined,
			)
		: [];
}

/** Whether a request's messages mention a text. */
function mentions(recording: Recording, index: number, text: string): boolean {
	return JSON.stringify(recording.requests.at(index)?.messages).includes(text);
}

/** What each scenario is for, checked on plain pi's recording. */
function didItsPart(recording: Recording, scenario: Scenario): void {
	const registry = eventsOf(recording, "tool_registry").at(0);
	expect(registry, "the probe saw pi's tools").toBeDefined();
	if (scenario === "command") {
		expect(recording.requests, "a command asks no model").toEqual([]);
		expect(eventsOf(recording, "command_executed")).toHaveLength(1);
		return;
	}
	const tools = declared(recording);
	expect(tools, "the provider was told of the read tool").toContain("read");
	expect(
		[...tools].sort(),
		"the provider was told of exactly the active tools",
	).toEqual(Array.isArray(registry?.active) ? [...registry.active].sort() : []);
	const settled = eventsOf(recording, "agent_settled").at(-1);
	if (scenario === "abort") {
		expect(settled?.aborted, "the run was aborted").toBe(true);
		return;
	}
	expect(settled?.aborted, "the run finished").toBe(false);
	if (scenario === "tool") {
		expect(recording.requests).toHaveLength(2);
		expect(
			eventsOf(recording, "tool_execution_end").some(
				(event) => event.isError === false,
			),
			"the tool ran",
		).toBe(true);
	}
	if (scenario === "steer") {
		expect(recording.requests).toHaveLength(2);
		expect(
			mentions(recording, 1, "Steering instruction: retain fixture."),
			"the steer reached the next request",
		).toBe(true);
	}
	if (scenario === "compaction") {
		expect(recording.requests).toHaveLength(3);
		expect(eventsOf(recording, "session_compact")).toHaveLength(1);
		expect(
			mentions(recording, 2, "## Goal"),
			"the summary reached the next request",
		).toBe(true);
	}
}

describe("the host beside plain pi", () => {
	// pi works in the folder's own path, past any symlink, and says it.
	const kept = process.env.PI_PARITY_ROOT;
	const root = kept
		? realpathSync(kept)
		: mkdtempSync(join(realpathSync(tmpdir()), "host-parity-"));
	afterAll(() => {
		if (!kept) rmSync(root, { recursive: true, force: true });
	});

	for (const scenario of SCENARIOS)
		it(
			`${scenario}: sends the provider what pi sends and shows extensions what pi shows`,
			async ({ skip }) => {
				const packageDir = hostPiFor(skip);
				const options = {
					root,
					scenario,
					packageDir,
					extensions: extensions(),
				};
				const pi = await record({ ...options, side: "pi" });
				didItsPart(pi, scenario);
				const hosted = await record({ ...options, side: "hosted" });
				for (const [side, dir] of [
					["pi", pi.dir],
					["hosted", hosted.dir],
				] as const) {
					const read = (name: string) => {
						try {
							return readFileSync(join(dir, name), "utf8");
						} catch {
							// scratch: a side that wrote none says so
							return "(none)\n";
						}
					};
					for (const line of read("requests.ndjson.headers")
						.split("\n")
						.filter(Boolean))
						process.stdout.write(
							`=== HEADERS ${scenario} ${side} ${line}\n`,
						);
					process.stdout.write(
						`=== LEDGER ${scenario} ${side}\n${read("ledger.ndjson")}`,
					);
				}
				const unexpected = compareRecordings(
					pi.dir,
					hosted.dir,
					scenario !== "command",
				).filter((difference) => !expectedOfTheHost(difference));
				expect(
					unexpected,
					`how the host differs from pi, beyond its durable journal (recorded under ${root})`,
				).toEqual([]);
			},
			SCENARIO_MS,
		);
});
