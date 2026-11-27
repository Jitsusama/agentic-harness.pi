/** What a host would start: its own code's fingerprint and its unit's. */
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	definitionMoves,
	hostCodeOf,
	hostModules,
	installMovesFrom,
	installMovesOrThrowsFrom,
	isUnitMain,
	ownLaunchdJob,
	ownUnit,
	processLaunchdFacts,
	relativeImports,
	unitDefinition,
	versionsMove,
} from "../../../host/service/what-starts.ts";

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "h1-starts-")));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), text);
}

describe("relativeImports", () => {
	it("names what runs, and passes over types and packages", () => {
		const text = [
			'import { a } from "./a.ts";',
			'import type { B } from "./b.ts";',
			'export { c } from "../c.ts";',
			'export type { D } from "./d.ts";',
			'import "./e.ts";',
			'import { join } from "node:path";',
			'const f = await import("./f.ts");',
			"import {",
			"\tg,",
			"\ttype H,",
			'} from "./g.ts";',
		].join("\n");
		expect(relativeImports(text).sort()).toEqual([
			"../c.ts",
			"./a.ts",
			"./e.ts",
			"./f.ts",
			"./g.ts",
		]);
	});
});

describe("hostCodeOf", () => {
	beforeEach(async () => {
		await put("scripts/pi-host.ts", 'import { run } from "../host/run.ts";\n');
		await put(
			"host/run.ts",
			'import type { T } from "./types.ts";\nexport const run = () => import("./late.ts");\n',
		);
		await put("host/types.ts", "export type T = 1;\n");
		await put("host/late.ts", "export const late = 1;\n");
		await put("host/unused.ts", "export const unused = 1;\n");
		await put("package.json", "{}\n");
		await put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
	});

	it("walks what the program loads, and nothing it only names as a type", async () => {
		expect(await hostModules(root)).toEqual([
			join(root, "host/late.ts"),
			join(root, "host/run.ts"),
			join(root, "scripts/pi-host.ts"),
		]);
	});

	it("changes with a module the host loads or its packages", async () => {
		const before = await hostCodeOf(root);
		await put("host/late.ts", "export const late = 2;\n");
		const moduleChanged = await hostCodeOf(root);
		await put("pnpm-lock.yaml", "lockfileVersion: '9.1'\n");
		expect(moduleChanged).not.toBe(before);
		expect(await hostCodeOf(root)).not.toBe(moduleChanged);
	});

	it("stays for a file the host never loads", async () => {
		const before = await hostCodeOf(root);
		await put("host/unused.ts", "export const unused = 2;\n");
		await put("host/types.ts", "export type T = 2;\n");
		expect(await hostCodeOf(root)).toBe(before);
	});
});

// 22 November: 15 children ran host code 34 hours old, holding 10.9 GB,
// since a child never restarts; each asks this whether its install moved on.
describe("installMovesFrom", () => {
	async function version(name: string, body: string): Promise<string> {
		await put(
			`install/versions/${name}/scripts/pi-host.ts`,
			'import "../host/a.ts";\n',
		);
		await put(`install/versions/${name}/host/a.ts`, body);
		return join(root, "install", "versions", name);
	}
	async function moveTo(name: string): Promise<void> {
		const next = join(root, "install", "next");
		await symlink(join(root, "install", "versions", name), next);
		await rename(next, join(root, "install", "current"));
	}

	it("says why once the install moves to other host code, and nothing before", async () => {
		const one = await version("one", "export const a = 1;\n");
		await version("same", "export const a = 1;\n");
		await version("two", "export const a = 2;\n");
		await symlink(one, join(root, "install", "current"));
		const moved = installMovesFrom(one);

		expect(await moved(), "unmoved").toBeUndefined();
		await moveTo("same");
		expect(await moved(), "moved to the same host code").toBeUndefined();
		await moveTo("two");
		expect(await moved()).toBe("the install's two changes the host's own code");
	});

	it("says nothing of a version its packages are still installing into, until they are", async () => {
		const one = await version("one", "export const a = 1;\n");
		await version("two", "export const a = 2;\n");
		await put(
			"install/versions/two/pnpm-lock.yaml",
			"lockfileVersion: '9.0'\n",
		);
		await symlink(one, join(root, "install", "current"));
		const moved = installMovesFrom(one);
		await moveTo("two");

		expect(await moved(), "still installing").toBeUndefined();
		await put("install/versions/two/node_modules/.modules.yaml", "{}\n");
		expect(await moved(), "installed").toBe(
			"the install's two changes the host's own code",
		);
	});

	it("reads its own host code only at the first ask, not as it is made", async () => {
		const one = join(root, "install", "versions", "one");
		// Made before its version is written, as nothing is read until asked.
		const moved = installMovesFrom(one);
		await version("one", "export const a = 1;\n");
		await version("same", "export const a = 1;\n");
		await symlink(one, join(root, "install", "current"));
		await moveTo("same");

		expect(await moved(), "the same host code as its own").toBeUndefined();
	});

	it("reads each version's host code once, since none changes under its name", async () => {
		const one = await version("one", "export const a = 1;\n");
		await version("same", "export const a = 1;\n");
		await symlink(one, join(root, "install", "current"));
		const moved = installMovesFrom(one);
		await moveTo("same");
		expect(await moved()).toBeUndefined();

		await put("install/versions/one/host/a.ts", "export const a = 2;\n");
		expect(await moved(), "its own as first read").toBeUndefined();
		await put("install/versions/same/host/a.ts", "export const a = 3;\n");
		expect(await moved(), "the install's as first read").toBeUndefined();
	});

	it("answers for any version asked of, each by its own code", async () => {
		const one = await version("one", "export const a = 1;\n");
		const same = await version("same", "export const a = 2;\n");
		await version("two", "export const a = 2;\n");
		await symlink(one, join(root, "install", "current"));
		const moved = versionsMove();
		await moveTo("two");

		expect(await moved(one)).toBe(
			"the install's two changes the host's own code",
		);
		expect(await moved(same), "the install's own code").toBeUndefined();
	});

	it("never moves for a version outside an install, such as a tree", async () => {
		await put("tree/scripts/pi-host.ts", "export {};\n");
		const moved = installMovesFrom(join(root, "tree"));
		expect(await moved()).toBeUndefined();
	});

	// 27 November (#2320's F25): a child's roll read an unreadable link as
	// its code found current again, and dropped its hour's wait for room.
	describe("asked as a child's roll asks", () => {
		it("throws, rather than answering nothing, when the install's link can't be read", async () => {
			const one = await version("one", "export const a = 1;\n");
			const moved = installMovesOrThrowsFrom(one);
			await expect(moved()).rejects.toThrow("can't be read");
		});

		it("throws while the version it names is still installing, then says why it moved", async () => {
			const one = await version("one", "export const a = 1;\n");
			await version("two", "export const a = 2;\n");
			await put(
				"install/versions/two/pnpm-lock.yaml",
				"lockfileVersion: '9.0'\n",
			);
			await symlink(one, join(root, "install", "current"));
			const moved = installMovesOrThrowsFrom(one);
			await moveTo("two");

			await expect(moved(), "still installing").rejects.toThrow(
				"the install's two hasn't finished installing",
			);
			await put("install/versions/two/node_modules/.modules.yaml", "{}\n");
			expect(await moved(), "installed").toBe(
				"the install's two changes the host's own code",
			);
		});

		it("answers nothing while the install names its own version or the same host code", async () => {
			const one = await version("one", "export const a = 1;\n");
			await version("same", "export const a = 1;\n");
			await symlink(one, join(root, "install", "current"));
			const moved = installMovesOrThrowsFrom(one);
			expect(await moved(), "its own version").toBeUndefined();
			await moveTo("same");
			expect(await moved(), "the same host code").toBeUndefined();
		});

		it("never moves, nor throws, for a version outside an install", async () => {
			await put("tree/scripts/pi-host.ts", "export {};\n");
			const moved = installMovesOrThrowsFrom(join(root, "tree"));
			expect(await moved()).toBeUndefined();
		});
	});

	it("answers nothing when the install's link can't be read, as a host's restart asks", async () => {
		const one = await version("one", "export const a = 1;\n");
		const moved = installMovesFrom(one);
		expect(await moved()).toBeUndefined();
	});
});

describe("ownUnit", () => {
	it("reads the service the process runs in, and nothing outside one", async () => {
		await put(
			"in-unit",
			"0::/user.slice/app.slice/pi-host-work-attended.service\n",
		);
		await put("in-scope", "0::/user.slice/session-2.scope\n");
		expect(await ownUnit(join(root, "in-unit"))).toBe(
			"pi-host-work-attended.service",
		);
		expect(await ownUnit(join(root, "in-scope"))).toBeUndefined();
		expect(await ownUnit(join(root, "absent"))).toBeUndefined();
	});
});

describe("ownLaunchdJob", () => {
	const label = "org.jitsusama.pi-host-work-background";

	it("names the job of a Mac's host whose parent is launchd", () => {
		expect(ownLaunchdJob({ platform: "darwin", ppid: 1, service: label })).toBe(
			label,
		);
	});

	it("names none for a host started any other way", () => {
		// Started in a terminal, its parent a shell.
		expect(
			ownLaunchdJob({ platform: "darwin", ppid: 4242, service: label }),
		).toBeUndefined();
		// Left behind by its parent, carrying the terminal's name.
		expect(
			ownLaunchdJob({
				platform: "darwin",
				ppid: 1,
				service: "application.com.apple.Terminal.1234",
			}),
		).toBeUndefined();
		expect(
			ownLaunchdJob({ platform: "darwin", ppid: 1, service: undefined }),
		).toBeUndefined();
		// Linux's host is systemd's, whatever it carries.
		expect(
			ownLaunchdJob({ platform: "linux", ppid: 1, service: label }),
		).toBeUndefined();
	});

	it.each([
		"org.jitsusama.not-pi-host-x",
		"org.jitsusama.pi-host-",
		"org.jitsusama.pi-host-work.attended",
		"org.jitsusama.pi-hostwork",
	])("names none for the near miss %s", (service) => {
		expect(
			ownLaunchdJob({ platform: "darwin", ppid: 1, service }),
		).toBeUndefined();
	});

	it("names a Label that is the job's name alone", () => {
		expect(
			ownLaunchdJob({ platform: "darwin", ppid: 1, service: "pi-host-work" }),
		).toBe("pi-host-work");
	});

	it("reads this process's Label from launchd's variable", () => {
		const facts = processLaunchdFacts({ XPC_SERVICE_NAME: label });
		expect(facts.service).toBe(label);
		expect(facts.platform).toBe(process.platform);
		expect(facts.ppid).toBe(process.ppid);
		expect(processLaunchdFacts({}).service).toBeUndefined();
	});
});

describe("isUnitMain", () => {
	it("answers whether systemd names this process the unit's main one", async () => {
		const systemctl = async () => "MainPID=7\n";
		expect(
			await isUnitMain("pi-host.service", 7, systemctl),
			"the main process",
		).toBe(true);
		expect(
			await isUnitMain("pi-host.service", 8, systemctl),
			"another process in its cgroup",
		).toBe(false);
		expect(
			await isUnitMain("pi-host.service", 7, async () => {
				throw new Error("no manager");
			}),
			"systemd unreachable",
		).toBe(false);
	});
});

describe("unitDefinition", () => {
	it("resolves the unit's file and drop-ins, once systemd has read them", async () => {
		await put("unit.service", "[Service]\n");
		await put("unit.service.d/env.conf", "[Service]\n");
		const fragment = join(root, "unit.service");
		const dropIn = join(root, "unit.service.d/env.conf");
		const said = (reload: string) => async () =>
			`NeedDaemonReload=${reload}\nFragmentPath=${fragment}\nDropInPaths=${dropIn}\n`;
		expect(await unitDefinition("unit.service", said("no"))).toBe(
			`${fragment}\n${dropIn}`,
		);
		expect(
			await unitDefinition("unit.service", said("yes")),
			"a restart would start the old unit",
		).toBeUndefined();
		expect(
			await unitDefinition("unit.service", async () => "NeedDaemonReload=no\n"),
			"a unit with no file",
		).toBeUndefined();
	});

	it("leaves out what set-property wrote, which changes nothing the unit starts", async () => {
		await put("unit.service", "[Service]\n");
		await put("unit.service.d/env.conf", "[Service]\n");
		const fragment = join(root, "unit.service");
		const dropIn = join(root, "unit.service.d/env.conf");
		const controlled =
			(...settings: string[]) =>
			async () =>
				[
					"NeedDaemonReload=no",
					`FragmentPath=${fragment}`,
					`DropInPaths=${[
						dropIn,
						...settings.map(
							(one) =>
								`/run/user/1000/systemd/user.control/unit.service.d/50-${one}.conf`,
						),
					].join(" ")}`,
					"",
				].join("\n");
		const before = await unitDefinition(
			"unit.service",
			controlled("CPUWeight"),
		);
		expect(before).toBe(`${fragment}\n${dropIn}`);
		expect(
			await unitDefinition("unit.service", controlled("CPUWeight", "IOWeight")),
			"a jobs sorter setting one more control",
		).toBe(before);
		expect(
			await unitDefinition("unit.service", controlled()),
			"a jobs sorter taking its controls back as it stops",
		).toBe(before);
	});

	it("still counts a drop-in in the folders beside set-property's", async () => {
		await put("unit.service", "[Service]\n");
		const fragment = join(root, "unit.service");
		const beside = [
			"/run/user/1000/systemd/user/unit.service.d/50-env.conf",
			"/run/user/1000/systemd/transient/unit.service.d/50-env.conf",
			"/home/joel/.config/systemd/user/unit.service.d/override.conf",
			"/run/user/1000/systemd/user.control.d/unit.service.d/50-env.conf",
		];
		for (const dropIn of beside) {
			expect(
				await unitDefinition(
					"unit.service",
					async () =>
						`NeedDaemonReload=no\nFragmentPath=${fragment}\nDropInPaths=${dropIn}\n`,
				),
				dropIn,
			).toBe(`${fragment}\n${dropIn}`);
		}
	});
});

describe("definitionMoves", () => {
	it("names the files systemd now reads and those it no longer reads", () => {
		expect(
			definitionMoves("/a.service\n/old.conf", "/a.service\n/new.conf"),
		).toBe("it now reads /new.conf, and it no longer reads /old.conf");
		expect(definitionMoves("/a.service", "/a.service\n/new.conf")).toBe(
			"it now reads /new.conf",
		);
		expect(definitionMoves("/a.service\n/old.conf", "/a.service")).toBe(
			"it no longer reads /old.conf",
		);
		expect(
			definitionMoves(
				"/a.service\n/b.conf\n/c.conf",
				"/a.service\n/c.conf\n/b.conf",
			),
			"drop-ins whose order alone changed",
		).toBe("it reads the same files in a new order");
	});
});
