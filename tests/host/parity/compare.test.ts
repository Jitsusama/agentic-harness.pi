import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	alignedEvents,
	compareRecordings,
	differences,
	expectedOfTheHost,
	normalise,
} from "./compare.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** Two recordings of one scenario that match, for a test to spoil. */
function recordings(): { expected: string; actual: string } {
	const root = mkdtempSync(join(tmpdir(), "parity-compare-"));
	roots.push(root);
	const expected = join(root, "pi");
	const actual = join(root, "hosted");
	for (const dir of [expected, actual]) {
		mkdirSync(dir);
		writeFileSync(join(dir, "trace.ndjson"), '{"type":"turn_end"}\n');
		writeFileSync(
			join(dir, "requests.ndjson"),
			'{"body":{"tools":[{"name":"read"}]}}\n',
		);
	}
	return { expected, actual };
}

it("finds nothing between matching values", () => {
	expect(
		differences({ tools: [{ name: "read" }] }, { tools: [{ name: "read" }] }),
	).toEqual([]);
});

it("sets ids and times aside without hiding a broken reference", () => {
	const a = [
		{ id: "abcd1234", timestamp: 1 },
		{ parentId: "abcd1234", timestamp: 2 },
	];
	const b = [
		{ id: "dcba4321", timestamp: 9 },
		{ parentId: "dcba4321", timestamp: 10 },
	];
	expect(normalise(a, [])).toEqual(normalise(b, []));
	const broken = [b.at(0), { parentId: "eeee3333", timestamp: 10 }];
	expect(normalise(a, [])).not.toEqual(normalise(broken, []));
});

it("sets a model call's timing entry aside but keeps how it stopped", () => {
	const call = (of: number, preparedMs: number, firstTokenMs: number) => ({
		customType: "harness-call",
		data: { v: 1, of, preparedMs, firstTokenMs, stopReason: "stop" },
	});
	expect(normalise(call(1_794_469_266_736, 43, 67), [])).toEqual(
		normalise(call(1_794_469_288_751, 137, 64), []),
	);
	const stopped = {
		...call(1, 2, 3),
		data: { ...call(1, 2, 3).data, stopReason: "aborted" },
	};
	expect(normalise(call(1, 2, 3), [])).not.toEqual(normalise(stopped, []));
});

it("labels each side's own folders and ports alike", () => {
	const a = { path: "/a/repo/fixture.txt", url: "http://127.0.0.1:4100/v1" };
	const b = { path: "/b/repo/fixture.txt", url: "http://127.0.0.1:5200/v1" };
	expect(normalise(a, [["/a/repo", "<cwd>"]])).toEqual(
		normalise(b, [["/b/repo", "<cwd>"]]),
	);
});

it("keeps cache marks and the system prompt in the comparison", () => {
	const a = {
		system: [
			{ text: "Answer", cache_control: { type: "ephemeral", ttl: "1h" } },
		],
	};
	const b = {
		system: [
			{ text: "Ignore", cache_control: { type: "ephemeral", ttl: "5m" } },
		],
	};
	expect(differences(normalise(a, []), normalise(b, []))).toHaveLength(2);
});

it("fails a host that declares every registered tool rather than the active ones", () => {
	const registered = Array.from({ length: 67 }, (_, index) => ({
		name: `tool_${index}`,
	}));
	const found = differences(
		{ tools: registered.slice(0, 23) },
		{ tools: registered },
	);
	expect(found).toContainEqual({
		path: "$.tools.length",
		expected: 23,
		actual: 67,
	});
	expect(found).toHaveLength(45);
});

it("fails missing or empty tool declarations", () => {
	const expected = { tools: [{ name: "read" }] };
	expect(differences(expected, {})).not.toEqual([]);
	expect(differences(expected, { tools: [] })).not.toEqual([]);
});

it("compares tool exposure and schemas as they are", () => {
	const tool = (exposure: string, type: string) => ({
		name: "read",
		exposure,
		parameters: { properties: { path: { type } } },
	});
	const expected = normalise({ tools: [tool("direct", "string")] }, []);
	const actual = normalise({ tools: [tool("deferred", "number")] }, []);
	expect(differences(expected, actual)).toHaveLength(2);
});

it("reads one event out of order as one missing and one extra", () => {
	const found = alignedEvents(
		[{ type: "tool_execution_end" }, { type: "turn_end" }],
		[{ type: "turn_end" }, { type: "tool_execution_end" }],
	);
	expect(found.map((difference) => difference.kind).sort()).toEqual([
		"extra-event",
		"missing-event",
	]);
});

it("keeps an abort's outcome in the comparison", () => {
	expect(differences({ aborted: true }, { aborted: false })).not.toEqual([]);
});

it("passes two matching recordings", () => {
	const { expected, actual } = recordings();
	expect(compareRecordings(expected, actual, true)).toEqual([]);
});

it("fails a missing recording rather than comparing two empty ones", () => {
	const { expected, actual } = recordings();
	rmSync(join(actual, "requests.ndjson"));
	expect(
		compareRecordings(expected, actual, true).map(
			(difference) => difference.kind,
		),
	).toContain("missing-artifact");
});

it("sets aside only the durable journal's confirmation", () => {
	expect(
		expectedOfTheHost({ path: "events[3:turn_end].journal.last.status" }),
		"the journal's confirmation is the host's own",
	).toBe(true);
	expect(
		expectedOfTheHost({ path: "events[3:turn_end].journal.size" }),
		"any other journal field still counts as a difference",
	).toBe(false);
	expect(
		expectedOfTheHost({
			path: "events[3].journal.last.status",
			kind: "missing-event",
		}),
		"a missing event is never set aside",
	).toBe(false);
});
