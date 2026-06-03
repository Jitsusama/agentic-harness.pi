/**
 * Identity document model: parse and serialize the markdown
 * file that represents one identity in the people registry.
 *
 * The on-disk shape:
 *
 *     ---
 *     id: joel-gerber
 *     names:
 *       - Joel Gerber
 *       - Joel
 *     handles:
 *       - slack:joel.gerber
 *       - github:Jitsusama
 *       - email:joel.gerber@shopify.com
 *     ---
 *
 *     # Joel Gerber
 *
 *     ## quest-workflow
 *
 *     ```json
 *     { "lastSeenAs": "originator" }
 *     ```
 *
 *     ## mastery
 *
 *     Mark Dorison's report.
 *
 *     ```json
 *     { "team": "Privacy Engineering" }
 *     ```
 *
 * Front-matter holds canonical identity data (id, names,
 * handles). Body sections hold namespaced metadata as JSON
 * code blocks. Prose around the JSON blocks is preserved on
 * round-trip when the writer only mutates metadata; full
 * rewrites discard prose.
 */

import type { Handle, Identity } from "../../people/types.js";

/** A parsed identity document. */
export interface IdentityDoc {
	identity: Identity;
	/** Metadata by namespace. JSON-shaped values. */
	metadata: Record<string, Record<string, unknown>>;
	/**
	 * Raw body text after the closing front-matter `---`.
	 * Preserved so writers can perform surgical metadata
	 * mutations without flattening user prose.
	 */
	body: string;
}

function parseHandle(raw: string): Handle | undefined {
	const colon = raw.indexOf(":");
	if (colon <= 0) return undefined;
	const type = raw.slice(0, colon).trim();
	const value = raw.slice(colon + 1).trim();
	if (!type || !value) return undefined;
	return { type, value };
}

interface ParsedFrontMatter {
	id?: string;
	names: string[];
	handles: Handle[];
}

function parseFrontMatter(lines: string[]): ParsedFrontMatter {
	const result: ParsedFrontMatter = { names: [], handles: [] };
	let inNames = false;
	let inHandles = false;

	for (const line of lines) {
		const listItem = /^\s+-\s+(.*)$/.exec(line);
		if (listItem) {
			const value = listItem[1].trim();
			if (inNames) result.names.push(value);
			else if (inHandles) {
				const handle = parseHandle(value);
				if (handle) result.handles.push(handle);
			}
			continue;
		}
		inNames = false;
		inHandles = false;
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const [, key, raw] = kv;
		const value = raw.trim();
		if (key === "id") result.id = value;
		else if (key === "names") {
			if (value === "" || value === "[]") {
				inNames = true;
			}
		} else if (key === "handles") {
			if (value === "" || value === "[]") {
				inHandles = true;
			}
		}
	}
	return result;
}

/**
 * Walk the body and extract namespace metadata blocks. Each
 * `## <namespace>` heading begins a section; the first
 * ```json code block in that section becomes the metadata
 * for that namespace. Headings that don't have a JSON block
 * still surface as namespaces (with empty metadata).
 */
function parseMetadata(body: string): Record<string, Record<string, unknown>> {
	const metadata: Record<string, Record<string, unknown>> = {};
	const lines = body.split("\n");
	let currentNamespace: string | undefined;
	let inJsonBlock = false;
	let jsonBuffer: string[] = [];
	let jsonClaimed = false;

	const flushJson = () => {
		if (!currentNamespace) return;
		try {
			const parsed = JSON.parse(jsonBuffer.join("\n"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				metadata[currentNamespace] = parsed as Record<string, unknown>;
				jsonClaimed = true;
			}
		} catch {
			// Malformed JSON inside a metadata block is
			// treated as absent metadata for this section.
			// The block stays in the body unchanged on
			// round-trip; we just can't read it.
		}
		jsonBuffer = [];
	};

	for (const line of lines) {
		const heading = /^##\s+(.+)$/.exec(line);
		if (heading && !inJsonBlock) {
			currentNamespace = heading[1].trim();
			jsonClaimed = false;
			if (!(currentNamespace in metadata)) metadata[currentNamespace] = {};
			continue;
		}
		if (
			line.trimStart().startsWith("```json") &&
			!inJsonBlock &&
			!jsonClaimed
		) {
			inJsonBlock = true;
			jsonBuffer = [];
			continue;
		}
		if (inJsonBlock && line.trimStart().startsWith("```")) {
			inJsonBlock = false;
			flushJson();
			continue;
		}
		if (inJsonBlock) jsonBuffer.push(line);
	}

	return metadata;
}

/**
 * Parse an identity document. Returns `undefined` when the
 * text has no valid front-matter or no id.
 */
export function parseIdentity(text: string): IdentityDoc | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return undefined;

	const frontMatter = parseFrontMatter(lines.slice(1, end));
	if (!frontMatter.id) return undefined;

	let body = lines.slice(end + 1).join("\n");
	if (body.startsWith("\n")) body = body.slice(1);

	const metadata = parseMetadata(body);

	return {
		identity: {
			id: frontMatter.id,
			names: frontMatter.names,
			handles: frontMatter.handles,
		},
		metadata,
		body,
	};
}

function serializeFrontMatter(identity: Identity): string {
	const lines: string[] = [`id: ${identity.id}`];
	if (identity.names.length === 0) {
		lines.push("names: []");
	} else {
		lines.push("names:");
		for (const name of identity.names) lines.push(`  - ${name}`);
	}
	if (identity.handles.length === 0) {
		lines.push("handles: []");
	} else {
		lines.push("handles:");
		for (const handle of identity.handles) {
			lines.push(`  - ${handle.type}:${handle.value}`);
		}
	}
	return ["---", ...lines, "---"].join("\n");
}

function serializeMetadata(
	metadata: Record<string, Record<string, unknown>>,
): string {
	const namespaces = Object.keys(metadata).sort();
	if (namespaces.length === 0) return "";
	const sections: string[] = [];
	for (const ns of namespaces) {
		const data = metadata[ns];
		const json = JSON.stringify(data, null, 2);
		sections.push(`## ${ns}\n\n\`\`\`json\n${json}\n\`\`\``);
	}
	return sections.join("\n\n");
}

/**
 * Serialize an identity document. Body is regenerated from
 * the canonical sections (H1 title plus per-namespace
 * metadata blocks); free prose is not preserved across full
 * serialization. Callers that want to keep prose should mutate
 * `IdentityDoc.body` directly.
 */
export function serializeIdentity(doc: IdentityDoc): string {
	const fm = serializeFrontMatter(doc.identity);
	const title = doc.identity.names[0] ?? doc.identity.id;
	const body = serializeMetadata(doc.metadata);
	const sections = [fm, "", `# ${title}`];
	if (body) sections.push("", body);
	return `${sections.join("\n")}\n`;
}
