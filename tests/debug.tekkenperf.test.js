/** Diagnostic: in-fight frame time for Tekken 3 (headless A/B benchmark). */
/* eslint-env node */
import * as fs from "fs";
import * as path from "path";
import {PSX} from "../src/psx";
import {parseCue, buildDisc} from "../src/loader/cue";

const BIOS_PATH = "C:\\Users\\Aleksandr\\Downloads\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101] (1)\\Sony PSone BIOS (U)(v4.5)(2000-05-25)[SCPH-101].bin";
const CUE = "D:\\PSX\\Tekken 3 (USA)\\Tekken 3 (USA).cue";

const RUN = process.env.PSX_GAMES === "1";
(RUN ? it : it.skip)("measures tekken frame time", () => {
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
	for (let f = 0; f < 2700; f++) {
		psx.runFrame(far);
		psx.joypad.buttons = (f % 150) < 8 ? ((f % 300) < 150 ? ~0x0040 : ~0x0008) & 0xffff : 0xffff;
	}
	// in fight now: time 600 frames, collect percentiles
	const times = [];
	for (let f = 0; f < 600; f++) {
		const t0 = performance.now();
		psx.runFrame(far);
		times.push(performance.now() - t0);
		psx.joypad.buttons = (f % 30) < 4 ? ~0x0040 & 0xffff : 0xffff;
	}
	times.sort((a, b) => a - b);
	const pick = (q) => times[Math.min(times.length - 1, (times.length * q) | 0)].toFixed(2);
	const avg = (times.reduce((s, t) => s + t, 0) / times.length).toFixed(2);
	let sum = 0;
	for (let i = 0; i < psx.gpu.vram.length; i += 1031) sum = (sum + psx.gpu.vram[i]) | 0;
	console.log(`tekken frame ms: avg=${avg} p50=${pick(0.5)} p90=${pick(0.9)} p99=${pick(0.99)} max=${pick(1)} vram=${(sum >>> 0).toString(16)}`);
}, 1800000);
