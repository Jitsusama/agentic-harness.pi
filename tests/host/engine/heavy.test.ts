/** Which running commands a draining host holds its restart for. */
import { describe, expect, it } from "vitest";
import { isHeavy } from "../../../host/engine/heavy.ts";

describe("isHeavy", () => {
	// The runs a hand restart ended on 16 November, by their labels.
	it("marks the builds, checks and suites a restart would cut", () => {
		for (const label of [
			"nix-offload there --changed",
			"cd ~/src/mycelium && nix-offload there --run checks ...",
			"bash scripts/host-test-there.sh > $S/host-1a2b3c4d.log 2>&1",
			"pnpm check:there",
			"pnpm test:changed",
			"pnpm exec vitest run tests/host",
			"nix build .#checks.x86_64-linux.clipboard",
			"bash scripts/merge-gate.sh 1693",
		])
			expect(isHeavy(label), label).toBe(true);
	});

	it("leaves the quick commands a restart carries or repeats cheaply", () => {
		for (const label of [
			"git status",
			"journalctl --user -u pi-host-work-background --since -10h",
			"rg nix-offloading docs/",
			"node scripts/lint.ts check --write host/engine/heavy.ts",
		])
			expect(isHeavy(label), label).toBe(false);
	});
});
