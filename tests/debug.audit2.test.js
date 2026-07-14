/**
 * Temporary FMV/menu word-stream capture (safe to delete).
 * PSX_AUDIT2=1 npx jest debug.audit2
 */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const CUE = "D:\\PSX\\Need for Speed - Porsche Unleashed (USA)\\Need for Speed - Porsche Unleashed (USA).cue";
const OUT_DIR = process.env.PSX_OUT || ".";

const RUN = process.env.PSX_AUDIT2 === "1";
(RUN ? it : it.skip)("captures gp0 words around the menu desync", () => {
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
	const far = performance.now() + 1e9;

	const gpu = psx.gpu;
	const origGp0 = gpu.gp0.bind(gpu);
	let capture = false;
	/** flat log: state-before, word (state 0/1 only, plus first/last words of image runs) */
	const log = [];
	let imgRun = 0;
	gpu.gp0 = (word) => {
		if (capture) {
			const st = gpu.state;
			if (st === 3) {
				imgRun++;
				if (imgRun <= 2 || gpu.trWordsLeft <= 2) {
					log.push([st, word >>> 0, gpu.trWordsLeft, gpu.trX, gpu.trY, gpu.trW, gpu.trH]);
				}
			} else {
				if (imgRun > 0) {
					log.push(["imgrun", imgRun]);
					imgRun = 0;
				}
				log.push([st, word >>> 0]);
			}
		}
		origGp0(word);
	};
	// also capture GP1 to see display flips interleaved
	const origGp1 = gpu.gp1.bind(gpu);
	gpu.gp1 = (word) => {
		if (capture) log.push(["gp1", word >>> 0]);
		origGp1(word);
	};

	// log DMA ch2 register writes
	const dma = psx.dma;
	const origW32 = dma.write32.bind(dma);
	dma.write32 = (off, v) => {
		if (capture && off >= 0x20 && off < 0x30) {
			log.push(["dma2", off & 0xf, v >>> 0, dma.madr[2] >>> 0, dma.bcr[2] >>> 0]);
		}
		origW32(off, v);
	};

	for (let f = 0; f < 936; f++) {
		capture = f >= 928;
		globalThis.__frame = f;
		psx.runFrame(far);
		psx.joypad.buttons = f < 2000 && (f % 60) < 6 ? (~0x0008 & 0xffff) : 0xffff;
	}
	fs.writeFileSync(path.join(OUT_DIR, "words.json"), JSON.stringify(log));
	console.log("captured", log.length, "entries");
}, 1800000);
