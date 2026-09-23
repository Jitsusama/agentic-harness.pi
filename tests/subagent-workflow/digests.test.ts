import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestFleetRuns } from "../../extensions/subagent-workflow/digests.ts";

const turn = (total: number, text = "answer") =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { cost: { total } },
			content: [{ type: "text", text }],
		},
	});
const session = JSON.stringify({ type: "session", id: "s", cwd: "/w" });

let root: string;
let runs: string;
let digests: string;

async function subagent(
	runId: string,
	id: string,
	files: Record<string, string | Buffer>,
): Promise<string> {
	const dir = join(runs, runId, "reviewers", id);
	await mkdir(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		await writeFile(join(dir, name), body);
	}
	return dir;
}

async function readDigest(runId: string, id: string) {
	const text = await readFile(join(digests, runId, `${id}.jsonl`), "utf8");
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "fleet-digests-"));
	runs = join(root, "runs");
	digests = join(root, "digests");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("digestFleetRuns", () => {
	it("writes a digest for a finished subagent before anything sweeps it", async () => {
		await subagent("fleet-1", "a", {
			"events.ndjson": `${session}\n${turn(0.5)}\n`,
			"result.json": JSON.stringify({
				exitCode: 0,
				usage: { cost: { total: 0.5 } },
			}),
		});

		const outcome = await digestFleetRuns(runs, digests);

		expect(outcome.written).toBe(1);
		const [header, ...records] = await readDigest("fleet-1", "a");
		expect(header.kind).toBe("header");
		expect(header.result.usage.cost.total).toBe(0.5);
		expect(records.some((r) => r.kind === "assistant")).toBe(true);
	});

	it("reads rotated segments oldest first, joined before splitting lines", async () => {
		// The supervisor rotates between stdout chunks, not between lines,
		// so one event can straddle two segments. Reading only the current
		// segment lost the head of 28 real streams and $486 of cost.
		const whole = `${session}\n${turn(1)}\n${turn(2)}\n${turn(3)}\n`;
		const cut1 = whole.indexOf(turn(2)) + 10;
		const cut2 = whole.indexOf(turn(3)) + 5;
		await subagent("fleet-1", "a", {
			"events.ndjson.2.gz": gzipSync(whole.slice(0, cut1)),
			"events.ndjson.1.gz": gzipSync(whole.slice(cut1, cut2)),
			"events.ndjson": whole.slice(cut2),
			"result.json": JSON.stringify({ exitCode: 0 }),
		});

		await digestFleetRuns(runs, digests);

		const [header, ...records] = await readDigest("fleet-1", "a");
		const costs = records
			.filter((r) => r.kind === "assistant")
			.map((r) => r.usage.cost.total);
		expect(costs).toEqual([1, 2, 3]);
		expect(header.coverage.unparseable).toBe(0);
	});

	it("leaves a digest alone when its stream has not changed since", async () => {
		const dir = await subagent("fleet-1", "a", {
			"events.ndjson": `${turn(1)}\n`,
			"result.json": "{}",
		});
		await digestFleetRuns(runs, digests);
		const past = new Date(Date.now() - 60_000);
		await utimes(join(dir, "events.ndjson"), past, past);

		const again = await digestFleetRuns(runs, digests);

		expect(again.written).toBe(0);
		expect(again.current).toBe(1);
	});

	it("names a run it could not digest, so the sweep can spare it", async () => {
		// Capture before delete: a stream that could not be digested is
		// still the only copy of what that subagent did.
		await subagent("fleet-bad", "a", {
			"events.ndjson.1.gz": Buffer.from("not gzip at all"),
			"events.ndjson": `${turn(1)}\n`,
		});
		await subagent("fleet-good", "a", { "events.ndjson": `${turn(1)}\n` });

		const outcome = await digestFleetRuns(runs, digests);

		expect(outcome.failed).toEqual(new Set(["fleet-bad"]));
		expect(outcome.written).toBe(1);
	});

	it("does nothing, and says so, when there are no runs yet", async () => {
		const outcome = await digestFleetRuns(runs, digests);

		expect(outcome).toMatchObject({ written: 0, current: 0 });
		expect(outcome.failed.size).toBe(0);
	});
});
