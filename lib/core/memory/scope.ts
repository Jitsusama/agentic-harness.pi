/**
 * Scope serialization. A fact's scope is stored as a single
 * string key so recall is a plain lookup; this is the only
 * place that shape is minted.
 *
 * Deliberately not here: resolving *which* scope currently
 * applies. Pi derives that from its own session log (the loaded
 * quest, or the project at ctx.cwd); a host with no quest system
 * has nothing equivalent to derive from. Each adapter decides its
 * own current scope and passes the resulting `Scope` value in.
 */

import type { Scope } from "./types.ts";

/** The canonical string key for a scope. */
export function serializeScope(scope: Scope): string {
	switch (scope.kind) {
		case "global":
			return "global";
		case "project":
			return `project:${scope.path}`;
		case "quest":
			return `quest:${scope.id}`;
	}
}
