/**
 * A fenced session's reviewers start while this package and every
 * extension registered as a subagent's default lie where no fenced
 * command writes, and not while one doesn't: driven with the package's
 * place stubbed, since these tests themselves run from a tree.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewersRefused } from "../../../../extensions/review-integration/tools/ask-reviewer.ts";
import {
	clearSubagentDefaults,
	registerSubagentDefaultExtension,
} from "../../../../lib/subagent/defaults.ts";

/** Where this package runs from and where pi's packages are installed. */
const place = vi.hoisted(() => ({ own: "", root: "" }));

vi.mock(
	"../../../../lib/internal/fence/installed-only.ts",
	async (
		importOriginal: () => Promise<
			typeof import("../../../../lib/internal/fence/installed-only.ts")
		>,
	) => {
		const real = await importOriginal();
		return {
			...real,
			fencedChildrenRefusal: (
				unisolated: boolean,
				defaults: readonly string[],
			) =>
				real.fencedChildrenRefusal(unisolated, defaults, {
					root: place.root,
					own: place.own,
					harness: () => place.own,
					held: [],
				}),
		};
	},
);

let home: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "reviewers-install-")));
	place.root = join(home, ".local", "share", "pi-packages");
	place.own = join(place.root, "harness", "versions", "a");
	mkdirSync(place.own, { recursive: true });
	vi.stubEnv("PI_SANDBOX", "strict");
});

afterEach(() => {
	clearSubagentDefaults();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("a fenced session's reviewers", () => {
	it("start while it runs the installed package", () => {
		expect(reviewersRefused()).toBeUndefined();
	});

	it("start while every registered default is installed", () => {
		const pack = join(place.root, "mesh", "index.ts");
		mkdirSync(join(place.root, "mesh"));
		writeFileSync(pack, "");
		registerSubagentDefaultExtension(pack);
		expect(reviewersRefused()).toBeUndefined();
	});

	it("don't start while a registered default lies in a tree, naming it", () => {
		const stray = join(home, "src", "mesh.ts");
		mkdirSync(join(home, "src"));
		writeFileSync(stray, "");
		registerSubagentDefaultExtension(stray);
		const refused = reviewersRefused();
		expect(refused).toMatch(/^No reviewer started: An extension registered/);
		expect(refused).toContain(stray);
	});
});
