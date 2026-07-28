import {Memory} from "./memory";
import {CPU} from "./cpu/cpu";
import {BlockCache} from "./cpu/compiler";
import {GPU} from "./gpu/gpu";
import {DMA} from "./dma/dma";
import {Timers} from "./timers/timers";
import {CDROM} from "./cdrom/cdrom";
import {Joypad} from "./joypad/joypad";
import {SPU} from "./spu/spu";
import {MDEC} from "./mdec/mdec";

export const CPU_CLOCK = 33868800;
export const FRAMES_PER_SECOND = 60;
export const LINES_PER_FRAME = 263;
export const VBLANK_LINE = 240;
export const CYCLES_PER_LINE = Math.round(CPU_CLOCK / FRAMES_PER_SECOND / LINES_PER_FRAME);
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES_PER_FRAME;
const FRAME_MS = 1000 / FRAMES_PER_SECOND;
const VISIBLE_BUDGET_MS = 12;
const HIDDEN_BUDGET_MS = 400;

export class PSX {
	constructor() {
		this.mem = new Memory();
		this.cpu = new CPU(this.mem);
		this.blocks = new BlockCache(this.cpu, this.mem);
		this.events = [];
		this._eventPool = [];
		this._eventSeq = 0;
		const allocEvent = () => {
			const pool = this._eventPool;
			if (pool.length > 0) {
				const ev = pool.pop(); ev.fn = null; ev.target = null; ev.kind = 0; ev.gen = -1; ev.seq = this._eventSeq++; return ev;
			}
			return {due: 0, fn: null, target: null, kind: 0, gen: -1, seq: this._eventSeq++};
		};
		const schedule = (cycles, fn) => { const ev = allocEvent(); ev.due = this.cpu.cycles + cycles; ev.fn = fn; this.events.push(ev); };
		const scheduleKind = (cycles, target, kind, gen) => { const ev = allocEvent(); ev.due = this.cpu.cycles + cycles; ev.target = target; ev.kind = kind; ev.gen = gen; this.events.push(ev); };
		const raise = (bit) => this.mem.raiseIrq(bit);
		this.mem.onIoPoll = () => this.#pumpEvents();
		this.gpu = new GPU(raise);
		this.timers = new Timers(raise);
		this.cdrom = new CDROM({schedule, scheduleKind}, raise);
		this.joypad = new Joypad(schedule, raise);
		this.spu = new SPU(raise);
		this.cdrom.spu = this.spu;
		this.mdec = new MDEC();
		this.dma = new DMA(this.mem, raise);
		this.dma.schedule = schedule;
		this.dma.now = () => this.cpu.cycles;
		this.dma.gpu = this.gpu;
		this.dma.cdrom = this.cdrom;
		this.dma.spu = this.spu;
		this.dma.mdec = this.mdec;
		this.mem.attach({gpu: this.gpu, dma: this.dma, timers: this.timers, cdrom: this.cdrom, joypad: this.joypad, spu: this.spu, mdec: this.mdec});
		this.running = false;
		this._rafId = 0;
		this._timerId = 0;
		this._lastTick = 0;
		this._acc = 0;
		this.onFrame = null;
		this.stats = {ips: 0, emulationSpeed: 0};
		this._statCycles = 0;
		this._statStamp = 0;
		this.onStats = null;
		this._tick = () => { if (!this.running) return; this._schedule(); this.tick(); };
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", () => { if (!this.running) return; this._cancel(); this._schedule(); });
		}
	}

	loadBios(buffer) { this.mem.loadBios(buffer); this.blocks.invalidateAll(); }
	insertDisc(buffer, isRaw, tracks) { this.cdrom.insert(buffer, isRaw, tracks); }
	sideloadExe(buffer) {
		const bytes = new Uint8Array(buffer);
		if (String.fromCharCode(...bytes.subarray(0, 8)) !== "PS-X EXE") throw new Error("not a PS-X EXE");
		this.cpu.onShell = () => this.#injectExe(bytes);
	}

	fastBootDisc() {
		if (!this.cdrom.hasDisc || this.cdrom.readBootExe() === null) return false;
		let phase = 0;
		this.cpu.onShell = () => {
			if (phase === 0) {
				phase = 1;
				this.cpu.onShell = () => { const exe = this.cdrom.readBootExe(); if (exe !== null) this.#injectExe(exe.data); };
				this.cpu.regs[9] = 0x71;
				this.cpu.regs[31] = 0x80030000 | 0;
				this.cpu.pc = 0xa0;
				this.cpu.nextPc = 0xa4;
			}
		};
		return true;
	}

	#injectExe(bytes) {
		const u32 = (off) => readU32le(bytes, off);
		const pc = u32(0x10); const gp = u32(0x14); const dest = u32(0x18); const size = u32(0x1c);
		const spBase = u32(0x30); const spOff = u32(0x34);
		const text = bytes.subarray(0x800, 0x800 + Math.min(size, bytes.length - 0x800));
		for (let i = 0; i < text.length; i++) this.mem.write8((dest + i) >>> 0, text[i]);
		this.cpu.regs[28] = gp | 0;
		const sp = (spBase + spOff) >>> 0;
		this.cpu.regs[29] = sp !== 0 ? (sp | 0) : (0x801ffff0 | 0);
		this.cpu.regs[30] = this.cpu.regs[29];
		this.cpu.pc = pc >>> 0;
		this.cpu.nextPc = (pc + 4) >>> 0;
	}

	start() {
		if (this.running) return;
		this.running = true;
		this._lastTick = performance.now();
		this._statStamp = this._lastTick;
		this._acc = 0;
		this._schedule();
	}

	stop() { this.running = false; this._cancel(); }

	_schedule() {
		if (typeof document !== "undefined" && document.hidden) {
			this._timerId = setTimeout(this._tick, FRAME_MS);
		} else if (typeof requestAnimationFrame === "function") {
			this._rafId = requestAnimationFrame(this._tick);
		} else {
			this._timerId = setTimeout(this._tick, FRAME_MS);
		}
	}

	_cancel() {
		if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._rafId);
		clearTimeout(this._timerId);
	}

	tick() {
		const now = performance.now();
		let dt = now - this._lastTick;
		this._lastTick = now;
		if (dt > 1000) dt = 1000;
		this._acc += dt;
		const hidden = typeof document !== "undefined" && document.hidden;
		const deadline = now + (hidden ? HIDDEN_BUDGET_MS : VISIBLE_BUDGET_MS);
		let ran = 0;
		while (this._acc >= FRAME_MS) {
			this._acc -= FRAME_MS;
			ran += this.runFrame(deadline);
			if (performance.now() >= deadline) { this._acc = 0; break; }
		}
		if (this.onFrame !== null) this.onFrame();
		this._updateStats(ran, now);
	}

	runFrame(deadline = performance.now() + VISIBLE_BUDGET_MS) {
		let executed = 0;
		this.timers.dotDivider = this.gpu.dotDivider;
		let vblankDone = false;
		this.gpu.onVblankEnd();
		for (let line = 0; line < LINES_PER_FRAME; line++) {
			this.gpu.line = line;
			this.gpu.inVblank = line >= VBLANK_LINE;
			executed += this.blocks.run(CYCLES_PER_LINE);
			this.#pumpEvents();
			this.timers.advance(CYCLES_PER_LINE, 1, line >= VBLANK_LINE);
			if (line === VBLANK_LINE) { this.#vblank(); vblankDone = true; }
			if ((line & 31) === 31 && performance.now() >= deadline) break;
		}
		if (!vblankDone) this.#vblank();
		const buffered = this.spu.bufLen >> 1;
		let want = 735 + ((4096 - buffered) >> 5);
		if (want < 700) want = 700;
		else if (want > 770) want = 770;
		this.spu.generate(want);
		return executed;
	}

	#vblank() { this.timers.onVblank(); this.gpu.inVblank = true; this.mem.raiseIrq(0); }

	#pumpEvents() {
		const events = this.events;
		if (events.length === 0) return;
		const now = this.cpu.cycles;
		const pool = this._eventPool;
		let due = null;
		for (let i = 0; i < events.length; i++) { if (events[i].due <= now) { if (due === null) due = []; due.push(events[i]); } }
		if (due === null) return;
		due.sort((a, b) => (a.due - b.due) || (a.seq - b.seq));
		let write = 0;
		for (let i = 0; i < events.length; i++) { if (events[i].due > now) events[write++] = events[i]; }
		events.length = write;
		for (const ev of due) {
			if (ev.target !== null) { if (ev.gen < 0 || ev.gen === ev.target.gen) ev.target._onEvent(ev.kind); }
			else ev.fn();
			pool.push(ev);
		}
	}

	_updateStats(cycles, now) {
		this._statCycles += cycles;
		const elapsed = now - this._statStamp;
		if (elapsed < 1000) return;
		this.stats.ips = Math.round(this._statCycles * 1000 / elapsed);
		this.stats.emulationSpeed = this.stats.ips / CPU_CLOCK;
		this._statCycles = 0;
		this._statStamp = now;
		if (this.onStats !== null) this.onStats(this.stats);
	}
}

function readU32le(b, off) { return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0; }
