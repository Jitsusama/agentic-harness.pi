/**
 * A host's record read with a fence no harness here knows leaves that
 * session's fence unsaid, so the node refuses its carry, while the host
 * and its sessions still read as running for the one-writer guard.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostRegistries } from "../../../lib/core/session/registry.ts";

const owner = { pid: 123, startedAt: 1000, bootId: "boot", startTicks: 20 };
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function session(id: string, fence?: unknown) {
	const said = { id, state: "idle", since: new Date(0).toISOString() };
	return fence === undefined ? said : { ...said, fence };
}

it("leaves unsaid only the fence no harness here knows", () => {
	const dir = mkdtempSync(join(tmpdir(), "registry-fence-"));
	directories.push(dir);
	writeFileSync(
		join(dir, "1-1.json"),
		JSON.stringify({
			key: "k",
			owner,
			sessions: [
				session("a", "vm"),
				session("b", "fence"),
				session("c"),
				session("d", 7),
			],
		}),
	);
	const [read] = hostRegistries(dir);
	expect(
		Object.fromEntries(
			(read?.sessions ?? []).map(({ id, fence }) => [id, fence ?? "unsaid"]),
		),
	).toEqual({ a: "unsaid", b: "fence", c: "unsaid", d: "unsaid" });
	expect(read?.sessions.map(({ id }) => id).sort()).toEqual([
		"a",
		"b",
		"c",
		"d",
	]);
});
