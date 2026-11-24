/** Which conversations a host moves into children, as its file says. */
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChildPolicy,
	watchedChildPolicy,
} from "../../../host/service/child-policy.ts";
import { until } from "../../support/until.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";

let dir: string;
let file: string;
let policy: ChildPolicy | undefined;
let report: ReturnType<typeof vi.fn<(error: unknown) => void>>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "child-policy-"));
	file = join(dir, "children.json");
	report = vi.fn();
});
afterEach(async () => {
	policy?.close();
	policy = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function written(value: unknown): Promise<void> {
	await writeFile(file, `${JSON.stringify(value)}\n`);
}

describe("a host's child policy", () => {
	it("moves nothing while it has no file", async () => {
		policy = await watchedChildPolicy(file, report);

		expect(policy.moves(a), "a conversation moved").toBe(false);
		expect(policy.opens(), "an open went to a child").toBe(false);
		expect(report).not.toHaveBeenCalled();
	});

	it("moves every conversation, opens among them, when it says all", async () => {
		await written({ v: 1, all: true, sessions: [] });
		policy = await watchedChildPolicy(file, report);

		expect(policy.moves(a), "a conversation stayed").toBe(true);
		expect(policy.opens(), "an open stayed in the host").toBe(true);
	});

	it("moves only the conversations it names, and opens none", async () => {
		await written({ v: 1, all: false, sessions: [a] });
		policy = await watchedChildPolicy(file, report);

		expect(policy.moves(a), "the one it names stayed").toBe(true);
		expect(policy.moves(b), "one it doesn't name moved").toBe(false);
		expect(policy.opens(), "an open went to a child").toBe(false);
	});

	it("keeps a warm spare only when it says so, which a file of before leaves off", async () => {
		await written({ v: 1, all: true, sessions: [] });
		policy = await watchedChildPolicy(file, report);
		expect(policy.spares?.(), "a spare kept unasked").toBe(false);

		await written({ v: 1, all: true, spares: true });
		await until("it keeps a spare", () => policy?.spares?.() === true);
		expect(report).not.toHaveBeenCalled();
	});

	it("follows its file as it changes, with no restart", async () => {
		policy = await watchedChildPolicy(file, report);
		await written({ v: 1, all: false, sessions: [a] });
		await until("the named one moves", () => policy?.moves(a) === true);

		await written({ v: 1, all: false, sessions: [] });
		await until("it moves back", () => policy?.moves(a) === false);
	});

	it("moves nothing, and says why, when it can't read its file", async () => {
		await writeFile(file, "{ all: true");
		policy = await watchedChildPolicy(file, report);

		expect(policy.moves(a), "a conversation moved").toBe(false);
		expect(report).toHaveBeenCalledOnce();
	});

	it("follows a file written whole and renamed into place", async () => {
		policy = await watchedChildPolicy(file, report);
		const beside = join(dir, "children.json.new");
		await writeFile(beside, JSON.stringify({ v: 1, sessions: [a] }));
		await rename(beside, file);

		await until("the named one moves", () => policy?.moves(a) === true);
	});

	it("moves nothing once its file is deleted", async () => {
		await written({ v: 1, sessions: [a] });
		policy = await watchedChildPolicy(file, report);
		await rm(file);

		await until("it moves back", () => policy?.moves(a) === false);
		expect(report, "a missing file is no fault").not.toHaveBeenCalled();
	});

	it("keeps what it last read while its file is half written", async () => {
		await written({ v: 1, sessions: [a] });
		policy = await watchedChildPolicy(file, report);
		await writeFile(file, "");
		await until("it says it can't read it", () => report.mock.calls.length > 0);

		expect(policy.moves(a), "the last read stands").toBe(true);
	});

	it("names only conversation ids", async () => {
		await written({ v: 1, sessions: ["../elsewhere"] });
		policy = await watchedChildPolicy(file, report);

		expect(policy.moves("../elsewhere"), "a path moved").toBe(false);
		expect(report).toHaveBeenCalledOnce();
	});

	it("moves nothing, and never fails, when its folder can't be made", async () => {
		const blocking = join(dir, "a-file");
		await writeFile(blocking, "");
		policy = await watchedChildPolicy(join(blocking, "children.json"), report);

		expect(policy.moves(a), "a conversation moved").toBe(false);
		expect(String(report.mock.calls[0]?.[0])).toContain("can't be watched");
	});
});
