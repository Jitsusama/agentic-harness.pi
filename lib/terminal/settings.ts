/**
 * The person's terminal settings, and which of them applies.
 *
 * Three things are chosen: the terminal (`driver`), where the new shell
 * appears (`layout`), and which terminal a layout goes to when the
 * session sits inside more than one (`nesting`). Each is chosen in
 * layers, first match winning, the same way subagent and review
 * settings are:
 *
 * 1. the call itself;
 * 2. the loaded quest, under `quests`;
 * 3. the session's project, under `projects`, keyed by repository key;
 * 4. `defaults`;
 * 5. what the library would pick unasked.
 *
 * The three resolve independently, so a project can pin a layout and
 * inherit the terminal, and every choice carries the layer that made
 * it, so an answer can say why it did what it did.
 */

import {
	TERMINAL_LAYOUTS,
	type TerminalLayout,
	type TerminalNesting,
} from "./types.ts";

/** Nesting for every layout, or per layout. */
export type TerminalNestingSetting =
	| TerminalNesting
	| Readonly<Partial<Record<TerminalLayout, TerminalNesting>>>;

/** One layer's choices. Any field may be left to a lower layer. */
export interface TerminalChoice {
	/** The terminal, by driver or launcher id. */
	readonly driver?: string;
	/** Where the new shell appears. */
	readonly layout?: TerminalLayout;
	/** Which terminal in a nested chain a layout goes to. */
	readonly nesting?: TerminalNestingSetting;
}

/** A launcher a person configured, in the built-in table's own shape. */
export interface TerminalLauncherSetting {
	readonly binary?: string;
	readonly app?: string;
	readonly window?: readonly string[];
	readonly tab?: readonly string[];
	readonly platforms?: Readonly<
		Partial<
			Record<
				"linux" | "darwin",
				| false
				| {
						readonly binary?: string;
						readonly app?: string;
						readonly window?: readonly string[];
						readonly tab?: readonly string[];
				  }
			>
		>
	>;
}

/** The `terminal` settings section. */
export interface TerminalSettings {
	readonly defaults?: TerminalChoice;
	readonly projects?: Readonly<Record<string, TerminalChoice>>;
	readonly quests?: Readonly<Record<string, TerminalChoice>>;
	/** Where a terminal's binary lives, by id, when PATH will not find it. */
	readonly drivers?: Readonly<Record<string, { readonly path?: string }>>;
	/** Launchers to add, or built-ins to replace, by id. */
	readonly launchers?: Readonly<Record<string, TerminalLauncherSetting>>;
	/**
	 * Words put in front of a blindly launched command, `{cwd}` filled
	 * in, such as `["direnv", "exec", "{cwd}"]`.
	 */
	readonly wrap?: readonly string[];
}

/** Where a choice came from. */
export type TerminalLayer =
	| "call"
	| "quest"
	| "project"
	| "defaults"
	| "built in";

/** A chosen value and the layer that chose it. */
export interface Chosen<T> {
	readonly value: T;
	readonly from: TerminalLayer;
}

/** What the layers settled on. A driver no layer named is left to discovery. */
export interface ResolvedTerminalChoice {
	readonly driver?: Chosen<string>;
	readonly layout: Chosen<TerminalLayout>;
	readonly nesting: Readonly<Record<TerminalLayout, Chosen<TerminalNesting>>>;
}

/** Where a request is being made from, for picking its layers. */
export interface TerminalPlace {
	/** The call's own choices. */
	readonly call?: TerminalChoice;
	/** The loaded quest's id. */
	readonly quest?: string;
	/** The session checkout's repository key. */
	readonly project?: string;
}

/** The layout chosen when no layer names one. */
export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = "tab";

/** The nesting chosen when no layer names one. */
export const DEFAULT_TERMINAL_NESTING: TerminalNesting = "innermost";

/** Settle the choices for a request, layer by layer. */
export function resolveTerminalChoice(
	settings: TerminalSettings | undefined,
	place: TerminalPlace = {},
): ResolvedTerminalChoice {
	const layers: [TerminalLayer, TerminalChoice | undefined][] = [
		["call", place.call],
		["quest", place.quest ? settings?.quests?.[place.quest] : undefined],
		[
			"project",
			place.project ? settings?.projects?.[place.project] : undefined,
		],
		["defaults", settings?.defaults],
	];
	const first = <T>(
		read: (choice: TerminalChoice) => T | undefined,
	): Chosen<T> | undefined => {
		for (const [from, choice] of layers) {
			const value = choice ? read(choice) : undefined;
			if (value !== undefined) return { value, from };
		}
		return undefined;
	};
	const driver = first((choice) => choice.driver);
	const layout = first((choice) => choice.layout) ?? {
		value: DEFAULT_TERMINAL_LAYOUT,
		from: "built in",
	};
	const nesting = Object.fromEntries(
		TERMINAL_LAYOUTS.map((each) => [
			each,
			first((choice) => nestingFor(choice.nesting, each)) ?? {
				value: DEFAULT_TERMINAL_NESTING,
				from: "built in",
			},
		]),
	) as Record<TerminalLayout, Chosen<TerminalNesting>>;
	return { ...(driver ? { driver } : {}), layout, nesting };
}

function nestingFor(
	setting: TerminalNestingSetting | undefined,
	layout: TerminalLayout,
): TerminalNesting | undefined {
	if (setting === undefined) return undefined;
	return typeof setting === "string" ? setting : setting[layout];
}

/** A parse that worked, or the field that did not. */
export type TerminalSettingsParse =
	| { readonly ok: true; readonly value: TerminalSettings }
	| { readonly ok: false; readonly error: string };

/**
 * Read a `terminal` section. An absent section is no settings; a
 * present one that is wrong anywhere is refused, naming the field,
 * rather than half read.
 */
export function parseTerminalSettings(value: unknown): TerminalSettingsParse {
	if (value === undefined) return { ok: true, value: {} };
	try {
		return { ok: true, value: readSettings(value, "terminal") };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const SECTION_KEYS = [
	"defaults",
	"projects",
	"quests",
	"drivers",
	"launchers",
	"wrap",
];
const CHOICE_KEYS = ["driver", "layout", "nesting"];
const NESTINGS: readonly TerminalNesting[] = ["innermost", "outermost"];
const LAUNCHER_KEYS = ["binary", "app", "window", "tab", "platforms"];
const FORM_KEYS = ["binary", "app", "window", "tab"];

function readSettings(value: unknown, at: string): TerminalSettings {
	const section = record(value, at);
	known(section, SECTION_KEYS, at);
	const out: {
		-readonly [K in keyof TerminalSettings]: TerminalSettings[K];
	} = {};
	if (section.defaults !== undefined)
		out.defaults = readChoice(section.defaults, `${at}.defaults`);
	if (section.projects !== undefined)
		out.projects = readChoices(section.projects, `${at}.projects`);
	if (section.quests !== undefined)
		out.quests = readChoices(section.quests, `${at}.quests`);
	if (section.drivers !== undefined) {
		const drivers = record(section.drivers, `${at}.drivers`);
		const read: Record<string, { path?: string }> = {};
		for (const [id, entry] of Object.entries(drivers)) {
			const where = `${at}.drivers.${id}`;
			const fields = record(entry, where);
			known(fields, ["path"], where);
			read[id] =
				fields.path === undefined
					? {}
					: { path: text(fields.path, `${where}.path`) };
		}
		out.drivers = read;
	}
	if (section.launchers !== undefined) {
		const launchers = record(section.launchers, `${at}.launchers`);
		const read: Record<string, TerminalLauncherSetting> = {};
		for (const [id, entry] of Object.entries(launchers)) {
			read[id] = readLauncher(entry, `${at}.launchers.${id}`);
		}
		out.launchers = read;
	}
	if (section.wrap !== undefined) out.wrap = words(section.wrap, `${at}.wrap`);
	return out;
}

function readChoices(
	value: unknown,
	at: string,
): Record<string, TerminalChoice> {
	const out: Record<string, TerminalChoice> = {};
	for (const [key, entry] of Object.entries(record(value, at))) {
		out[key] = readChoice(entry, `${at}["${key}"]`);
	}
	return out;
}

/** Read one layer's choices, as a call's parameters arrive too. */
export function readTerminalChoice(value: unknown, at: string): TerminalChoice {
	return readChoice(value, at);
}

function readChoice(value: unknown, at: string): TerminalChoice {
	const fields = record(value, at);
	known(fields, CHOICE_KEYS, at);
	const out: {
		driver?: string;
		layout?: TerminalLayout;
		nesting?: TerminalNestingSetting;
	} = {};
	if (fields.driver !== undefined)
		out.driver = text(fields.driver, `${at}.driver`);
	if (fields.layout !== undefined)
		out.layout = layoutOf(fields.layout, `${at}.layout`);
	if (fields.nesting !== undefined) {
		if (typeof fields.nesting === "string") {
			out.nesting = nestingOf(fields.nesting, `${at}.nesting`);
		} else {
			const per = record(fields.nesting, `${at}.nesting`);
			known(per, TERMINAL_LAYOUTS, `${at}.nesting`);
			const read: Partial<Record<TerminalLayout, TerminalNesting>> = {};
			for (const [layout, nesting] of Object.entries(per)) {
				read[layout as TerminalLayout] = nestingOf(
					nesting,
					`${at}.nesting.${layout}`,
				);
			}
			out.nesting = read;
		}
	}
	return out;
}

function readLauncher(value: unknown, at: string): TerminalLauncherSetting {
	const fields = record(value, at);
	known(fields, LAUNCHER_KEYS, at);
	const out: Record<string, unknown> = readForm(fields, at);
	if (fields.platforms !== undefined) {
		const platforms = record(fields.platforms, `${at}.platforms`);
		known(platforms, ["linux", "darwin"], `${at}.platforms`);
		const read: Record<string, unknown> = {};
		for (const [platform, form] of Object.entries(platforms)) {
			const where = `${at}.platforms.${platform}`;
			if (form === false) {
				read[platform] = false;
				continue;
			}
			const formFields = record(form, where);
			known(formFields, FORM_KEYS, where);
			read[platform] = readForm(formFields, where);
		}
		out.platforms = read;
	}
	return out as TerminalLauncherSetting;
}

function readForm(
	fields: Record<string, unknown>,
	at: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (fields.binary !== undefined)
		out.binary = text(fields.binary, `${at}.binary`);
	if (fields.app !== undefined) out.app = text(fields.app, `${at}.app`);
	for (const layout of ["window", "tab"] as const) {
		if (fields[layout] === undefined) continue;
		const template = words(fields[layout], `${at}.${layout}`);
		if (!template.includes("{argv}")) {
			throw new Error(
				`${at}.${layout} needs an "{argv}" element, where the command goes`,
			);
		}
		out[layout] = template;
	}
	return out;
}

function record(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${at} must be an object`);
	}
	return value as Record<string, unknown>;
}

function known(
	fields: Record<string, unknown>,
	allowed: readonly string[],
	at: string,
): void {
	for (const key of Object.keys(fields)) {
		if (!allowed.includes(key)) {
			throw new Error(
				`${at} has an unknown field "${key}"; the fields are ${allowed.join(", ")}`,
			);
		}
	}
}

function text(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${at} must be a non-empty string`);
	}
	return value;
}

function words(value: unknown, at: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((part) => typeof part === "string")
	) {
		throw new Error(`${at} must be a list of strings`);
	}
	return value as string[];
}

function layoutOf(value: unknown, at: string): TerminalLayout {
	if (
		typeof value === "string" &&
		(TERMINAL_LAYOUTS as readonly string[]).includes(value)
	) {
		return value as TerminalLayout;
	}
	throw new Error(`${at} must be one of ${TERMINAL_LAYOUTS.join(", ")}`);
}

function nestingOf(value: unknown, at: string): TerminalNesting {
	if (
		typeof value === "string" &&
		(NESTINGS as readonly string[]).includes(value)
	) {
		return value as TerminalNesting;
	}
	throw new Error(`${at} must be one of ${NESTINGS.join(", ")}`);
}
