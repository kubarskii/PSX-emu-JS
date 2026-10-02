import {parseCue, buildDiscStreaming} from "./cue";

const CUE_EXT = /\.cue$/i;
const DISC_EXT = /\.(bin|iso|img)$/i;

/**
 * @param {string} path - file name as written in a cue sheet
 * @return {string} - lower-cased base name (sheets may carry folders)
 */
function key(path) {
	return path.split(/[\\/]/).pop().toLowerCase();
}

/**
 * Picks what to launch from a set of user-selected files (a file picker
 * is the only way in on browsers without folder access, e.g. phones):
 * a .cue sheet together with its track files, or a single image/EXE.
 * @param {File[]} files
 * @return {{cue: File, tracks: Map<string, File>} | {single: File} | null}
 */
export function classifyFiles(files) {
	if (files.length === 0) return null;
	const cue = files.find((f) => CUE_EXT.test(f.name));
	if (cue !== undefined) {
		const tracks = new Map();
		for (const f of files) if (f !== cue) tracks.set(key(f.name), f);
		return {cue, tracks};
	}
	if (files.length === 1) return {single: files[0]};
	// several images without a sheet: the largest one is the game
	const discs = files.filter((f) => DISC_EXT.test(f.name));
	const pool = discs.length > 0 ? discs : files;
	return {single: pool.reduce((a, b) => (b.size > a.size ? b : a))};
}

/**
 * Assembles a multi-track disc from a cue sheet and the selected files.
 * @param {File} cue
 * @param {Map<string, File>} tracks - base name (lower-cased) -> file
 * @param {(done: number, total: number, file: string) => void} [onProgress]
 * @return {Promise<{buffer: ArrayBuffer, isRaw: boolean, tracks: object}>}
 */
export async function discFromCue(cue, tracks, onProgress) {
	const entries = parseCue(await cue.text());
	const sizes = new Map();
	for (const e of entries) {
		const f = tracks.get(key(e.file));
		if (f !== undefined) sizes.set(e.file.toLowerCase(), f.size);
	}
	const disc = await buildDiscStreaming(entries, sizes,
		(name) => tracks.get(key(name)).arrayBuffer(), onProgress);
	return {buffer: disc.buffer, isRaw: true, tracks: disc.tracks};
}
