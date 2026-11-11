/** What a host would start: its own code's fingerprint and its unit's. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hostCodeOf,
	hostModules,
	isUnitMain,
	ownUnit,
	relativeImports,
	unitDefinition,
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
});
