/**
 * The process a load really starts as its spawner is the one the node is
 * told of: a script stands in for pi-spawner, so this starts a process and
 * runs in the process lane (vitest.config.ts's PROCESS_TESTS).
 */
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnedBy } from "../../../../lib/internal/shell/spawner.ts";
import type { Spawned } from "../../../../lib/internal/shell/spawner-register.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";

const made: string[] = [];

afterEach(() => {
	for (const folder of made.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/**
 * A program that reads its input until it ends, as pi-spawner does, with
 * the shell's own read, so stopping it leaves no child behind.
 */
function readsUntilClosed(): string {
	const folder = mkdtempSync(join(tmpdir(), "spawner-starts-"));
	made.push(folder);
	const program = join(folder, "pi-spawner");
	writeFileSync(program, "#!/bin/sh\nwhile read -r _; do :; done\n");
	chmodSync(program, 0o755);
	return program;
}

describe.skipIf(process.platform !== "linux")(
	"the spawner a load starts",
	() => {
		it("is the process the node is told serves the load's session", async () => {
			const program = readsUntilClosed();
			const register = vi.fn<
				(spawned: Spawned, session: string) => Promise<void>
			>(async () => undefined);
			const operations = spawnedBy(
				{ exec: async () => ({ exitCode: 0 }) },
				{
					env: { [SPAWNER_VARIABLE]: "on" },
					shell: { shell: "/bin/sh", args: ["-c"] },
					program,
					reap: () => undefined,
					session: "s-one",
					register,
				},
			);

			// The script speaks no frames, so the command never starts; it
			// ends once the spawner is stopped below.
			const ran = operations
				.exec("true", "/", { onData: () => {}, env: {} })
				.catch(() => undefined);
			await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
			const [spawned, session] = register.mock.calls[0] ?? [];
			if (spawned === undefined) throw new Error("no process was told");
			const { pid, started } = spawned;
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const runs = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			process.kill(pid, "SIGTERM");
			await ran;

			expect(session, "the session it was told").toBe("s-one");
			// The start is /proc's 22nd field, the twentieth after the name.
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			expect(started, "the start it was told").toBe(Number(fields[19]));
			// The load starts the program through any links to it.
			expect(runs.split("\0"), "what the told process runs").toContain(
				realpathSync(program),
			);
		});
	},
);
