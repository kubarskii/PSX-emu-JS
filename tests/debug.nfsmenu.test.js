/**
 * Diagnostic: NFS Porsche main-menu stripe corruption — dump VRAM + GPU state.
 * Opt-in: PSX_REPRO=1 npx jest debug.nfsmenu
 */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const CUE = "D:\\PSX\\Need for Speed - Porsche Unleashed (USA)\\Need for Speed - Porsche Unleashed (USA).cue";
const OUT_DIR = process.env.PSX_OUT || ".";

function saveBmp(p, rgba, w, h) {
	const rowSize = w * 3 + ((4 - (w * 3) % 4) % 4);
	const buf = Buffer.alloc(54 + rowSize * h);
	buf.write("BM", 0);
	buf.writeUInt32LE(54 + rowSize * h, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18);
	buf.writeInt32LE(-h, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(rowSize * h, 34);
	for (let y = 0; y < h; y++) {
		let o = 54 + y * rowSize;
		for (let x = 0; x < w; x++) {
			const px = rgba[y * w + x];
			buf[o++] = (px >> 16) & 0xff;
			buf[o++] = (px >> 8) & 0xff;
			buf[o++] = px & 0xff;
		}
	}
	fs.writeFileSync(p, buf);
}

const RUN = process.env.PSX_REPRO === "1";
(RUN ? it : it.skip)("dumps NFS menu VRAM and GPU state", () => {
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
	if (process.env.PSX_NOJIT === "1") psx.blocks.compile = () => null; // pure interpreter
	const far = performance.now() + 1e9;
	globalThis.__GPU_TRACE = [];
	globalThis.__PSX = psx;
	if (process.env.PSX_MEMWATCH) {
		const wAddr = parseInt(process.env.PSX_MEMWATCH, 16) & 0x1fffff;
		const orig32 = psx.mem.write32.bind(psx.mem);
		psx.mem.write32 = (a, v) => {
			if ((a & 0x1fffff) === wAddr && (a >>> 0) < 0xc0000000) {
				globalThis.__GPU_TRACE.push(["MEMW", globalThis.__frame, psx.cpu.currentPc >>> 0, v >>> 0]);
			}
			orig32(a, v);
		};
	}
	const totalFrames = parseInt(process.env.PSX_FRAMES || "3000", 10);
	const pcs = [];
	for (let f = 0; f < totalFrames; f++) {
		globalThis.__frame = f;
		psx.runFrame(far);
		pcs.push(psx.cpu.pc >>> 0);
		if (process.env.PSX_NOPRESS === "1") continue;
		psx.joypad.buttons = f < 2000 && (f % 60) < 6 ? (~0x0008 & 0xffff) : 0xffff;
	}
	fs.writeFileSync(path.join(OUT_DIR, "nfsmenu-pcs.json"), JSON.stringify(pcs));
	fs.writeFileSync(path.join(OUT_DIR, "nfsmenu-trace.json"),
		JSON.stringify(globalThis.__GPU_TRACE));
	globalThis.__GPU_TRACE = null;
	const ram = psx.mem.ram32 || psx.mem.ram;
	if (ram) {
		fs.writeFileSync(path.join(OUT_DIR, "nfsmenu-ram.bin"),
			Buffer.from(ram.buffer, ram.byteOffset, Math.min(ram.byteLength, 2 * 1024 * 1024)));
	}
	const gpu = psx.gpu;
	// full VRAM as 1024x512 image (15bpp -> 24bpp)
	const vramImg = new Uint32Array(1024 * 512);
	for (let i = 0; i < vramImg.length; i++) {
		const p = gpu.vram[i];
		const r = (p & 0x1f) << 3, g = ((p >> 5) & 0x1f) << 3, b = ((p >> 10) & 0x1f) << 3;
		vramImg[i] = (r << 16) | (g << 8) | b;
	}
	saveBmp(path.join(OUT_DIR, "nfsmenu-vram.bmp"), vramImg, 1024, 512);
	const w = gpu.hres || 320, h = gpu.vres || 240;
	const out = new Uint32Array(w * h);
	gpu.renderDisplay(out, w, h);
	saveBmp(path.join(OUT_DIR, "nfsmenu-display.bmp"), out, w, h);
	const state = {};
	for (const k of Object.keys(gpu)) {
		const v = gpu[k];
		if (typeof v === "number" || typeof v === "boolean") state[k] = v;
	}
	state.status = gpu.readStatus ? (gpu.readStatus() >>> 0).toString(16) : "n/a";
	state.dicr = (psx.dma.dicr >>> 0).toString(16);
	state.dpcr = (psx.dma.dpcr >>> 0).toString(16);
	state.chcr = Array.from(psx.dma.chcr, (v) => (v >>> 0).toString(16));
	state.iStat = (psx.mem.iStat >>> 0).toString(16);
	state.iMask = (psx.mem.iMask >>> 0).toString(16);
	state.cdBusy = psx.cdrom.busy;
	state.cdReading = psx.cdrom.reading;
	state.cdPendingIrq = psx.cdrom.pendingIrq.length;
	state.cdIntFlag = psx.cdrom.intFlag;
	state.events = psx.events.length;
	fs.writeFileSync(path.join(OUT_DIR, "nfsmenu-gpu.json"), JSON.stringify(state, null, 1));
	console.log("dumped", w + "x" + h);
}, 1800000);
