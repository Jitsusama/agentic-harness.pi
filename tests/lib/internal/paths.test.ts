import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cacheDir,
	configDir,
	dataDir,
	sessionsDir,
	stateDir,
} from "../../../lib/internal/paths";

interface XdgCase {
	name: string;
	fn: (slug: string) => string;
	envVar: string;
	defaultSegments: string[];
}

const CASES: XdgCase[] = [
	{
		name: "configDir",
		fn: configDir,
		envVar: "XDG_CONFIG_HOME",
		defaultSegments: [".config"],
	},
	{
		name: "dataDir",
		fn: dataDir,
		envVar: "XDG_DATA_HOME",
		defaultSegments: [".local", "share"],
	},
	{
		name: "stateDir",
		fn: stateDir,
		envVar: "XDG_STATE_HOME",
		defaultSegments: [".local", "state"],
	},
	{
		name: "cacheDir",
		fn: cacheDir,
		envVar: "XDG_CACHE_HOME",
		defaultSegments: [".cache"],
	},
];

for (const { name, fn, envVar, defaultSegments } of CASES) {
	describe(name, () => {
		let original: string | undefined;

		beforeEach(() => {
			original = process.env[envVar];
		});

		afterEach(() => {
			if (original === undefined) delete process.env[envVar];
			else process.env[envVar] = original;
		});

		it(`scopes the slug under pi/agentic-harness.pi/ when ${envVar} is set`, () => {
			// Two pi packages on the same machine must not
			// share these directories. The
			// agentic-harness.pi segment is the boundary
			// that keeps them apart.
			process.env[envVar] = "/var/xdg-test";
			expect(fn("quest-workflow")).toBe(
				"/var/xdg-test/pi/agentic-harness.pi/quest-workflow",
			);
		});

		it(`falls back to the spec default when ${envVar} is unset`, () => {
			delete process.env[envVar];
			expect(fn("quest-workflow")).toBe(
				join(
					homedir(),
					...defaultSegments,
					"pi",
					"agentic-harness.pi",
					"quest-workflow",
				),
			);
		});

		it(`treats ${envVar}="" the same as unset`, () => {
			// An empty value must not yield a cwd-relative
			// path. Per the XDG spec, empty == unset.
			process.env[envVar] = "";
			expect(fn("quest-workflow")).toBe(
				join(
					homedir(),
					...defaultSegments,
					"pi",
					"agentic-harness.pi",
					"quest-workflow",
				),
			);
		});

		it("isolates one consumer from its siblings", () => {
			process.env[envVar] = "/var/xdg-test";
			const a = fn("quest-workflow");
			const b = fn("people");
			expect(a).not.toBe(b);
			expect(a).toMatch(/\/quest-workflow$/);
			expect(b).toMatch(/\/people$/);
		});
	});
}

describe("XDG kinds do not collide", () => {
	// All four kinds for the same slug must land in
	// distinct directories. A consumer that writes a cache
	// file must not stomp on its data file just because
	// the user did not set their XDG vars.

	beforeEach(() => {
		for (const { envVar } of CASES) delete process.env[envVar];
	});

	it("produces distinct directories for the same slug across kinds", () => {
		const paths = new Set<string>();
		for (const { fn } of CASES) paths.add(fn("quest-workflow"));
		expect(paths.size).toBe(CASES.length);
	});
});

describe("sessionsDir", () => {
	it("resolves the pi session store under the home dir", () => {
		expect(sessionsDir("/home/u")).toBe(
			join("/home/u", ".pi", "agent", "sessions"),
		);
	});
});
