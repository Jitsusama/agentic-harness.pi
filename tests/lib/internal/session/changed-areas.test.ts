import { describe, expect, it } from "vitest";
import {
	areasOf,
	MOST_AREAS,
} from "../../../../lib/internal/session/changed-areas.ts";

describe("the areas a change touched", () => {
	it("names each file by its first two folders, once each", () => {
		expect(
			areasOf([
				"extensions/review-integration/tools/offer-merge.ts",
				"extensions/review-integration/queued.ts",
				"lib/mesh/peer.ts",
			]),
		).toEqual(["extensions/review-integration", "lib/mesh"]);
	});

	it("reads three folders under modules, where a module sits that deep", () => {
		expect(areasOf(["modules/quickshell/launcher/Launcher.qml"])).toEqual([
			"modules/quickshell/launcher",
		]);
	});

	// FZ9MFJ, 25 November: World's zones would be said as shopify or dev,
	// words many needs carry, and no World landing has been measured.
	it("names none for World's zones, until their landings are measured", () => {
		expect(
			areasOf([
				"areas/core/shopify/app/models/shop.rb",
				"areas/tools/dev/lib/dev.rb",
			]),
		).toEqual([]);
	});

	it("climbs past a folder that says how code is laid out, not what it is about", () => {
		expect(
			areasOf([
				"modules/quickshell/checks/run.sh",
				"modules/wifid/daemon/main.rs",
				"src/node/hub.rs",
			]),
		).toEqual(["modules/quickshell", "modules/wifid", "src/node"]);
	});

	// The council, 25 November: `lib/internal/session` climbed to `lib`
	// and named nothing, so a whole tree of the harness said no area.
	it("reaches down past layout folders when climbing would leave only the top", () => {
		expect(
			areasOf([
				"lib/internal/session/landings.ts",
				"src/lib/routing/mod.rs",
				"lib/internal/state.ts",
			]),
		).toEqual(["lib/internal/session", "src/lib/routing"]);
	});

	it("names none for tests, docs, the repository's own config or its root", () => {
		expect(
			areasOf([
				"tests/lib/mesh/peer.test.ts",
				"docs/architecture.md",
				".github/dependabot.yml",
				".pi/skills/x/SKILL.md",
				".config/tool/settings.json",
				"spec/models/shop_spec.rb",
				'"lib/mesh/odd\\tname.ts"',
				"AGENTS.md",
				"lib/README.md",
				"src/main.rs",
			]),
		).toEqual([]);
	});

	it("puts the areas most files changed in first, and keeps at most a bounded number", () => {
		expect(areasOf(["lib/ui/a.ts", "lib/mesh/a.ts", "lib/mesh/b.ts"])).toEqual([
			"lib/mesh",
			"lib/ui",
		]);
		const sweep = Array.from(
			{ length: MOST_AREAS + 5 },
			(_, i) => `extensions/e${i}/index.ts`,
		);
		expect(areasOf(sweep)).toHaveLength(MOST_AREAS);
	});

	it("keeps the area most files changed in when a sweep names it last", () => {
		const sweep = [
			...Array.from(
				{ length: MOST_AREAS + 5 },
				(_, i) => `extensions/e${i}/index.ts`,
			),
			"lib/mesh/a.ts",
			"lib/mesh/b.ts",
		];

		expect(areasOf(sweep)[0]).toBe("lib/mesh");
	});
});
