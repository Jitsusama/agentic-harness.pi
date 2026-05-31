/**
 * Persona CRUD actions for pr-workflow.
 *
 * A persona lives as one markdown file in the personas directory,
 * so create, edit and remove are plain filesystem operations.
 * These handlers wrap those operations with the guard rails the
 * tool surface needs — refuse to clobber on add, refuse to edit or
 * remove what is not there — and return structured results the
 * tool layer renders as text.
 */

import { access, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type LoadedPersonas,
	type PersonaDraft,
	serializePersona,
} from "./personas.js";

/** Outcome of a persona CRUD action. */
export type PersonaActionResult = { ok: true } | { ok: false; error: string };

/** A persona draft together with the id that names its file. */
export interface PersonaWrite extends PersonaDraft {
	readonly id: string;
}

const PERSONA_FILE_SUFFIX = ".md";

function personaPath(dir: string, id: string): string {
	return join(dir, `${id}${PERSONA_FILE_SUFFIX}`);
}

/**
 * Create a new persona file. Refuses if a file for the id already
 * exists, so an add never silently overwrites an existing lens;
 * use {@link editPersona} to change one in place.
 */
export async function addPersona(
	dir: string,
	write: PersonaWrite,
): Promise<PersonaActionResult> {
	const path = personaPath(dir, write.id);
	try {
		// "wx" fails if the path already exists, so the existence
		// check and the write are one atomic step — no clobber race.
		await writeFile(path, serializePersona(write), { flag: "wx" });
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			return {
				ok: false,
				error: `Persona "${write.id}" already exists. Use persona-edit to change it.`,
			};
		}
		throw error;
	}
	return { ok: true };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/**
 * Rewrite an existing persona file in place. Refuses if no file
 * for the id exists, so an edit never resurrects a removed persona
 * or creates one by typo; use {@link addPersona} to create.
 */
export async function editPersona(
	dir: string,
	write: PersonaWrite,
): Promise<PersonaActionResult> {
	const path = personaPath(dir, write.id);
	if (!(await fileExists(path))) {
		return {
			ok: false,
			error: `Persona "${write.id}" does not exist. Use persona-add to create it.`,
		};
	}
	await writeFile(path, serializePersona(write));
	return { ok: true };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		// access throws ENOENT (and only ENOENT in practice here,
		// since the dir is ours) when the file is absent; absence
		// is the answer the caller wants, not an error to surface.
		return false;
	}
}

/**
 * Delete a persona file. Refuses if no file for the id exists, so
 * a remove of a typo'd or already-gone id is a clear error rather
 * than a silent no-op.
 */
export async function removePersona(
	dir: string,
	id: string,
): Promise<PersonaActionResult> {
	try {
		await unlink(personaPath(dir, id));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				ok: false,
				error: `Persona "${id}" does not exist; nothing to remove.`,
			};
		}
		throw error;
	}
	return { ok: true };
}

/** Format a loaded persona library as a human-readable list. */
export function formatPersonaList(loaded: LoadedPersonas): string {
	const lines: string[] = [];
	if (loaded.personas.length === 0 && loaded.errors.length === 0) {
		return "No personas defined. Add one with persona-add.";
	}
	for (const persona of loaded.personas) {
		lines.push(`${persona.id} — ${persona.name}`);
		lines.push(`  ${persona.description}`);
	}
	if (loaded.errors.length > 0) {
		lines.push("");
		lines.push("Skipped (failed to parse):");
		for (const error of loaded.errors) {
			lines.push(`  ${error.id}: ${error.error}`);
		}
	}
	return lines.join("\n");
}
