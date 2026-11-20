/**
 * A command whose pi-spawner stops while its folder is checked: the
 * check is held open here, so the stop lands between the command being
 * taken and being sent, the one window the link's own guard covers.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { spawnedBy } from "../../../../lib/internal/shell/spawner.ts";
import { SPAWNER_VARIABLE } from "../../../../lib/internal/shell/spawner-variable.ts";
import { spawnerStandIn } from "../../../support/spawner-stand-in.ts";

const checks = vi.hoisted((): { waiting?: () => void } => ({}));

vi.mock("node:fs/promises", async (actual) => ({
	...(await actual<typeof import("node:fs/promises")>()),
	access: () =>
		new Promise<void>((done) => {
			checks.waiting = done;
		}),
}));

/** End the folder's check held open, so the next begins afresh. */
function letCheckEnd(): void {
	const waiting = checks.waiting;
	checks.waiting = undefined;
	waiting?.();
}

describe("a command whose pi-spawner stops before it is sent", () => {
	it("runs through pi's own spawn, rather than failing or waiting for a start", async () => {
		const started: string[] = [];
		const own: BashOperations = {
			exec: async (command) => {
				started.push(command);
				return { exitCode: 3 };
			},
		};
		const program = spawnerStandIn();
		const operations = spawnedBy(own, {
			env: { [SPAWNER_VARIABLE]: "on" },
			shell: { shell: "/bin/bash", args: ["-c"] },
			program: "/run/pi-spawner",
			start: program.start,
			kill: () => undefined,
			reap: () => undefined,
			startOf: async () => 1,
		});

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await vi.waitFor(() =>
			expect(checks.waiting, "the folder's check began").toBeDefined(),
		);
		program.stop();
		await new Promise((done) => setImmediate(done));
		checks.waiting?.();

		await expect(ran, "how the command ended").resolves.toEqual({
			exitCode: 3,
		});
		expect(program.asked, "what reached the stopped spawner").toEqual([]);
		expect(started, "what pi's own spawn started").toEqual(["true"]);
	});

	it("runs through pi's own spawn where its spawner left another unanswered meanwhile, and lets that spawner close while it runs", async () => {
		const started: string[] = [];
		let finishOwn: (() => void) | undefined;
		const own: BashOperations = {
			exec: (command) => {
				started.push(command);
				return new Promise((done) => {
					finishOwn = () => done({ exitCode: 3 });
				});
			},
		};
		const program = spawnerStandIn();
		const said: string[] = [];
		const operations = spawnedBy(own, {
			env: { [SPAWNER_VARIABLE]: "on" },
			shell: { shell: "/bin/bash", args: ["-c"] },
			program: "/run/pi-spawner",
			start: program.start,
			kill: () => undefined,
			reap: () => undefined,
			startOf: async () => 1,
			givenUpGrace: 20,
			say: (line) => said.push(line),
		});
		checks.waiting = undefined;
		const stopping = new AbortController();
		const unanswered = operations.exec("sleep 9", "/", {
			onData: () => {},
			env: {},
			signal: stopping.signal,
		});
		await vi.waitFor(() =>
			expect(checks.waiting, "the first folder's check began").toBeDefined(),
		);
		letCheckEnd();
		await vi.waitFor(() =>
			expect(program.asked, "what reached the spawner").toHaveLength(1),
		);

		const ran = operations.exec("true", "/", { onData: () => {}, env: {} });
		await vi.waitFor(() =>
			expect(checks.waiting, "the second folder's check began").toBeDefined(),
		);
		stopping.abort();
		await expect(unanswered, "the one given up on").rejects.toThrow("aborted");
		expect(said, "what the host's log was told").toEqual([
			expect.stringContaining("takes no more"),
		]);
		letCheckEnd();

		await vi.waitFor(() =>
			expect(started, "what pi's own spawn started").toEqual(["true"]),
		);
		expect(program.asked, "what reached the silent spawner").toHaveLength(1);
		await vi.waitFor(() =>
			expect(program.hungUp(), "closed while pi's own spawn runs").toBe(true),
		);
		finishOwn?.();
		await expect(ran, "how the command ended").resolves.toEqual({
			exitCode: 3,
		});
	});
});
