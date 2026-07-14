import {saveLibraryHandle, loadLibraryHandle} from "../loader/db";
import {parseCue, buildDiscStreaming} from "../loader/cue";
import {t} from "./i18n";

/**
 * Game library backed by a folder on disk (File System Access API).
 * Each game is a .bin/.iso/.img file, either at the top level (cover =
 * image with the same base name) or inside its own subfolder (cover =
 * any image in that folder).
 */

const DISC_EXT = /\.(bin|iso|img)$/i;
const EXE_EXT = /\.(exe|psexe)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i;
const CUE_EXT = /\.cue$/i;

/** @return {boolean} - browser supports the File System Access API */
export function librarySupported() {
	return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/**
 * Asks the user to pick the games folder and persists the handle.
 * @return {Promise<FileSystemDirectoryHandle | null>}
 */
export async function pickLibraryFolder() {
	try {
		const handle = await window.showDirectoryPicker({id: "psx-games", mode: "read"});
		await saveLibraryHandle(handle);
		return handle;
	} catch {
		return null; // user cancelled
	}
}

/**
 * Restores the persisted folder handle when permission is still granted
 * (or can be re-granted with one click later).
 * @return {Promise<{handle: FileSystemDirectoryHandle, granted: boolean} | null>}
 */
export async function restoreLibraryFolder() {
	const handle = await loadLibraryHandle().catch(() => null);
	if (!handle) return null;
	const state = await handle.queryPermission({mode: "read"});
	return {handle, granted: state === "granted"};
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @return {Promise<boolean>} - permission granted (must run in a user gesture)
 */
export async function requestLibraryPermission(handle) {
	return (await handle.requestPermission({mode: "read"})) === "granted";
}

/**
 * Scans the library folder for games.
 * @param {FileSystemDirectoryHandle} root
 * @return {Promise<Array<{
 *   name: string,
 *   file: FileSystemFileHandle,
 *   size: number,
 *   isExe: boolean,
 *   coverUrl: string | null,
 * }>>}
 */
export async function scanLibrary(root) {
	const games = [];
	const topFiles = [];
	const topImages = new Map();
	const topAll = new Map();
	let topCue = null;

	for await (const entry of root.values()) {
		if (entry.kind === "directory") {
			const game = await scanGameFolder(entry);
			if (game !== null) games.push(game);
			continue;
		}
		topAll.set(entry.name.toLowerCase(), entry);
		if (CUE_EXT.test(entry.name)) topCue = entry;
		else if (DISC_EXT.test(entry.name) || EXE_EXT.test(entry.name)) topFiles.push(entry);
		else if (IMAGE_EXT.test(entry.name)) topImages.set(baseName(entry.name).toLowerCase(), entry);
	}

	if (topCue !== null) {
		const cover = topImages.get(baseName(topCue.name).toLowerCase())
			|| topImages.values().next().value || null;
		const raw = baseName(topCue.name);
		games.push(await makeCueGame(cleanTitle(raw), raw, topCue, topAll, cover));
	} else {
		for (const file of topFiles) {
			const cover = topImages.get(baseName(file.name).toLowerCase()) || null;
			const raw = baseName(file.name);
			games.push(await makeGame(cleanTitle(raw), raw, file, cover));
		}
	}

	// metadata written by tools/fetch-tgdb.mjs lives next to the games
	const metaHandle = topAll.get("psx-metadata.json");
	if (metaHandle !== undefined) {
		try {
			const map = JSON.parse(await (await metaHandle.getFile()).text());
			for (const g of games) g.meta = pickMeta(map, g.rawName, g.name);
		} catch (err) {
			// a broken metadata file must not break the library
		}
	}
	// games the folder file did not cover fall back to the snapshot
	// bundled with the app (public/psx-metadata.json)
	if (games.some((g) => !g.meta)) {
		const bundled = await loadBundledMeta();
		for (const g of games) {
			if (!g.meta) g.meta = pickMeta(bundled, g.rawName, g.name);
		}
	}

	games.sort((a, b) => a.name.localeCompare(b.name));
	return games;
}

/** cached content of the metadata snapshot shipped with the app */
let bundledMeta = null;

/** @return {Promise<Object<string, object>>} */
async function loadBundledMeta() {
	if (bundledMeta !== null) return bundledMeta;
	try {
		const res = await fetch("psx-metadata.json");
		bundledMeta = res.ok ? await res.json() : {};
	} catch (err) {
		bundledMeta = {};
	}
	return bundledMeta;
}

/**
 * Finds a game's metadata entry: by exact raw name first, then by the
 * cleaned title (folder games may be keyed by folder OR file name).
 * @param {Object<string, object>} map - psx-metadata.json content
 * @param {string} rawName
 * @param {string} name - cleaned display title
 * @return {object | null}
 */
export function pickMeta(map, rawName, name) {
	if (map[rawName] !== undefined) return map[rawName];
	const want = name.toLowerCase();
	for (const key of Object.keys(map)) {
		const m = map[key];
		if (cleanTitle(key).toLowerCase() === want ||
			(m.title && m.title.toLowerCase() === want)) {
			return m;
		}
	}
	return null;
}

/**
 * Looks for the game disc/exe and a cover inside one folder (recursing
 * one level into nested folders, e.g. releases wrapped twice).
 * @param {FileSystemDirectoryHandle} dir
 * @param {number} [depth]
 * @return {Promise<object | null>}
 */
async function scanGameFolder(dir, depth = 0) {
	let best = null;
	let cover = null;
	let cue = null;
	const subdirs = [];
	const all = new Map();

	for await (const entry of dir.values()) {
		if (entry.kind === "directory") {
			subdirs.push(entry);
			continue;
		}
		all.set(entry.name.toLowerCase(), entry);
		if (CUE_EXT.test(entry.name)) {
			cue = entry;
		} else if (DISC_EXT.test(entry.name) || EXE_EXT.test(entry.name)) {
			const f = await entry.getFile();
			if (best === null || f.size > best.size) best = {handle: entry, size: f.size};
		} else if (cover === null && IMAGE_EXT.test(entry.name)) {
			cover = entry;
		}
	}

	if (cue !== null) {
		return makeCueGame(cleanTitle(dir.name), dir.name, cue, all, cover);
	}
	if (best === null && depth < 2) {
		for (const sub of subdirs) {
			const nested = await scanGameFolder(sub, depth + 1);
			if (nested !== null) {
				if (nested.coverUrl === null && cover !== null) {
					nested.coverUrl = await coverUrl(cover);
				}
				return nested;
			}
		}
	}
	if (best === null) return null;
	// prefer the disc file's own name for online cover lookup: it usually
	// carries the full Redump title even when the folder was renamed
	return makeGame(cleanTitle(dir.name), baseName(best.handle.name), best.handle, cover);
}

/**
 * Single-file game (bin/iso/exe).
 * @param {string} name
 * @param {string} rawName - file/folder name for online cover lookup
 * @param {FileSystemFileHandle} fileHandle
 * @param {FileSystemFileHandle | null} coverHandle
 * @return {Promise<object>}
 */
async function makeGame(name, rawName, fileHandle, coverHandle) {
	const f = await fileHandle.getFile();
	const isExe = EXE_EXT.test(fileHandle.name);
	return {
		name,
		rawName,
		size: f.size,
		isExe,
		trackCount: 1,
		coverUrl: coverHandle !== null ? await coverUrl(coverHandle) : null,
		async getDisc() {
			const buffer = await (await fileHandle.getFile()).arrayBuffer();
			if (isExe) return {exe: buffer};
			// raw images start with the 12-byte sync pattern; the size
			// heuristic misfires on ISOs whose size divides both 2048/2352
			const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
			let isRaw = b.length === 12 && b[0] === 0 && b[11] === 0;
			for (let i = 1; isRaw && i < 11; i++) isRaw = b[i] === 0xff;
			return {buffer, isRaw, tracks: null};
		},
	};
}

/**
 * Multi-track game described by a .cue: the disc is assembled from every
 * referenced file at launch time.
 * @param {string} name
 * @param {string} rawName - file/folder name for online cover lookup
 * @param {FileSystemFileHandle} cueHandle
 * @param {Map<string, FileSystemFileHandle>} siblings - files in the folder
 * @param {FileSystemFileHandle | null} coverHandle
 * @return {Promise<object>}
 */
async function makeCueGame(name, rawName, cueHandle, siblings, coverHandle) {
	const text = await (await cueHandle.getFile()).text();
	const entries = parseCue(text);
	const sizes = new Map();
	let size = 0;
	for (const e of new Set(entries.map((x) => x.file.toLowerCase()))) {
		const h = siblings.get(e);
		if (h !== undefined) {
			const s = (await h.getFile()).size;
			sizes.set(e, s);
			size += s;
		}
	}
	return {
		name,
		rawName,
		size,
		isExe: false,
		trackCount: entries.length,
		coverUrl: coverHandle !== null ? await coverUrl(coverHandle) : null,
		/**
		 * Reads and concatenates the track files one at a time (a large
		 * multi-track disc can be 600MB+) instead of buffering all of
		 * them before assembling the final image.
		 * @param {(done: number, total: number, fileName: string) => void} [onProgress]
		 */
		async getDisc(onProgress) {
			const readFile = async (fileName) => {
				const h = siblings.get(fileName.toLowerCase());
				if (h === undefined) throw new Error(t("cueMissingFile", {file: fileName}));
				return (await h.getFile()).arrayBuffer();
			};
			const disc = await buildDiscStreaming(entries, sizes, readFile, onProgress);
			return {buffer: disc.buffer, isRaw: true, tracks: disc.tracks};
		},
	};
}

/**
 * @param {FileSystemFileHandle} handle
 * @return {Promise<string>}
 */
async function coverUrl(handle) {
	const f = await handle.getFile();
	return URL.createObjectURL(f);
}

/**
 * @param {string} n
 * @return {string}
 */
function baseName(n) {
	return n.replace(/\.[^.]+$/, "");
}

/**
 * Strips release-dump noise: bracketed tags, region parens, underscores.
 * @param {string} n
 * @return {string}
 */
export function cleanTitle(n) {
	return n
		.replace(/\[[^\]]*\]?/g, "")
		.replace(/\([^)]*\)?/g, "")
		.replace(/[_.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim() || n;
}
