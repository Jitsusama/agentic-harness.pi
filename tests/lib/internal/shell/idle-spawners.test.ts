/**
 * The idle pi-spawners an earlier load left are stopped where there is no
 * /proc to read, as on a Mac: from one listing of every process, before
 * this load starts its own, so its own is never taken for a stray.
 */

import { describe, expect, it, vi } from "vitest";
import type { Started } from "../../../../lib/internal/shell/spawner.ts";
import {
	idleSpawnersListed,
	spawnedBy,
	stopIdleSpawners,
} from "../../../../lib/internal/shell/spawner.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";
import { spawnerStandIn } from "../../../support/spawner-stand-in.ts";

const SPAWNER = "/nix/store/k7vign6h-pi-spawner-0.1.0/bin/pi-spawner";

/** What `ps -A -o pid=,ppid=,comm=` printed on equilibrius, cut down. */
const LISTING = [
	"  100     1 pi",
	`  200   100 ${SPAWNER}`,
	`  300   100 ${SPAWNER}`,
	"  301   300 /bin/bash",
	"  400   100 /nix/store/qy5kkjcw-git-engine-0.1.0/bin/git-engine",
	`  500   999 ${SPAWNER}`,
	"",
].join("\n");

describe("the idle pi-spawners in a listing of every process", () => {
	it("are the parent's that run nothing, and only those", () => {
		expect(
			idleSpawnersListed(LISTING, 100),
			"the parent's idle spawners",
		).toEqual([200]);
	});

	it("are none in a listing that can't be read", () => {
		expect(idleSpawnersListed("ps: no such option\n", 100)).toEqual([]);
	});
});

describe("stopping them without /proc", () => {
	it("stops each idle one the listing names", async () => {
		const stopped: number[] = [];
		await stopIdleSpawners(
			100,
			"/no-proc",
			(pid) => stopped.push(pid),
			async () => LISTING,
		);
		expect(stopped, "the spawners stopped").toEqual([200]);
	});

	it("starts this load's own spawner only once the sweep has listed", async () => {
		const program = spawnerStandIn();
		const start = vi.fn<(path: string) => Started>(() => program.start());
		let listed: () => void = () => undefined;
		const sweep = new Promise<void>((resolve) => {
			listed = resolve;
		});
		const operations = spawnedBy(
			{ exec: async () => ({ exitCode: 0 }) },
			{
				env: { [SPAWNER_VARIABLE]: "on" },
				shell: { shell: "/bin/bash", args: ["-c"] },
				program: "/run/pi-spawner",
				start,
				kill: () => undefined,
				reap: () => sweep,
			},
		);
		void operations.exec("true", "/", { onData: () => {}, env: {} });
		await new Promise((resolve) => setImmediate(resolve));
		expect(start, "started while the sweep still lists").not.toHaveBeenCalled();
		listed();
		await vi.waitFor(() =>
			expect(program.asked.length, "requests the stand-in read").toBe(1),
		);
	});
});
