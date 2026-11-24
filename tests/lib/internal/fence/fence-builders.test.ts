/**
 * The builders' folder inside the fence, through a real bubblewrap: the
 * cloud token never there, even once the lender replaces it while a
 * command runs, and everything else readable but not writable. It skips
 * only where no bubblewrap can make a namespace, as inside another
 * sandbox. And what a strict command is given of the builders, as
 * paths: everything nix-offload needs, and never a token or its key.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fenceArgs,
	fenceRefusesRead,
	fenceRefusesWrite,
} from "../../../../lib/internal/fence/fence.ts";
import {
	buildersFolderArgs,
	buildersReach,
	lenderFolders,
} from "../../../../lib/internal/fence/fence-builders.ts";
import { DISK, type Disk } from "../../../../lib/internal/fence/fence-disk.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe("the lenders' folders in the fence's arguments", () => {
	const lenders = ["nix-offload", "nix-offload-more", "nix-offload-vm-12"];
	const disk: Disk = {
		kind: (path) =>
			path === "/run" ||
			path.endsWith("/wanted") ||
			/^\/run\/nix-offload[^/]*$/.test(path)
				? "folder"
				: "file",
		entries: (folder) =>
			folder === "/run"
				? [
						...lenders,
						"nix-offload-lines",
						"nix-offload-standing",
						"nix-offload-keep.sock",
						"user",
					]
				: ["machines", "cloud-token", "wanted", "health.json"],
	};

	it("finds every lender's folder, and not root's lines or standing builders", () => {
		expect(lenderFolders(disk)).toEqual(lenders.map((name) => `/run/${name}`));
	});

	it("covers each and binds back all but the token, read-only", () => {
		const args = buildersFolderArgs(disk).join(" ");
		expect(args, "the token was bound").not.toContain("cloud-token");
		for (const name of lenders) {
			const folder = `/run/${name}`;
			expect(args, `${name} isn't covered`).toContain(`--tmpfs ${folder} `);
			expect(args, `${name}'s cover stays writable`).toContain(
				`--remount-ro ${folder}`,
			);
			const path = join(folder, "health.json");
			expect(args, `${name}'s health wasn't bound back`).toContain(
				`--ro-bind ${path} ${path}`,
			);
		}
		expect(args, "root's lines were covered").not.toContain(
			"nix-offload-lines",
		);
	});

	it("hides the tokens' own folder whole, binding nothing back", () => {
		const tokens = "/run/nix-offload-tokens";
		const withTokens: Disk = {
			kind: () => "folder",
			entries: (folder) =>
				folder === "/run" ? ["nix-offload-tokens"] : ["nix-offload-vm-5"],
		};
		expect(buildersFolderArgs(withTokens)).toEqual([
			"--tmpfs",
			tokens,
			"--remount-ro",
			tokens,
		]);
		const place = { home: "/home/u", cwd: "/home/u", runtimeDir: undefined };
		expect(
			fenceRefusesRead(`${tokens}/nix-offload-vm-5`, place, withTokens),
			"a lender's token was read",
		).toBe(true);
	});

	it("leaves out a machine with no lenders", () => {
		const none: Disk = { kind: () => undefined, entries: () => [] };
		expect(buildersFolderArgs(none)).toEqual([]);
	});

	it("refuses pi's file tools every lender's token, and writes anywhere in their folders", () => {
		const place = {
			home: "/home/u",
			cwd: "/home/u/src",
			runtimeDir: undefined,
		};
		for (const name of [...lenders, "nix-offload-vm-99"]) {
			expect(
				fenceRefusesRead(`/run/${name}/cloud-token`, place, disk),
				`${name}'s token was read`,
			).toBe(true);
			expect(
				fenceRefusesWrite(`/run/${name}/machines`, place, disk),
				`${name}'s builders' list was written`,
			).toBe(true);
		}
		expect(
			fenceRefusesRead("/run/nix-offload/health.json", place, disk),
			"the builders' health was refused",
		).toBe(false);
		expect(
			fenceRefusesRead("/run/nix-offload-lines/machines", place, disk),
			"root's lines were refused",
		).toBe(false);
	});

	it("is part of every fenced command's arguments", () => {
		// No code caches: this disk calls them files, which refuse the fence.
		const args = fenceArgs(
			{ home: "/home/u", runtimeDir: undefined, tempCaches: [] },
			disk,
		);
		expect(args.join(" "), "the folder isn't covered").toContain(
			"--tmpfs /run/nix-offload-more",
		);
	});
});

describe("what a strict command reaches of the builders", () => {
	const state = "/home/u/.local/state/nix-offload";
	const held: Record<string, readonly string[]> = {
		"/run": [
			"nix-offload",
			"nix-offload-more",
			"nix-offload-tokens",
			"nix-offload-vm-18",
			"nix-offload-lines",
			"nix-offload-standing",
			"offload-wants",
		],
		// An older lender still keeping its token beside the rest.
		"/run/nix-offload": ["lender", "cloud-token", "waiting", "a-link"],
		"/run/nix-offload-more": ["lender", "health.json"],
		"/run/nix-offload-tokens": ["nix-offload", "nix-offload-more"],
		// A lender's folder made but not yet lent, or one this account can't
		// list, which reads as empty: a token it holds later would be in reach.
		"/run/nix-offload-vm-18": [],
		[state]: [
			"there.jsonl",
			"store_ed25519",
			"store_ed25519.pub",
			"runs.jsonl",
			"running",
			"passed",
		],
	};
	const folders = /(waiting|passed|running)$/;
	const disk: Disk = {
		kind: (path) =>
			path.endsWith("a-link")
				? "link"
				: path in held || folders.test(path)
					? "folder"
					: "file",
		entries: (folder) => held[folder] ?? [],
	};
	const reach = buildersReach(disk, "/home/u");

	it("reads root's lines and standing builders, and a lender holding no token whole", () => {
		expect(reach.readable).toEqual(
			expect.arrayContaining([
				"/run/nix-offload-lines",
				"/run/nix-offload-standing",
				"/run/nix-offload-more",
			]),
		);
	});

	it("reads a lender holding its token entry by entry, without the token or a link", () => {
		const inLender = reach.readable.filter((path) =>
			path.startsWith("/run/nix-offload/"),
		);
		expect(inLender, "what of the lender is read").toEqual([
			"/run/nix-offload/lender",
			"/run/nix-offload/waiting",
		]);
		expect(reach.readable, "the lender was read whole").not.toContain(
			"/run/nix-offload",
		);
	});

	it("never reaches the tokens' folder or any token", () => {
		const every = [...reach.readable, ...reach.writable];
		for (const path of every) {
			expect(path, "a token is in reach").not.toMatch(
				/nix-offload-tokens|cloud-token|store_ed25519$/,
			);
		}
	});

	it("reads nothing of a lender's folder that lists as empty", () => {
		expect(reach.readable).not.toContain("/run/nix-offload-vm-18");
	});

	it("writes the wants, and of nix-offload's state only its journals and runs", () => {
		// Not `passed`, which a gate trusts where no keeper runs, nor the
		// login key's public half.
		expect(reach.writable).toEqual([
			"/run/offload-wants",
			`${state}/running`,
			`${state}/runs.jsonl`,
			`${state}/there.jsonl`,
		]);
		expect(reach.readable).toEqual(
			expect.arrayContaining([`${state}/passed`, `${state}/store_ed25519.pub`]),
		);
	});

	it("never gives nix-offload's state whole, so a key made later stays out of reach", () => {
		const bare: Disk = {
			kind: () => "folder",
			entries: (folder) => (folder === state ? ["there.jsonl"] : []),
		};
		const { readable, writable } = buildersReach(bare, "/home/u");
		for (const path of [...readable, ...writable]) {
			expect(path, "the state was given whole").not.toBe(state);
		}
		expect(writable).toEqual(["/run/offload-wants", `${state}/there.jsonl`]);
	});
});

describe.skipIf(bwrap === undefined)(
	"the builders' folder through a real bubblewrap",
	() => {
		let base = "";
		let folder = "";
		let token = "";

		/** The bubblewrap arguments for `script` over the stand-in folder. */
		function argsFor(script: string): string[] {
			return [
				"--unshare-user",
				"--bind",
				"/",
				"/",
				...buildersFolderArgs(DISK, [folder]),
				"sh",
				"-c",
				script,
			];
		}

		/** Whether `script` succeeds inside. */
		function inside(script: string): boolean {
			return spawnSync(bwrap ?? "bwrap", argsFor(script)).status === 0;
		}

		beforeAll(() => {
			base = mkdtempSync(join(tmpdir(), "fbf-"));
			folder = join(base, "nix-offload");
			mkdirSync(join(folder, "wanted"), { recursive: true });
			token = join(folder, "cloud-token");
			writeFileSync(token, "secret-1");
			writeFileSync(join(folder, "machines"), "builder");
		});

		afterAll(() => rmSync(base, { recursive: true, force: true }));

		it("has no token, and reads the rest", () => {
			expect(inside(`test -e '${token}'`), "the token is there").toBe(false);
			expect(
				inside(`grep -q builder '${folder}/machines'`),
				"the builders' list can't be read",
			).toBe(true);
		});

		it("writes nothing there", () => {
			expect(
				inside(`echo x > '${folder}/machines'`),
				"the builders' list was written",
			).toBe(false);
			expect(inside(`touch '${folder}/planted'`), "something was added").toBe(
				false,
			);
			expect(
				inside(`touch '${folder}/wanted/planted'`),
				"something was added to a folder in it",
			).toBe(false);
			expect(readFileSync(join(folder, "machines"), "utf8")).toBe("builder");
		});

		it("still has no token after the lender replaces it while a command runs", async () => {
			// Waits on its stdin, a pipe the test closes once the token is
			// replaced outside, then looks for it.
			const running = spawn(
				bwrap ?? "bwrap",
				argsFor(`read _; test -e '${token}'`),
				{
					stdio: ["pipe", "ignore", "ignore"],
				},
			);
			const ended = new Promise<number | null>((settle) =>
				running.on("exit", settle),
			);
			// Time for the namespace to be made before the token is replaced.
			await new Promise((settle) => setTimeout(settle, 300));
			const next = `${token}.next`;
			writeFileSync(next, "secret-2");
			renameSync(next, token);
			running.stdin?.end("\n");
			expect(await ended, "the replaced token showed inside").not.toBe(0);
		});
	},
);
