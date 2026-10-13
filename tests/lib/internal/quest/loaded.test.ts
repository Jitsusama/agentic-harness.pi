/**
 * Which quest a session has loaded, read off the session registry.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { questLoadedIn } from "../../../../lib/internal/quest/loaded.ts";

/** A registry directory holding the given records by session id. */
async function registry(records: Record<string, unknown>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "quest-loaded-"));
	for (const [id, record] of Object.entries(records)) {
		await writeFile(join(dir, `${id}.json`), JSON.stringify(record), "utf8");
	}
	return dir;
}

/** A record the way the quest workflow writes one. */
function record(sessionId: string, quest?: string): Record<string, unknown> {
	return {
		sessionId,
		instanceId: "instance",
		cwd: "/work",
		openedAt: "2026-10-12T00:00:00.000Z",
		...(quest === undefined ? {} : { quest }),
	};
}

describe("the quest a session has loaded", () => {
	it("is the quest its record names", async () => {
		const dir = await registry({ s1: record("s1", "QEST-20261012-9JKNEV") });

		expect(await questLoadedIn("s1", dir)).toBe("QEST-20261012-9JKNEV");
	});

	it("is none once the session has put its quest down", async () => {
		const dir = await registry({ s1: record("s1") });

		expect(await questLoadedIn("s1", dir)).toBeUndefined();
	});

	it("is none for a session the registry never saw", async () => {
		const dir = await registry({});

		expect(await questLoadedIn("s1", dir)).toBeUndefined();
	});

	it("is none for a record that will not parse", async () => {
		const dir = await registry({});
		await writeFile(join(dir, "s1.json"), "{not json", "utf8");

		expect(await questLoadedIn("s1", dir)).toBeUndefined();
	});

	it("never reads outside the registry for an id with a path in it", async () => {
		const dir = await registry({ s1: record("s1", "QEST-1") });

		expect(await questLoadedIn("../s1", join(dir, "sub"))).toBeUndefined();
	});
});
