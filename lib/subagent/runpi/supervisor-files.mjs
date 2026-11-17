/**
 * How the supervisor writes its files: the stream logs it appends to
 * and rotates, and the lease, progress and result it replaces whole.
 *
 * Plain `.mjs`, as the supervisor is, because node runs that script
 * directly and won't strip types under `node_modules`.
 */

import {
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";

/**
 * Append a chunk to a log, first rotating it into gzipped
 * `<path>.1.gz` and on once the chunk would take it past `maxBytes`,
 * keeping at most `maxRotations` of those.
 *
 * @param {string} path
 * @param {Buffer} chunk
 * @param {{ maxBytes: number, maxRotations: number }} options
 */
export async function appendRotating(path, chunk, options) {
	await mkdir(dirname(path), { recursive: true });
	const current = await size(path);
	if (current > 0 && current + chunk.byteLength > options.maxBytes) {
		await rotateCompressed(path, options.maxRotations);
	}
	await appendFile(path, chunk);
}

/**
 * @param {string} path
 * @param {number} maxRotations
 */
async function rotateCompressed(path, maxRotations) {
	for (let index = maxRotations; index >= 1; index--) {
		const current = rotationPath(path, index);
		const next = rotationPath(path, index + 1);
		if (!(await exists(current))) continue;
		if (index === maxRotations) {
			await rm(current, { force: true });
		} else {
			await rename(current, next);
		}
	}
	const first = rotationPath(path, 1);
	const source = `${path}.${process.pid}.${Date.now()}.rotate`;
	await rename(path, source);
	await gzipFile(source, first);
	await rm(source, { force: true });
}

/**
 * @param {string} source
 * @param {string} destination
 */
async function gzipFile(source, destination) {
	const input = await readFile(source);
	const compressed = await gzipBuffer(input);
	await writeFile(destination, compressed);
}

/**
 * @param {Buffer} input
 * @returns {Promise<Buffer>}
 */
function gzipBuffer(input) {
	return new Promise((resolve, reject) => {
		const gzip = createGzip();
		/** @type {Buffer[]} */
		const chunks = [];
		gzip.on("data", (chunk) => chunks.push(chunk));
		gzip.once("error", reject);
		gzip.once("end", () => resolve(Buffer.concat(chunks)));
		gzip.end(input);
	});
}

/**
 * @param {string} path
 * @param {number} index
 */
function rotationPath(path, index) {
	return `${path}.${index}.gz`;
}

/**
 * Replace a file with a value as tab-indented JSON, through a
 * temporary file renamed over it, so a reader never sees half of one.
 *
 * @param {string} path
 * @param {unknown} value
 */
export async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	await rename(tmp, path);
}

/**
 * Whether anything is at a path.
 *
 * @param {string} path
 */
export async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} path */
async function size(path) {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}
