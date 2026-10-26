/**
 * Terminals that can be started with a working directory and a
 * command, and nothing more: the blind launch.
 *
 * A launcher is data, so a person can add a terminal or change how one
 * starts with a config entry rather than a pull request. The built-in
 * table below is written in exactly the shape a configured one takes,
 * and a configured entry with a built-in's id replaces it.
 *
 * An argument template may hold three tokens. `{cwd}` is the working
 * directory and `{title}` the title, each substituted inside the
 * argument that holds it; an argument whose token has no value is
 * dropped whole. `{argv}` must stand alone and is replaced by the
 * command's words, spread.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	TerminalLayout,
	TerminalPlatform,
} from "../../../terminal/types.ts";

/** How a launcher starts on one platform. */
export interface LauncherForm {
	/** The binary to run, by name or absolute path. */
	readonly binary?: string;
	/**
	 * On macOS, an application bundle that must be installed for the
	 * form to be offered, such as `Ghostty` for `open -na Ghostty`.
	 */
	readonly app?: string;
	/** Arguments that open a window running `{argv}`. */
	readonly window?: readonly string[];
	/** Arguments that open a tab running `{argv}`, when the terminal can. */
	readonly tab?: readonly string[];
}

/** A terminal that can be launched blind. */
export interface LauncherSpec extends LauncherForm {
	/** The id it is chosen by, the same as a driver's when they are one terminal. */
	readonly id: string;
	/** The binary to run, by name or absolute path. */
	readonly binary: string;
	/**
	 * Per-platform forms that differ from the default, or false where
	 * the terminal does not run at all.
	 */
	readonly platforms?: Readonly<
		Partial<Record<TerminalPlatform, LauncherForm | false>>
	>;
}

/** The built-in launchers, in the order they are tried. */
export const BUILTIN_LAUNCHERS: readonly LauncherSpec[] = [
	{
		id: "kitty",
		binary: "kitty",
		window: ["--directory={cwd}", "--", "{argv}"],
	},
	{
		id: "wezterm",
		binary: "wezterm",
		window: ["start", "--always-new-process", "--cwd", "{cwd}", "--", "{argv}"],
	},
	{
		id: "ghostty",
		binary: "ghostty",
		window: ["--working-directory={cwd}", "-e", "{argv}"],
		platforms: {
			// Ghostty's binary cannot open a window on macOS; its bundle can.
			darwin: {
				binary: "open",
				app: "Ghostty",
				window: [
					"-na",
					"Ghostty",
					"--args",
					"--working-directory={cwd}",
					"-e",
					"{argv}",
				],
			},
		},
	},
	{
		id: "alacritty",
		binary: "alacritty",
		window: ["--working-directory", "{cwd}", "-e", "{argv}"],
	},
	{
		id: "foot",
		binary: "foot",
		window: ["--working-directory={cwd}", "--", "{argv}"],
		platforms: { darwin: false },
	},
];

/** A launcher as it applies on one platform, or undefined where it does not run. */
export function launcherOn(
	spec: LauncherSpec,
	platform: TerminalPlatform,
):
	| (LauncherForm & { readonly id: string; readonly binary: string })
	| undefined {
	const override = spec.platforms?.[platform];
	if (override === false) return undefined;
	return {
		id: spec.id,
		binary: override?.binary ?? spec.binary,
		...(override?.app ? { app: override.app } : {}),
		...((override?.window ?? spec.window)
			? { window: override?.window ?? spec.window }
			: {}),
		...((override?.tab ?? spec.tab) ? { tab: override?.tab ?? spec.tab } : {}),
	};
}

/** The layouts a launcher form can open. */
export function launcherLayouts(form: LauncherForm): TerminalLayout[] {
	const out: TerminalLayout[] = [];
	if (form.window) out.push("window");
	if (form.tab) out.push("tab");
	return out;
}

/** Whether a macOS application bundle is installed where `open -a` finds it. */
export function appInstalled(
	app: string,
	exists: (path: string) => boolean = existsSync,
	home: string = homedir(),
): boolean {
	return [
		join("/Applications", `${app}.app`),
		join(home, "Applications", `${app}.app`),
	].some(exists);
}

/**
 * Fill a launcher's argument template. Returns undefined when the
 * template has no `{argv}`, since a launch that drops the command would
 * open a terminal that does nothing the caller asked for.
 */
export function fillTemplate(
	template: readonly string[],
	values: {
		readonly cwd?: string;
		readonly title?: string;
		readonly argv: readonly string[];
	},
): string[] | undefined {
	if (!template.includes("{argv}")) return undefined;
	const out: string[] = [];
	for (const part of template) {
		if (part === "{argv}") {
			out.push(...values.argv);
			continue;
		}
		if (part.includes("{cwd}") && values.cwd === undefined) continue;
		if (part.includes("{title}") && values.title === undefined) continue;
		out.push(
			part
				.replaceAll("{cwd}", values.cwd ?? "")
				.replaceAll("{title}", values.title ?? ""),
		);
	}
	return out;
}

/**
 * How long a launched terminal is watched for failing at once. A
 * terminal that cannot start exits in well under this; one that hands
 * off to a running instance exits zero just as fast, which is fine.
 */
export const LAUNCH_GRACE_MS = 750;

/**
 * Start a terminal detached, so it belongs to the person rather than
 * to this process, and report a start that failed at once.
 */
export async function startDetached(
	binary: string,
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env: Readonly<Record<string, string>>;
		readonly graceMs?: number;
	},
): Promise<void> {
	const child = nodeSpawn(binary, [...args], {
		detached: true,
		stdio: "ignore",
		env: { ...options.env },
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	await new Promise<void>((resolve, reject) => {
		const grace = setTimeout(() => {
			child.removeAllListeners();
			resolve();
		}, options.graceMs ?? LAUNCH_GRACE_MS);
		child.once("error", (error) => {
			clearTimeout(grace);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(grace);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`${binary} ${signal ? `was killed by ${signal}` : `exited ${code}`} as it started`,
					),
				);
		});
	});
	child.unref();
}
