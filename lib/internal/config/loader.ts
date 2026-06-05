/**
 * Shared loader for the single package configuration file.
 */

import { readFile } from "node:fs/promises";
import { packageConfigPath } from "../paths.js";

/** Configuration version written by a fresh, empty config. */
const EMPTY_CONFIG: PackageConfig = { version: 1, sections: {} };

/** The validated package configuration envelope. */
export interface PackageConfig {
	version: number;
	sections: Record<string, unknown>;
}

/**
 * An extension's parser for its own section. It must treat
 * `undefined` as "section absent, use defaults" and return ok.
 */
export type SectionParse<T> = (
	value: unknown,
) => { ok: true; value: T } | { ok: false; error: string };

/** Result of loading the package configuration file. */
export type ConfigLoadResult =
	| { ok: true; path: string; config: PackageConfig }
	| { ok: false; path: string; error: string };

/** Load and validate the package configuration file. */
export async function loadPackageConfig(
	path: string = packageConfigPath(),
): Promise<ConfigLoadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { ok: true, path, config: { ...EMPTY_CONFIG } };
		}
		return {
			ok: false,
			path,
			error: `Could not read package config at ${path}: ${errorMessage(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Could not parse package config at ${path}: ${errorMessage(error)}`,
		};
	}
	const envelope = validateEnvelope(parsed);
	if (!envelope.ok) {
		return {
			ok: false,
			path,
			error: `Invalid package config at ${path}: ${envelope.error}`,
		};
	}
	return { ok: true, path, config: envelope.config };
}

/**
 * Validate the on-disk shape into a {@link PackageConfig}. The
 * root must be an object, `sections` must be an object when
 * present, and `version` defaults to the current version when
 * absent so a hand-written file need not spell it out.
 */
function validateEnvelope(
	value: unknown,
): { ok: true; config: PackageConfig } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "root must be an object" };
	}
	if (value.version !== undefined && typeof value.version !== "number") {
		return { ok: false, error: "version must be a number" };
	}
	if (value.sections !== undefined && !isRecord(value.sections)) {
		return { ok: false, error: "sections must be an object" };
	}
	return {
		ok: true,
		config: {
			version: value.version ?? EMPTY_CONFIG.version,
			sections: value.sections ?? {},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one extension's section through its own parser. A valid
 * section parses to its value; a missing or invalid section
 * falls back to the parser's defaults (the value it returns for
 * `undefined`), with an invalid section also surfacing a warning
 * so one extension's bad config never throws or poisons another.
 */
export function getSection<T>(
	config: PackageConfig,
	slug: string,
	parse: SectionParse<T>,
): { value: T; warning?: string } {
	const raw = config.sections[slug];
	const result = parse(raw);
	if (result.ok) return { value: result.value };
	const defaults = parse(undefined);
	if (!defaults.ok) {
		// A parser that cannot produce defaults from `undefined`
		// breaks its contract; surface both errors rather than
		// guessing a value.
		throw new Error(
			`Section parser for "${slug}" rejected its own defaults: ${defaults.error} (after: ${result.error})`,
		);
	}
	return { value: defaults.value, warning: result.error };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
