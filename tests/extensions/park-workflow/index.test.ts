/**
 * Park Workflow as pi loads it: the pi a restart in place became takes
 * back the park that restart said, before any session starts.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import parkWorkflow from "../../../extensions/park-workflow/index.ts";
import {
	PARK_SAID_ENV,
	PARKED_ENV,
	WAKE_ENV,
} from "../../../lib/internal/session/park.ts";
import { fakePi } from "../../support/fake-pi.ts";

let folder: string;
let parked: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-load-"));
	parked = join(folder, "held.parked");
	// Its holder runs this very process, and its park is said.
	writeFileSync(
		join(folder, "held.json"),
		JSON.stringify({ pid: process.pid }),
	);
	writeFileSync(parked, "");
	vi.stubEnv(WAKE_ENV, join(folder, "held.wake"));
	vi.stubEnv(PARKED_ENV, parked);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(folder, { recursive: true, force: true });
});

describe("park workflow as it loads", () => {
	it("takes back the park a restart in place of this process said", () => {
		vi.stubEnv(PARK_SAID_ENV, String(process.pid));

		parkWorkflow(fakePi());

		expect(existsSync(parked), "up again, it hasn't parked").toBe(false);
		expect(process.env[PARK_SAID_ENV], "forgotten").toBe(undefined);
	});

	// One-writer's hand-over may have said a real park for this window.
	it("leaves a park no restart said", () => {
		parkWorkflow(fakePi());

		expect(readFileSync(parked, "utf8"), "a park stands").toBe("");
	});
});
