/**
 * A standalone server that dies mid-session.
 *
 * The pool kept the dead server's connection and handed it to every
 * later call, which answered "Connection is closed." until the session
 * ended: 11 of 93 calls in a month. A server that is gone now leaves the
 * pool, so the next call for its root starts one afresh.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createStandaloneBackend,
	type StandaloneBackend,
} from "../../../../lib/core/lsp/index.ts";

const fixture = fileURLToPath(
	new URL("./fixtures/dying-server.mjs", import.meta.url),
);

describe("a standalone server that dies", () => {
	let dir: string;
	let file: string;
	let log: string;
	let backend: StandaloneBackend | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-dying-"));
		writeFileSync(join(dir, "root.marker"), "");
		file = join(dir, "one.dying");
		writeFileSync(file, "nothing here\n");
		log = join(dir, "starts.log");
		backend = createStandaloneBackend({
			servers: {
				dying: {
					name: "dying",
					command: process.execPath,
					args: [fixture, log],
					fileTypes: [".dying"],
					rootMarkers: ["root.marker"],
				},
			},
		});
	});

	afterEach(async () => {
		await backend?.dispose();
		backend = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const hover = () =>
		backend?.hover({ path: file, position: { line: 1, character: 0 } });

	it("is replaced by a fresh one on the next call", async () => {
		await expect(hover()).rejects.toThrow();

		const answer = await hover();

		expect(JSON.stringify(answer)).toContain("alive");
		expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(
			2,
		);
	}, 15_000);
});
