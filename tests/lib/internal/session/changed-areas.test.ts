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

	it("reads three folders under modules and areas, where a zone or module sits that deep", () => {
		expect(
			areasOf([
				"modules/quickshell/launcher/Launcher.qml",
				"areas/tools/gitstream/src/main.rs",
			]),
		).toEqual(["modules/quickshell/launcher", "areas/tools/gitstream"]);
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

	it("names none for tests, docs, the repository's own config or its root", () => {
		expect(
			areasOf([
				"tests/lib/mesh/peer.test.ts",
				"docs/architecture.md",
				".github/dependabot.yml",
				".pi/skills/x/SKILL.md",
				"AGENTS.md",
				"lib/README.md",
				"src/main.rs",
			]),
		).toEqual([]);
	});

	it("puts the areas most files changed in first, and keeps at most a bounded number", () => {
		expect(
			areasOf(["lib/ui/a.ts", "lib/mesh/a.ts", "lib/mesh/b.ts"]),
		).toEqual(["lib/mesh", "lib/ui"]);
		const sweep = Array.from(
			{ length: MOST_AREAS + 5 },
			(_, i) => `extensions/e${i}/index.ts`,
		);
		expect(areasOf(sweep)).toHaveLength(MOST_AREAS);
	});
});
