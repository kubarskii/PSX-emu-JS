/**
 * Minimal .cue sheet support: enough for the common PSX layout of one
 * MODE2/2352 data track plus CDDA audio tracks, one file per track or a
 * single file with indexes.
 */

/**
 * @param {string} text - cue sheet content
 * @return {Array<{file: string, track: number, audio: boolean, index1: number}>}
 *   index1 is the INDEX 01 offset (in sectors) within the file
 */
export function parseCue(text) {
	const entries = [];
	let file = null;
	let current = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		let m = line.match(/^FILE\s+"([^"]+)"/i) || line.match(/^FILE\s+(\S+)/i);
		if (m) {
			file = m[1];
			continue;
		}
		m = line.match(/^TRACK\s+(\d+)\s+(\S+)/i);
		if (m) {
			const mode = m[2].toUpperCase();
			current = {
				file,
				track: parseInt(m[1], 10),
				audio: mode === "AUDIO",
				sectorSize: mode.endsWith("/2048") ? 2048 : mode.endsWith("/2336") ? 2336 : 2352,
				index1: 0,
			};
			entries.push(current);
			continue;
		}
		m = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i);
		if (m && current !== null && parseInt(m[1], 10) === 1) {
			current.index1 =
				(parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 75 + parseInt(m[4], 10);
		}
	}
	return entries;
}

/**
 * Groups cue entries by file, preserving cue order.
 * @param {Array<{file: string, track: number, audio: boolean, index1: number}>} entries
 * @return {Array<{name: string, tracks: Array<object>}>}
 */
function groupByFile(entries) {
	const files = [];
	for (const e of entries) {
		if (files.length === 0 || files[files.length - 1].name !== e.file) {
			files.push({name: e.file, tracks: []});
		}
		files[files.length - 1].tracks.push(e);
	}
	return files;
}

/**
 * @param {Array<{name: string, tracks: Array<object>}>} files - each
 *   annotated with .outSize (byte length after raw expansion), in cue order
 * @return {Array<{number: number, startLba: number, audio: boolean}>}
 */
function trackTable(files) {
	const tracks = [];
	let offset = 0;
	for (const f of files) {
		const baseLba = Math.floor(offset / 2352);
		for (const t of f.tracks) {
			tracks.push({number: t.track, startLba: baseLba + t.index1, audio: t.audio});
		}
		offset += f.outSize;
	}
	tracks.sort((a, b) => a.number - b.number);
	return tracks;
}

/** @param {number} n @return {number} - BCD byte */
function toBcd(n) {
	return ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
}

/**
 * Sector size of a cue file (from its first track; mixed-mode files
 * within one FILE are not a thing in practice).
 * @param {{tracks: Array<{sectorSize?: number, audio: boolean}>}} f
 * @return {number}
 */
function fileSectorSize(f) {
	const t = f.tracks[0];
	return t.audio ? 2352 : (t.sectorSize || 2352);
}

/**
 * Expands MODE1/2048 or MODE2/2336 file content into raw 2352-byte
 * sectors (sync + BCD MSF header + mode 2 + subheader), which is the
 * only layout the CDROM core addresses. 2048-byte sectors get a
 * synthesized MODE2 Form1 subheader; 2336-byte sectors already carry
 * their own subheader.
 * @param {Uint8Array} src
 * @param {number} secSize - 2048 or 2336
 * @param {number} startLba - absolute LBA of the file's first sector
 * @param {Uint8Array} out
 * @param {number} outOffset
 */
function expandToRaw(src, secSize, startLba, out, outOffset) {
	const count = Math.floor(src.length / secSize);
	for (let s = 0; s < count; s++) {
		const o = outOffset + s * 2352;
		out[o] = 0;
		out.fill(0xff, o + 1, o + 11);
		out[o + 11] = 0;
		const pos = startLba + s + 150;
		out[o + 12] = toBcd(Math.floor(pos / 4500));
		out[o + 13] = toBcd(Math.floor(pos / 75) % 60);
		out[o + 14] = toBcd(pos % 75);
		out[o + 15] = 2;
		if (secSize === 2048) {
			// MODE2 Form1 subheader: file 0, channel 0, submode "data", coding 0
			out[o + 16] = 0; out[o + 17] = 0; out[o + 18] = 0x08; out[o + 19] = 0;
			out[o + 20] = 0; out[o + 21] = 0; out[o + 22] = 0x08; out[o + 23] = 0;
			out.set(src.subarray(s * 2048, (s + 1) * 2048), o + 24);
		} else {
			out.set(src.subarray(s * 2336, (s + 1) * 2336), o + 16);
		}
	}
}

/**
 * Assembles a multi-file cue into one contiguous image plus a track
 * table with absolute LBAs.
 * @param {Array<{file: string, track: number, audio: boolean, index1: number}>} entries
 * @param {Map<string, ArrayBuffer>} buffers - file name (lower-cased) -> content
 * @return {{buffer: ArrayBuffer, tracks: Array<{number: number, startLba: number, audio: boolean}>}}
 */
export function buildDisc(entries, buffers) {
	const files = groupByFile(entries);
	let total = 0;
	for (const f of files) {
		const buf = buffers.get(f.name.toLowerCase());
		if (buf === undefined) throw new Error(`cue references missing file: ${f.name}`);
		f.buffer = buf;
		f.size = buf.byteLength;
		f.secSize = fileSectorSize(f);
		f.outSize = f.secSize === 2352
			? buf.byteLength
			: Math.floor(buf.byteLength / f.secSize) * 2352;
		total += f.outSize;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const f of files) {
		const src = new Uint8Array(f.buffer);
		if (f.secSize === 2352) {
			out.set(src, offset);
		} else {
			expandToRaw(src, f.secSize, Math.floor(offset / 2352), out, offset);
		}
		offset += f.outSize;
	}
	return {buffer: out.buffer, tracks: trackTable(files)};
}

/**
 * Assembles a multi-file cue one file at a time instead of holding
 * every track's full content in memory at once - a 15-track disc can
 * be 600MB+, and buffering every file before concatenating roughly
 * doubles peak memory for no benefit.
 * @param {Array<{file: string, track: number, audio: boolean, index1: number}>} entries
 * @param {Map<string, number>} sizes - file name (lower-cased) -> byte size
 * @param {(fileName: string) => Promise<ArrayBuffer>} readFile
 * @param {(done: number, total: number, fileName: string) => void} [onProgress]
 * @return {Promise<{buffer: ArrayBuffer, tracks: Array<{number: number, startLba: number, audio: boolean}>}>}
 */
export async function buildDiscStreaming(entries, sizes, readFile, onProgress) {
	const files = groupByFile(entries);
	let total = 0;
	for (const f of files) {
		const size = sizes.get(f.name.toLowerCase());
		if (size === undefined) throw new Error(`cue references missing file: ${f.name}`);
		f.size = size;
		f.secSize = fileSectorSize(f);
		f.outSize = f.secSize === 2352 ? size : Math.floor(size / f.secSize) * 2352;
		total += f.outSize;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		const buf = await readFile(f.name);
		const src = new Uint8Array(buf);
		if (f.secSize === 2352) {
			out.set(src, offset);
		} else {
			expandToRaw(src, f.secSize, Math.floor(offset / 2352), out, offset);
		}
		offset += f.outSize;
		if (onProgress) onProgress(i + 1, files.length, f.name);
	}
	return {buffer: out.buffer, tracks: trackTable(files)};
}
