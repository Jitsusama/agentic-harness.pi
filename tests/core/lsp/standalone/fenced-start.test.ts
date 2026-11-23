/**
 * A language server started in its conversation's fence.
 *
 * It runs as the fence launches it, in the project's folder and the
 * environment the fence gives, and isn't told pi's pid, which it may
 * not see. One the fence refuses never starts, one that exits inside
 * says why, and one that fails for its own reason keeps it. Everything
 * it started ends with it, told first and killed after a grace, and
 * when it goes on its own. pi reads and writes for it only what the
 * fence would let pi's own file tools.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../../../lib/core/lsp/config.ts";
import type { LspFence } from "../../../../lib/core/lsp/index.ts";
import { StandaloneServer } from "../../../../lib/core/lsp/standalone/server.ts";
import { WATCHER } from "../../../../lib/internal/fence/fence-child.ts";

const fixture = fileURLToPath(
	new URL("./fixtures/dying-server.mjs", import.meta.url),
);

/** Each word quoted for the shell, as a fence's launch quotes them. */
const said = (words: readonly string[]): string =>
	words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");

/**
 * Whether the kernel names this process's descriptors' files, without
 * which (a Mac) pi writes no file a fenced server names.
 */
const namesDescriptors = existsSync("/proc/self/fd");

/** Whether `pid` still runs. */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("a language server started in a fence", () => {
	let dir: string;
	let config: ServerConfig;
	let server: StandaloneServer | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-fenced-start-"));
		config = {
			name: "fake",
			command: process.execPath,
			args: [fixture, join(dir, "starts.log")],
			fileTypes: [".fake"],
			rootMarkers: [],
		};
	});

	afterEach(async () => {
		await server?.dispose();
		server = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const fence = (
		text: (words: readonly string[]) => string,
		env: NodeJS.ProcessEnv = process.env,
		refuses: LspFence["refuses"] = () => undefined,
	): LspFence => ({
		key: "fence|test",
		launch: async (words) => ({ text: text(words), env }),
		refuses,
	});

	/**
	 * A server started in `given`, its shell the bash on the tests' PATH:
	 * a machine that runs them needn't have one only its administrator
	 * could put there, which the last tests here prove a start asks for.
	 */
	const inFence = (
		given: LspFence,
		graceMs?: number,
	): Promise<StandaloneServer> =>
		StandaloneServer.start(
			config,
			dir,
			process.execPath,
			given,
			graceMs,
			() => "bash",
		);

	/** A server that answers: the fixture's first start dies at its first hover. */
	const answering = (
		refuses?: LspFence["refuses"],
		env: NodeJS.ProcessEnv = process.env,
	): Promise<StandaloneServer> => {
		writeFileSync(join(dir, "starts.log"), "start\n");
		return inFence(fence((words) => `exec ${said(words)}`, env, refuses));
	};

	/** A server started in a fence running `text`, its pid's file beside. */
	const started = async (
		text: (words: readonly string[]) => string,
		graceMs?: number,
		refuses?: LspFence["refuses"],
	): Promise<StandaloneServer> =>
		inFence(fence(text, process.env, refuses), graceMs);

	it("runs as the fence launches it, in the project's folder and the fence's environment, not told pi's pid", async () => {
		let asked: readonly string[] | undefined;
		server = await inFence(
			fence(
				(words) => {
					asked = words;
					return `printf %s "$FENCE_MARK" > fenced; exec ${said(words)}`;
				},
				{ ...process.env, FENCE_MARK: "inside" },
			),
		);

		expect(asked).toEqual([process.execPath, fixture, join(dir, "starts.log")]);
		expect(readFileSync(join(dir, "fenced"), "utf8")).toBe("inside");
		expect(readFileSync(join(dir, "starts.log.pid"), "utf8")).toBe("null");
	}, 15_000);

	it("hands the server the fence's environment alone, none of pi's own", async () => {
		vi.stubEnv("PI_ONLY_MARK", "pi's");
		const { PI_ONLY_MARK: _pi, ...env } = process.env;
		server = await inFence(
			fence(
				(words) =>
					`printf %s "\${PI_ONLY_MARK-unset}" > fenced; exec ${said(words)}`,
				env,
			),
		);
		vi.unstubAllEnvs();

		expect(readFileSync(join(dir, "fenced"), "utf8")).toBe("unset");
	}, 15_000);

	it("starts through the fence's own watcher, which holds pi's pipe for the server's life", async () => {
		server = await started(
			(words) => `${WATCHER}trap : TERM HUP INT\n${said(words)}`,
		);

		expect(readFileSync(join(dir, "starts.log.pid"), "utf8")).toBe("null");
	}, 15_000);

	it("never starts a fenced server where no bash lies that only the system's administrator could put there", async () => {
		await expect(
			StandaloneServer.start(
				config,
				dir,
				process.execPath,
				fence((words) => `exec ${said(words)}`),
				undefined,
				() => undefined,
			),
		).rejects.toThrow(
			"fake won't start: no bash lies where only the system's administrator can put one",
		);
		expect(existsSync(join(dir, "starts.log"))).toBe(false);
	});

	it("fails a start whose shell can't be spawned, rather than leaving its error unheard", async () => {
		await expect(
			StandaloneServer.start(
				config,
				dir,
				process.execPath,
				fence((words) => `exec ${said(words)}`),
				undefined,
				() => join(dir, "no-such-bash"),
			),
		).rejects.toThrow(/^fake didn't start: spawn .*no-such-bash ENOENT$/);
	}, 15_000);

	it("tells an unfenced server pi's pid", async () => {
		server = await StandaloneServer.start(config, dir, process.execPath);

		expect(readFileSync(join(dir, "starts.log.pid"), "utf8")).toBe(
			String(process.pid),
		);
	}, 15_000);

	it("never starts one the fence refuses, and says why", async () => {
		await expect(
			StandaloneServer.start(config, dir, process.execPath, {
				key: "fence|test",
				launch: async () => ({ refused: "this machine can't fence a command" }),
				refuses: () => undefined,
			}),
		).rejects.toThrow("fake won't start: this machine can't fence a command");
		expect(existsSync(join(dir, "starts.log"))).toBe(false);
	});

	it("says just what the fence said when it refuses the server, under the fence's own watcher", async () => {
		await expect(
			started(
				() =>
					`${WATCHER}trap : TERM HUP INT\necho 'sandboxed: no such folder' >&2; exit 126`,
			),
		).rejects.toThrow(
			/^fake couldn't run in the fence: sandboxed: no such folder$/,
		);
	}, 15_000);

	it("says a server that exits as it starts did so for its own reason, not the fence's", async () => {
		await expect(
			inFence(
				fence((words) => said(words), {
					...process.env,
					FAKE_INIT_EXIT: "no tsconfig here",
				}),
			),
		).rejects.toThrow(/^fake exited as it started: no tsconfig here$/);
	}, 15_000);

	it("keeps a running server's own reason for failing its start, whatever it said on its error output", async () => {
		await expect(
			inFence(
				fence((words) => `exec ${said(words)}`, {
					...process.env,
					FAKE_INIT_ERROR: "no project here",
				}),
			),
		).rejects.toThrow(/^no project here$/);
	}, 15_000);

	it("ends everything the fence started with the server", async () => {
		const pidFile = join(dir, "beside.pid");
		server = await started(
			(words) =>
				`sleep 600 </dev/null >/dev/null 2>&1 & echo $! > ${said([pidFile])}; exec ${said(words)}`,
		);
		const beside = Number(readFileSync(pidFile, "utf8").trim());
		expect(alive(beside)).toBe(true);

		await server.dispose();
		server = undefined;

		await vi.waitFor(() => expect(alive(beside)).toBe(false), {
			timeout: 5000,
		});
	}, 15_000);

	it("kills what ignores the telling once the grace is out", async () => {
		const pidFile = join(dir, "beside.pid");
		server = await started(
			(words) =>
				`( trap '' TERM; exec sleep 600 ) </dev/null >/dev/null 2>&1 & echo $! > ${said([pidFile])}; exec ${said(words)}`,
			200,
		);
		const beside = Number(readFileSync(pidFile, "utf8").trim());

		await server.dispose();
		server = undefined;

		await vi.waitFor(() => expect(alive(beside)).toBe(false), {
			timeout: 5000,
		});
	}, 15_000);

	it("lets the fence's shell finish what it runs after its server, within the grace", async () => {
		const after = join(dir, "after");
		server = await started(
			(words) =>
				`trap : TERM HUP INT\n${said(words)}\necho checked > ${said([after])}`,
			5000,
		);

		await server.dispose();
		server = undefined;

		await vi.waitFor(
			() => expect(readFileSync(after, "utf8")).toBe("checked\n"),
			{ timeout: 4000 },
		);
	}, 15_000);

	it("ends what the fence started when the server goes on its own", async () => {
		const pidFile = join(dir, "beside.pid");
		const file = join(dir, "a.fake");
		writeFileSync(file, "x\n");
		server = await started(
			(words) =>
				`sleep 600 </dev/null >/dev/null 2>&1 & echo $! > ${said([pidFile])}; ${said(words)}`,
		);
		const beside = Number(readFileSync(pidFile, "utf8").trim());

		// The first start exits at its first hover, as a crash would.
		await expect(
			server.hover({ path: file, position: { line: 1, character: 0 } }),
		).rejects.toThrow();

		await vi.waitFor(() => expect(alive(beside)).toBe(false), {
			timeout: 5000,
		});
	}, 15_000);

	it("reads pi a file for a fenced server where the fence lets it", async () => {
		const file = join(dir, "a.fake");
		writeFileSync(file, "x\n");
		server = await answering();

		await expect(
			server.hover({ path: file, position: { line: 1, character: 0 } }),
		).resolves.toMatchObject({ contents: "alive" });
	}, 15_000);

	it.runIf(namesDescriptors)(
		"writes a rename's edit for a fenced server where the fence lets it",
		async () => {
			const file = join(dir, "a.fake");
			writeFileSync(file, "x\n");
			server = await answering();

			const edit = await server.rename(
				{ path: file, position: { line: 1, character: 0 } },
				"y",
			);

			expect(edit.changes.map((change) => change.path)).toEqual([file]);
			expect(readFileSync(file, "utf8")).toBe("renamed x\n");
		},
		15_000,
	);

	it.skipIf(namesDescriptors)(
		"writes no file a fenced server names where pi can't tell which file it opened",
		async () => {
			const file = join(dir, "a.fake");
			writeFileSync(file, "x\n");
			server = await answering();

			await expect(
				server.rename({ path: file, position: { line: 1, character: 0 } }, "y"),
			).rejects.toThrow("pi can't tell here which file it opened");
			expect(readFileSync(file, "utf8")).toBe("x\n");
		},
		15_000,
	);

	it.runIf(namesDescriptors)(
		"writes every file of a rename's edit before telling the server of any, so one it can't read back leaves none unwritten",
		async () => {
			const file = join(dir, "a.fake");
			const other = join(dir, "b.fake");
			writeFileSync(file, "x\n");
			writeFileSync(other, "x\n");
			// The file named first can't be read back as pi tells of it, as
			// one the server moved: told as each was written, that refusal
			// would leave the second unwritten.
			server = await answering(
				(use, path) =>
					use === "read" && path.endsWith("b.fake") ? "moved" : undefined,
				{ ...process.env, FAKE_RENAME_PATH: other },
			);

			await server.rename(
				{ path: file, position: { line: 1, character: 0 } },
				"y",
			);

			expect(readFileSync(other, "utf8")).toBe("renamed x\n");
			expect(readFileSync(file, "utf8")).toBe("renamed x\n");
		},
		15_000,
	);

	it("tells a fenced server of an edit only the text pi reads itself, never what the caller read", async () => {
		const file = join(dir, "a.fake");
		writeFileSync(file, "x\n");
		server = await answering();
		await server.hover({ path: file, position: { line: 1, character: 0 } });

		writeFileSync(file, "edited\n");
		server.syncDocument(file, "read elsewhere\n");

		await vi.waitFor(
			() =>
				expect(readFileSync(join(dir, "starts.log.changed"), "utf8")).toBe(
					"edited\n",
				),
			{ timeout: 5000 },
		);
	}, 15_000);

	it("tells a fenced server nothing of an edit to a file a link now leads out of the fence", async () => {
		const inside = realpathSync(dir);
		const file = join(inside, "a.fake");
		const later = join(inside, "b.fake");
		const away = mkdtempSync(join(tmpdir(), "lsp-fenced-away-"));
		const key = join(away, "key");
		writeFileSync(key, "secret\n");
		writeFileSync(file, "x\n");
		writeFileSync(later, "x\n");
		try {
			server = await answering((use, path) =>
				use === "read" && !path.startsWith(`${inside}/`)
					? "outside the folder"
					: undefined,
			);
			for (const path of [file, later])
				await server.hover({ path, position: { line: 1, character: 0 } });

			// The server swaps a link in once pi's edit is judged, and the
			// caller reads through it.
			rmSync(file);
			symlinkSync(key, file);
			server.syncDocument(file, readFileSync(file, "utf8"));
			writeFileSync(later, "after\n");
			server.syncDocument(later, "after\n");

			await vi.waitFor(
				() =>
					expect(
						readFileSync(join(dir, "starts.log.changed"), "utf8"),
					).toContain("after\n"),
				{ timeout: 5000 },
			);
			expect(readFileSync(join(dir, "starts.log.changed"), "utf8")).toBe(
				"after\n",
			);
		} finally {
			rmSync(away, { recursive: true, force: true });
		}
	}, 15_000);

	it.runIf(namesDescriptors)(
		"writes none of a rename's edit when the fence refuses pi a file it names",
		async () => {
			const file = join(dir, "a.fake");
			writeFileSync(file, "x\n");
			const real = realpathSync(file);
			server = await started(
				(words) => `exec ${said(words)}`,
				undefined,
				(use, path) =>
					use === "write" && path === real ? "not this one" : undefined,
			);

			await expect(
				server.rename({ path: file, position: { line: 1, character: 0 } }, "y"),
			).rejects.toThrow("fake's rename wrote nothing: not this one");
			expect(readFileSync(file, "utf8")).toBe("x\n");
		},
		15_000,
	);

	it.runIf(namesDescriptors)(
		"writes no file of a rename's edit when the fence refuses pi any one it names",
		async () => {
			const file = join(dir, "a.fake");
			const other = join(dir, "b.fake");
			writeFileSync(file, "x\n");
			writeFileSync(other, "x\n");
			server = await inFence(
				fence(
					(words) => `exec ${said(words)}`,
					{ ...process.env, FAKE_RENAME_PATH: other },
					(use, path) =>
						use === "write" && path.endsWith("b.fake")
							? "not this one"
							: undefined,
				),
			);

			await expect(
				server.rename({ path: file, position: { line: 1, character: 0 } }, "y"),
			).rejects.toThrow("fake's rename wrote nothing: not this one");
			expect(readFileSync(file, "utf8")).toBe("x\n");
			expect(readFileSync(other, "utf8")).toBe("x\n");
		},
		15_000,
	);

	it.runIf(namesDescriptors)(
		"judges the file pi opened for a rename, not the path the server named, which a link can lead out",
		async () => {
			const inside = realpathSync(dir);
			const away = mkdtempSync(join(tmpdir(), "lsp-fenced-away-"));
			const startup = join(away, "startup");
			writeFileSync(startup, "x\n");
			const link = join(inside, "a.fake");
			symlinkSync(startup, link);
			try {
				server = await started(
					(words) => `exec ${said(words)}`,
					undefined,
					(use, path) =>
						use === "write" && !path.startsWith(`${inside}/`)
							? "outside the folder"
							: undefined,
				);

				await expect(
					server.rename(
						{ path: link, position: { line: 1, character: 0 } },
						"y",
					),
				).rejects.toThrow("fake's rename wrote nothing: outside the folder");
				expect(readFileSync(startup, "utf8")).toBe("x\n");
			} finally {
				rmSync(away, { recursive: true, force: true });
			}
		},
		15_000,
	);

	it("reads pi no file for the server that the fence refuses it", async () => {
		const file = join(dir, "a.fake");
		writeFileSync(file, "x\n");
		server = await started(
			(words) => `exec ${said(words)}`,
			undefined,
			(use) => (use === "read" ? "not readable here" : undefined),
		);

		await expect(
			server.hover({ path: file, position: { line: 1, character: 0 } }),
		).rejects.toThrow("not readable here");
	}, 15_000);
});
