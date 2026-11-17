/**
 * What the engine judges of pi's session layer: a session file counts as
 * gone only when its folder says it isn't there.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFileGone } from "../../../host/engine/pi-session.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-session-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("sessionFileGone", () => {
	it("is false for a file that is there", () => {
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		expect(sessionFileGone(file), "a file on disk").toBe(false);
	});

	it("is true for a file missing from a folder that is there", () => {
		expect(sessionFileGone(join(dir, "s.jsonl")), "gone for good").toBe(true);
	});

	it("is false when the folder is missing too, as a disk not yet mounted", () => {
		expect(
			sessionFileGone(join(dir, "unmounted", "s.jsonl")),
			"can't tell, so kept",
		).toBe(false);
	});

	it("is false for a path it can't look at, as one under a file", () => {
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		expect(
			sessionFileGone(join(file, "inner.jsonl")),
			"not a folder, so kept",
		).toBe(false);
	});

	// Root looks past a folder's permissions, so only another user can test it.
	it.skipIf(process.getuid?.() === 0)(
		"is false for a file in a folder this user can't search",
		() => {
			const shut = join(dir, "shut");
			mkdirSync(shut);
			const file = join(shut, "s.jsonl");
			writeFileSync(file, "");
			chmodSync(shut, 0o000);
			try {
				expect(sessionFileGone(file), "no permission to look").toBe(false);
			} finally {
				chmodSync(shut, 0o700);
			}
		},
	);
});
