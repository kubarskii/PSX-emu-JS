/**
 * Diagnostic: captures a real MDEC decode from Diablo's FMV and compares
 * our fixed-point pipeline against a float reference IDCT.
 */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const CUE = "D:\\PSX\\Diablo (USA) (En,Fr,De,Sv)\\Diablo (USA) (En,Fr,De,Sv).cue";

const ZAGZIG = [
	0, 1, 8, 16, 9, 2, 3, 10,
	17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34,
	27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36,
	29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46,
	53, 60, 61, 54, 47, 55, 62, 63,
];
const ext10 = (v) => (v << 22) >> 22;

/** float reference: dequant + true 2D IDCT for one RL-coded block */
function refBlock(codes, pos, qt) {
	const F = new Float64Array(64);
	let n = codes[pos.i++];
	while (n === 0xfe00 && pos.i < codes.length) n = codes[pos.i++];
	if (n === 0xfe00 || pos.i > codes.length) return null;
	const qScale = (n >> 10) & 0x3f;
	let k = 0;
	let val = ext10(n & 0x3ff) * qt[0];
	for (;;) {
		if (qScale === 0) val = ext10(n & 0x3ff) * 2;
		val = Math.max(-0x400, Math.min(0x3ff, val));
		F[qScale > 0 ? ZAGZIG[k] : k] = val;
		n = codes[pos.i++];
		if (n === 0xfe00 || n === undefined) break;
		k += ((n >> 10) & 0x3f) + 1;
		if (k > 63) break;
		val = (ext10(n & 0x3ff) * qt[k] * qScale + 4) / 8;
		val = val < 0 ? Math.ceil(val) : Math.floor(val);
	}
	// true 2D IDCT
	const out = new Float64Array(64);
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			let s = 0;
			for (let v = 0; v < 8; v++) {
				for (let u = 0; u < 8; u++) {
					const cu = u === 0 ? Math.SQRT1_2 : 1;
					const cv = v === 0 ? Math.SQRT1_2 : 1;
					s += cu * cv * F[u + v * 8] *
						Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
						Math.cos(((2 * y + 1) * v * Math.PI) / 16);
				}
			}
			out[x + y * 8] = s / 4;
		}
	}
	return out;
}

const RUN = process.env.PSX_GAMES === "1";
(RUN ? it : it.skip)("compares a captured macroblock against the float reference", () => {
	const dir = path.dirname(CUE);
	const entries = parseCue(fs.readFileSync(CUE, "utf8"));
	const buffers = new Map();
	for (const e of entries) {
		const key = e.file.toLowerCase();
		if (!buffers.has(key)) {
			const b = fs.readFileSync(path.join(dir, e.file));
			buffers.set(key, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
		}
	}
	const disc = buildDisc(entries, buffers);
	const bios = fs.readFileSync(BIOS_PATH);
	const psx = new PSX();
	psx.insertDisc(disc.buffer, true, disc.tracks);
	psx.loadBios(bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength));
	psx.fastBootDisc();

	// capture one meaty decode command (well into the FMV)
	let captured = null;
	let capturing = false;
	let cmdIndex = 0;
	const origMw = psx.mdec.writeWord.bind(psx.mdec);
	psx.mdec.writeWord = (w) => {
		if (psx.mdec.state === 0 && (w >>> 29) === 1) {
			cmdIndex++;
			capturing = captured === null && cmdIndex >= 40 && (w & 0xffff) > 200;
			if (capturing) captured = {cmd: w >>> 0, words: []};
		} else if (capturing && psx.mdec.state === 1) {
			captured.words.push(w >>> 0);
		}
		origMw(w);
	};

	const far = performance.now() + 1e9;
	for (let f = 0; f < 1200 && (captured === null || psx.mdec.state !== 0); f++) psx.runFrame(far);

	console.log(`decode commands seen: ${cmdIndex}, captured: ${captured !== null}`);
	expect(captured).not.toBe(null);
	// replay through a fresh-configured MDEC clone of the live state
	const codes = [];
	for (const w of captured.words) codes.push(w & 0xffff, (w >>> 16) & 0xffff);

	const m = psx.mdec;

	// run the same codes through our fixed-point MDEC
	m.writeWord(captured.cmd);
	for (const w of captured.words) m.writeWord(w >>> 0);

	// full reference decode: macroblocks of Cr, Cb, Y0..Y3 -> 16x16 RGB
	const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
	const refPixels = [];
	{
		const p2 = {i: 0};
		for (;;) {
			const cr = refBlock(codes, p2, m.qtChroma);
			if (cr === null) break;
			const cb = refBlock(codes, p2, m.qtChroma);
			const ys = [refBlock(codes, p2, m.qtLuma), refBlock(codes, p2, m.qtLuma),
				refBlock(codes, p2, m.qtLuma), refBlock(codes, p2, m.qtLuma)];
			if (ys.some((b) => b === null)) break;
			for (let y = 0; y < 16; y++) {
				for (let x = 0; x < 16; x++) {
					const lum = ys[(y >> 3) * 2 + (x >> 3)][(y & 7) * 8 + (x & 7)];
					const ci = (y >> 1) * 8 + (x >> 1);
					const r = clamp(Math.round(lum + (1435 * cr[ci]) / 1024), -128, 127) + 128;
					const g = clamp(Math.round(lum - (352 * cb[ci] + 731 * cr[ci]) / 1024), -128, 127) + 128;
					const b = clamp(Math.round(lum + (1815 * cb[ci]) / 1024), -128, 127) + 128;
					refPixels.push([(r >> 3) << 3, (g >> 3) << 3, (b >> 3) << 3]);
				}
			}
		}
	}

	// our pixels from the fifo (15bpp)
	const ourPixels = [];
	while (m.outPos < m.outLen) {
		const w = m.readWord() >>> 0;
		for (const px of [w & 0xffff, w >>> 16]) {
			ourPixels.push([(px & 0x1f) << 3, ((px >> 5) & 0x1f) << 3, ((px >> 10) & 0x1f) << 3]);
		}
	}

	const n = Math.min(refPixels.length, ourPixels.length);
	let sumDiff = 0;
	let maxRef = 0;
	let maxOur = 0;
	let big = 0;
	for (let i = 0; i < n; i++) {
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(refPixels[i][c] - ourPixels[i][c]);
			sumDiff += d;
			if (d > 32) big++;
			if (refPixels[i][c] > maxRef) maxRef = refPixels[i][c];
			if (ourPixels[i][c] > maxOur) maxOur = ourPixels[i][c];
		}
	}
	console.log(JSON.stringify({
		cmd: captured.cmd.toString(16),
		scale0: m.scale[0],
		qtLuma0: m.qtLuma[0],
		pixels: n,
		refCount: refPixels.length,
		ourCount: ourPixels.length,
		maxRef,
		maxOur,
		meanAbsDiff: (sumDiff / (n * 3)).toFixed(2),
		bigDiffs: big,
	}));
}, 1800000);
