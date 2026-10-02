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

/** R3000A clock: 33.8688 MHz */
export const CPU_CLOCK = 33868800;
export const FRAMES_PER_SECOND = 60;
/** NTSC scanlines per frame; vblank starts after the visible area */
export const LINES_PER_FRAME = 263;
export const VBLANK_LINE = 240;
export const CYCLES_PER_LINE = Math.round(CPU_CLOCK / FRAMES_PER_SECOND / LINES_PER_FRAME);
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES_PER_FRAME;

const FRAME_MS = 1000 / FRAMES_PER_SECOND;

/**
 * Wall-clock budget per tick while the tab is visible: whatever is not
 * emulated in this window is dropped instead of freezing the page.
 * Hidden tabs get ticks as rarely as once a second (browser throttling),
 * so they may use a much larger window to catch up.
 */
const VISIBLE_BUDGET_MS = 12;
const HIDDEN_BUDGET_MS = 400;

/**
 * A single frame is only ever cut short past this wall-clock time (an
 * extremely slow device on the main thread). Cutting a frame delivers
 * its VBlank early, so the guest gets a fraction of the CPU time it
 * expects between two VBlanks: per-frame work (texture streaming and
 * decoding, game logic) is left half done - visible garbage in games.
 * Frames that are merely slower than real time run to completion; the
 * loop drops whole frames instead (slow motion, never corruption).
 */
const MAX_FRAME_MS = 250;

/** a frame slower than this is reported as a hitch (onHitch) */
const HITCH_MS = 40;

export class PSX {

	constructor() {
		this.mem = new Memory();
		this.cpu = new CPU(this.mem);
		this.blocks = new BlockCache(this.cpu, this.mem);

		/**
		 * Delayed device events keyed by absolute CPU cycle. Pumped once
		 * per scanline and lazily on I/O status reads, so a kernel busy-
		 * polling I_STAT with a short timeout (pad /ACK) still sees the
		 * interrupt arrive on time.
		 */
		this.events = [];
		this._eventPool = [];
		this._eventSeq = 0;
		this._dueScratch = [];
		const allocEvent = () => {
			const pool = this._eventPool;
			if (pool.length > 0) {
				const ev = pool.pop();
				ev.fn = null;
				ev.target = null;
				ev.kind = 0;
				ev.gen = -1;
				ev.seq = this._eventSeq++;
				return ev;
			}
			return {due: 0, fn: null, target: null, kind: 0, gen: -1, seq: this._eventSeq++};
		};
		const schedule = (cycles, fn) => {
			const ev = allocEvent();
			ev.due = this.cpu.cycles + cycles;
			ev.fn = fn;
			this.events.push(ev);
		};
		const scheduleKind = (cycles, target, kind, gen) => {
			const ev = allocEvent();
			ev.due = this.cpu.cycles + cycles;
			ev.target = target;
			ev.kind = kind;
			ev.gen = gen;
			this.events.push(ev);
		};
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
		this.mem.attach({
			gpu: this.gpu,
			dma: this.dma,
			timers: this.timers,
			cdrom: this.cdrom,
			joypad: this.joypad,
			spu: this.spu,
			mdec: this.mdec,
		});

		this.running = false;
		/**
		 * page/tab hidden: rAF stops firing, so the loop moves to timers
		 * and may catch up in larger slices. Set through setHidden() by
		 * the frontend (this class also runs inside a Web Worker, which
		 * has no document to watch).
		 */
		this.hidden = false;
		/**
		 * audio already queued downstream of the SPU pull buffer (stereo
		 * pairs), reported by the frontend's audio sink: the per-frame
		 * sample-count steering aims at the total
		 */
		this.audioQueued = 0;
		/**
		 * wall-clock budget for catching up within one visible tick; whole
		 * frames only (see MAX_FRAME_MS). The page sets a larger one when
		 * the machine runs in a worker, where long ticks block nothing.
		 */
		this.tickBudgetMs = VISIBLE_BUDGET_MS;
		/**
		 * Let the loop leave requestAnimationFrame when frames get slow
		 * (worker hosts set this; on the main thread rAF must stay).
		 *
		 * A rAF tick that emulates a frame taking longer than the refresh
		 * interval misses the next vsync, so the following tick runs two
		 * frames back to back and only the last one is ever shown: a
		 * device managing ~55 emulated fps displays 30. Slow devices are
		 * instead paced by a timer, one frame per task, and each frame is
		 * committed to the (Offscreen)canvas as soon as it is done.
		 */
		this.adaptivePacing = false;
		/** moving average of a frame's wall-clock cost (ms) */
		this.frameMs = 0;
		this._slowPacing = false;
		this._yieldToken = 0;
		this._yieldPort = null;
		this._rafId = 0;
		this._timerId = 0;
		this._lastTick = 0;
		this._acc = 0;

		/**
		 * called once per tick (render/input hook) with the number of
		 * frames emulated in it: 0 when the display refreshes faster
		 * than 60Hz and no new frame is due yet
		 * @type {((frames: number) => void) | null}
		 */
		this.onFrame = null;

		/** perf stats, refreshed roughly once a second */
		this.stats = {ips: 0, emulationSpeed: 0, maxFrameMs: 0};
		this._statCycles = 0;
		this._statStamp = 0;
		this.onStats = null;
		/**
		 * called for a frame that took longer than HITCH_MS of wall-clock
		 * time, with what that time went into
		 * @type {((info: {ms: number, compileMs: number, readbacks: number, readbackMs: number}) => void) | null}
		 */
		this.onHitch = null;
		this._maxFrameMs = 0;

		this._tick = () => {
			if (!this.running) return;
			if (this.#useRaf()) {
				this._schedule();
				this.tick();
			} else {
				this.tick();
				if (this.running) this._schedule();
			}
		};
	}

	/**
	 * A pending rAF freezes while the page is hidden: the loop moves over
	 * to a timer (and back) on visibility changes.
	 * @param {boolean} hidden
	 */
	setHidden(hidden) {
		if (this.hidden === hidden) return;
		this.hidden = hidden;
		if (!this.running) return;
		this._cancel();
		this._schedule();
	}

	/** @return {boolean} - drive the loop from requestAnimationFrame */
	#useRaf() {
		return !this.hidden && !this._slowPacing && typeof requestAnimationFrame === "function";
	}

	/**
	 * Runs the next tick as soon as possible: a nested setTimeout(0) is
	 * clamped to 4ms, which a frame-paced loop would pay every frame.
	 */
	#yieldTick() {
		if (typeof MessageChannel !== "function") {
			this._timerId = setTimeout(this._tick, 0);
			return;
		}
		if (this._yieldPort === null) {
			const ch = new MessageChannel();
			ch.port1.onmessage = (e) => {
				// a cancel/reschedule since posting makes this one stale
				if (e.data === this._yieldToken) this._tick();
			};
			this._yieldPort = ch.port2;
		}
		this._yieldPort.postMessage(++this._yieldToken);
	}

	/**
	 * @param {ArrayBuffer} buffer - 512K BIOS image
	 */
	loadBios(buffer) {
		this.mem.loadBios(buffer);
		this.blocks.invalidateAll();
	}

	/**
	 * @param {ArrayBuffer} buffer - disc image
	 * @param {boolean} isRaw - 2352-byte sectors (BIN) vs 2048 (ISO)
	 */
	insertDisc(buffer, isRaw, tracks) {
		this.cdrom.insert(buffer, isRaw, tracks);
	}

	/**
	 * Sideloads a PS-X EXE: waits for the kernel to finish booting (the
	 * shell entry point), then injects the executable instead of the shell.
	 * @param {ArrayBuffer} buffer
	 */
	sideloadExe(buffer) {
		const bytes = new Uint8Array(buffer);
		if (String.fromCharCode(...bytes.subarray(0, 8)) !== "PS-X EXE") {
			throw new Error("not a PS-X EXE");
		}
		this.cpu.onShell = () => this.#injectExe(bytes);
	}

	/**
	 * Fast boot: instead of letting the shell run its license check (which
	 * region-locks discs, e.g. a Japanese disc on an American BIOS), load
	 * the boot executable straight off the mounted disc image once the
	 * kernel is up.
	 * @return {boolean} - false when no bootable EXE was found
	 */
	fastBootDisc() {
		if (!this.cdrom.hasDisc || this.cdrom.readBootExe() === null) return false;
		// a real shell boot runs _96_init() before starting the game,
		// arming the kernel's CDROM event/FS machinery; games that use the
		// kernel CD services without their own CdInit (Tenchu's movie
		// player, chain-loaders calling the kernel FS) hang without it.
		// Phase 0 calls A0(0x71) with ra pointing back at the shell entry,
		// so the hook fires once more and phase 1 injects the EXE.
		let phase = 0;
		this.cpu.onShell = () => {
			if (phase === 0) {
				phase = 1;
				this.cpu.onShell = () => {
					const exe = this.cdrom.readBootExe();
					if (exe !== null) this.#injectExe(exe.data);
				};
				this.cpu.regs[9] = 0x71;             // t1: kernel function
				this.cpu.regs[31] = 0x80030000 | 0;  // return to this hook
				this.cpu.pc = 0xa0;
				this.cpu.nextPc = 0xa4;
			}
		};
		return true;
	}

	/**
	 * @param {Uint8Array} bytes - PS-X EXE image
	 */
	#injectExe(bytes) {
		const u32 = (off) => readU32le(bytes, off);
		const pc = u32(0x10);
		const gp = u32(0x14);
		const dest = u32(0x18);
		const size = u32(0x1c);
		const spBase = u32(0x30);
		const spOff = u32(0x34);
		const text = bytes.subarray(0x800, 0x800 + Math.min(size, bytes.length - 0x800));
		for (let i = 0; i < text.length; i++) {
			this.mem.write8((dest + i) >>> 0, text[i]);
		}
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

	stop() {
		this.running = false;
		this._cancel();
	}

	_schedule() {
		if (this.#useRaf()) {
			this._rafId = requestAnimationFrame(this._tick);
			return;
		}
		// timer pacing (hidden pages, workers without rAF): sleep until
		// the next frame is due instead of a fixed period, so frames
		// don't bunch up in pairs when the timer fires late
		let delay = FRAME_MS;
		if (!this.hidden) {
			const elapsed = performance.now() - this._lastTick;
			delay = FRAME_MS - this._acc - elapsed;
			if (delay < 1) {
				this.#yieldTick();
				return;
			}
		}
		this._timerId = setTimeout(this._tick, delay);
	}

	_cancel() {
		if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._rafId);
		clearTimeout(this._timerId);
		this._yieldToken++;
	}

	/**
	 * Emulates as many frames as wall-clock time has passed since the last
	 * tick (rAF at any refresh rate, throttled timers in hidden tabs), up
	 * to the wall-clock budget.
	 */
	tick() {
		const now = performance.now();
		let dt = now - this._lastTick;
		this._lastTick = now;
		if (dt > 1000) dt = 1000; // long pause: don't spiral trying to catch up
		this._acc += dt;

		const deadline = now + (this.hidden ? HIDDEN_BUDGET_MS : this.tickBudgetMs);
		// frame pacing: one frame per task, each one gets presented
		const paced = this._slowPacing && !this.hidden;
		let ran = 0;
		let frames = 0;
		while (this._acc >= FRAME_MS) {
			this._acc -= FRAME_MS;
			const t0 = performance.now();
			const c0 = this.blocks.compileMs, r0 = this.gpu.readbacks, rm0 = this.gpu.readbackMs;
			ran += this.runFrame(t0 + MAX_FRAME_MS);
			frames++;
			const t1 = performance.now();
			const ms = t1 - t0;
			if (ms > this._maxFrameMs) this._maxFrameMs = ms;
			if (ms > HITCH_MS && this.onHitch !== null) {
				this.onHitch({
					ms,
					compileMs: this.blocks.compileMs - c0,
					readbacks: this.gpu.readbacks - r0,
					readbackMs: this.gpu.readbackMs - rm0,
				});
			}
			this.frameMs += (t1 - t0 - this.frameMs) * 0.1;
			if (paced) {
				// behind real time: run back to back, but never build up a
				// backlog to burst through later
				if (this._acc > 2 * FRAME_MS) this._acc = FRAME_MS;
				break;
			}
			if (t1 >= deadline) {
				this._acc = 0; // too slow: drop the backlog
				break;
			}
		}
		if (this.adaptivePacing) {
			// hysteresis: leave rAF once frames eat most of a refresh
			// interval, come back when there is clear headroom again
			if (!this._slowPacing && this.frameMs > 13) this._slowPacing = true;
			else if (this._slowPacing && this.frameMs < 9) this._slowPacing = false;
		}
		if (this.onFrame !== null) this.onFrame(frames);
		this._updateStats(ran, now);
	}

	/**
	 * Executes one video frame scanline by scanline: CPU, device events
	 * and timers advance together, VBlank fires after the visible area.
	 * @param {number} [deadline] - performance.now() timestamp past which
	 *   the frame is cut short (emergency brake, see MAX_FRAME_MS)
	 * @return {number} - cycles executed
	 */
	runFrame(deadline = performance.now() + MAX_FRAME_MS) {
		let executed = 0;
		this.timers.dotDivider = this.gpu.dotDivider;
		let vblankDone = false;
		// the displayed-field flag flips when the new field starts being
		// scanned out (vblank end), NOT together with the vblank IRQ: the
		// shell waits for the flip and then for the NEXT vblank interrupt,
		// which only fits its timeout window with this ordering
		this.gpu.onVblankEnd();
		for (let line = 0; line < LINES_PER_FRAME; line++) {
			this.gpu.line = line;
			this.gpu.inVblank = line >= VBLANK_LINE;
			executed += this.blocks.run(CYCLES_PER_LINE);
			this.#pumpEvents();
			this.timers.advance(CYCLES_PER_LINE, 1, line >= VBLANK_LINE);
			if (line === VBLANK_LINE) {
				this.#vblank();
				vblankDone = true;
			}
			if ((line & 31) === 31 && performance.now() >= deadline) break;
		}
		// a frame cut short by the deadline must still deliver its VBlank,
		// otherwise the kernel's VSync events time out under load
		if (!vblankDone) this.#vblank();
		// steer the pull buffer toward ~4096 buffered pairs: the wall
		// clock, the audio clock and dropped frames all drift the fill
		// level, and a small per-frame sample-count correction absorbs
		// that (same 44.1kHz stream, so no pitch change) instead of
		// letting it click on underrun or drop on overflow
		const buffered = (this.spu.bufLen >> 1) + this.audioQueued;
		let want = 735 + ((4096 - buffered) >> 5);
		if (want < 700) want = 700;
		else if (want > 770) want = 770;
		this.spu.generate(want);
		return executed;
	}

	#vblank() {
		this.timers.onVblank();
		this.gpu.inVblank = true;
		this.mem.raiseIrq(0);
	}

	/** fires every event whose due cycle has passed, in due order */
	#pumpEvents() {
		const events = this.events;
		if (events.length === 0) return;
		const now = this.cpu.cycles;
		const pool = this._eventPool;
		let any = false;
		for (let i = 0; i < events.length; i++) {
			if (events[i].due <= now) {
				any = true;
				break;
			}
		}
		if (!any) return;
		// a handler may pump again (I/O status read) or schedule more
		// events: take the due list out of the shared scratch first
		let due = this._dueScratch;
		if (due === null) due = []; // nested pump: scratch is in use
		this._dueScratch = null;
		let write = 0;
		for (let i = 0; i < events.length; i++) {
			const ev = events[i];
			if (ev.due <= now) due.push(ev);
			else events[write++] = ev;
		}
		events.length = write;
		// devices react in the order their events were due; ties keep
		// scheduling order (seq) so chained DMA completions stay FIFO
		if (due.length > 1) due.sort(byDueThenSeq);
		for (let i = 0; i < due.length; i++) {
			const ev = due[i];
			if (ev.target !== null) {
				if (ev.gen < 0 || ev.gen === ev.target.gen) ev.target._onEvent(ev.kind);
			} else {
				ev.fn();
			}
			pool.push(ev);
		}
		due.length = 0;
		this._dueScratch = due;
	}

	/**
	 * @param {number} cycles - executed this tick
	 * @param {number} now
	 */
	_updateStats(cycles, now) {
		this._statCycles += cycles;
		const elapsed = now - this._statStamp;
		if (elapsed < 1000) return;
		this.stats.ips = Math.round(this._statCycles * 1000 / elapsed);
		this.stats.emulationSpeed = this.stats.ips / CPU_CLOCK;
		this.stats.maxFrameMs = this._maxFrameMs;
		this._maxFrameMs = 0;
		this._statCycles = 0;
		this._statStamp = now;
		if (this.onStats !== null) this.onStats(this.stats);
	}
}

/** event order: due cycle, then scheduling order */
function byDueThenSeq(a, b) {
	return (a.due - b.due) || (a.seq - b.seq);
}

/**
 * @param {Uint8Array} b
 * @param {number} off
 * @return {number} - little-endian u32
 */
function readU32le(b, off) {
	return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
