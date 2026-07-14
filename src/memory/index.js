/**
 * PSX memory bus.
 *
 * Owns RAM/BIOS/scratchpad backing stores with pre-created typed-array
 * views (no allocation on the hot path) and routes I/O accesses to the
 * attached devices. Devices are optional: unattached regions fall back to
 * store-backed registers, which keeps unit tests self-contained.
 *
 * Memory map: https://psx-spx.consoledev.net/memorymap/
 */

export const RAM_SIZE = 2 * 1024 * 1024;
export const BIOS_SIZE = 512 * 1024;
export const BIOS_BASE = 0x1fc00000;
export const SCRATCH_BASE = 0x1f800000;
export const SCRATCH_SIZE = 1024;
export const IO_BASE = 0x1f801000;
export const IO_SIZE = 16 * 1024; // I/O ports (8K) + Expansion 2 (8K)

/**
 * Page granularity used to invalidate compiled code blocks when RAM
 * is written to (self-modifying code / executable loading).
 */
export const PAGE_SHIFT = 10; // 1KB: small enough that game data writes rarely share a page with code (each false share recompiles every block on the page)
export const RAM_PAGES = RAM_SIZE >>> PAGE_SHIFT;

/**
 * Region mask table, indexed by the 3 top bits of the address.
 * Turns KUSEG/KSEG0/KSEG1 mirrors into physical addresses.
 */
const REGION_MASK = new Uint32Array([
	0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, // KUSEG
	0x7fffffff,                                     // KSEG0
	0x1fffffff,                                     // KSEG1
	0xffffffff, 0xffffffff,                         // KSEG2
]);

/** I/O register offsets relative to IO_BASE */
const IRQ_STAT = 0x70;
const IRQ_MASK = 0x74;

/** fallback GPUSTAT with "ready" bits when no GPU is attached */
const GPUSTAT_READY = 0x1c000000;

export class Memory {

	constructor() {
		this.ram = new ArrayBuffer(RAM_SIZE);
		this.ram8 = new Uint8Array(this.ram);
		this.ram16 = new Uint16Array(this.ram);
		this.ram32 = new Uint32Array(this.ram);

		this.bios = new ArrayBuffer(BIOS_SIZE);
		this.bios8 = new Uint8Array(this.bios);
		this.bios16 = new Uint16Array(this.bios);
		this.bios32 = new Uint32Array(this.bios);

		this.scratch = new ArrayBuffer(SCRATCH_SIZE);
		this.scratch8 = new Uint8Array(this.scratch);
		this.scratch16 = new Uint16Array(this.scratch);
		this.scratch32 = new Uint32Array(this.scratch);

		this.io = new ArrayBuffer(IO_SIZE);
		this.io8 = new Uint8Array(this.io);
		this.io16 = new Uint16Array(this.io);
		this.io32 = new Uint32Array(this.io);

		this.cacheControl = 0;

		/** Interrupt controller state */
		this.iStat = 0;
		this.iMask = 0;
		/** True when (iStat & iMask) != 0, kept in sync on every change */
		this.irqLine = false;

		/** attached devices (all optional) */
		this.gpu = null;
		this.dma = null;
		this.timers = null;
		this.cdrom = null;
		this.joypad = null;
		this.spu = null;
		this.mdec = null;

		/**
		 * Pages of RAM that contain compiled code blocks. A write into
		 * such a page triggers onCodeWrite so the block cache can
		 * invalidate itself.
		 * @type {(page: number) => void | null}
		 */
		this.codePages = new Uint8Array(RAM_PAGES);
		this.onCodeWrite = null;

		/**
		 * Called before status-register reads (I_STAT, pad, CDROM) so the
		 * machine can deliver due device events to a busy-polling CPU.
		 * @type {(() => void) | null}
		 */
		this.onIoPoll = null;
	}

	/**
	 * @param {{gpu?: object, dma?: object, timers?: object, cdrom?: object,
	 *          joypad?: object, spu?: object}} devices
	 */
	attach(devices) {
		if (devices.gpu) this.gpu = devices.gpu;
		if (devices.dma) this.dma = devices.dma;
		if (devices.timers) this.timers = devices.timers;
		if (devices.cdrom) this.cdrom = devices.cdrom;
		if (devices.joypad) this.joypad = devices.joypad;
		if (devices.spu) this.spu = devices.spu;
		if (devices.mdec) this.mdec = devices.mdec;
	}

	/**
	 * @param {ArrayBuffer} buffer - raw 512K BIOS image
	 */
	loadBios(buffer) {
		this.bios8.set(new Uint8Array(buffer, 0, BIOS_SIZE));
	}

	/**
	 * Translates a CPU address to a physical one (strips segment bits).
	 * @param {number} addr
	 * @return {number}
	 */
	static toPhysical(addr) {
		return (addr & REGION_MASK[addr >>> 29]) >>> 0;
	}

	#updateIrqLine() {
		this.irqLine = (this.iStat & this.iMask & 0x7ff) !== 0;
	}

	/**
	 * Raises a hardware interrupt (sets a bit in I_STAT).
	 * 0 VBlank, 1 GPU, 2 CDROM, 3 DMA, 4-6 timers, 7 controller.
	 * @param {number} bit
	 */
	raiseIrq(bit) {
		this.iStat |= (1 << bit);
		this.#updateIrqLine();
	}

	/**
	 * @param {number} addr - virtual address, must be 4-byte aligned
	 * @return {number} - signed 32bit value
	 */
	read32(addr) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) return this.ram32[(p & 0x1fffff) >>> 2] | 0;
		if (p >= BIOS_BASE && p < BIOS_BASE + BIOS_SIZE) return this.bios32[(p - BIOS_BASE) >>> 2] | 0;
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) return this.#ioRead(p - IO_BASE, 4) | 0;
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) return this.scratch32[(p - SCRATCH_BASE) >>> 2] | 0;
		if (p >= 0x1f000000 && p < 0x1f800000) return -1; // Expansion 1: no device
		if (p === 0xfffe0130) return this.cacheControl | 0;
		return 0;
	}

	/**
	 * @param {number} addr
	 * @return {number} - unsigned 16bit value
	 */
	read16(addr) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) return this.ram16[(p & 0x1fffff) >>> 1];
		if (p >= BIOS_BASE && p < BIOS_BASE + BIOS_SIZE) return this.bios16[(p - BIOS_BASE) >>> 1];
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) return this.#ioRead(p - IO_BASE, 2) & 0xffff;
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) return this.scratch16[(p - SCRATCH_BASE) >>> 1];
		if (p >= 0x1f000000 && p < 0x1f800000) return 0xffff;
		return 0;
	}

	/**
	 * @param {number} addr
	 * @return {number} - unsigned 8bit value
	 */
	read8(addr) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) return this.ram8[p & 0x1fffff];
		if (p >= BIOS_BASE && p < BIOS_BASE + BIOS_SIZE) return this.bios8[p - BIOS_BASE];
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) return this.#ioRead(p - IO_BASE, 1) & 0xff;
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) return this.scratch8[p - SCRATCH_BASE];
		if (p >= 0x1f000000 && p < 0x1f800000) return 0xff;
		return 0;
	}

	/**
	 * @param {number} addr - virtual address, must be 4-byte aligned
	 * @param {number} value
	 */
	write32(addr, value) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) {
			const off = p & 0x1fffff;
			if (this.codePages[off >>> PAGE_SHIFT] !== 0 && this.onCodeWrite !== null &&
				this.ram32[off >>> 2] !== (value >>> 0)) {
				// rewriting identical bytes (engines re-copy live overlays
				// every frame) must not flush compiled blocks
				this.onCodeWrite(off >>> PAGE_SHIFT);
			}
			this.ram32[off >>> 2] = value;
			return;
		}
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) {
			this.#ioWrite(p - IO_BASE, value >>> 0, 4);
			return;
		}
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) {
			this.scratch32[(p - SCRATCH_BASE) >>> 2] = value;
			return;
		}
		if (p === 0xfffe0130) {
			this.cacheControl = value >>> 0;
			return;
		}
		// BIOS ROM / expansion regions: writes are silently ignored
	}

	/**
	 * @param {number} addr
	 * @param {number} value
	 */
	write16(addr, value) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) {
			const off = p & 0x1fffff;
			if (this.codePages[off >>> PAGE_SHIFT] !== 0 && this.onCodeWrite !== null &&
				this.ram16[off >>> 1] !== (value & 0xffff)) {
				this.onCodeWrite(off >>> PAGE_SHIFT);
			}
			this.ram16[off >>> 1] = value;
			return;
		}
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) {
			this.#ioWrite(p - IO_BASE, value & 0xffff, 2);
			return;
		}
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) {
			this.scratch16[(p - SCRATCH_BASE) >>> 1] = value;
		}
	}

	/**
	 * @param {number} addr
	 * @param {number} value
	 */
	write8(addr, value) {
		const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
		if (p < 0x00800000) {
			const off = p & 0x1fffff;
			if (this.codePages[off >>> PAGE_SHIFT] !== 0 && this.onCodeWrite !== null &&
				this.ram8[off] !== (value & 0xff)) {
				this.onCodeWrite(off >>> PAGE_SHIFT);
			}
			this.ram8[off] = value;
			return;
		}
		if (p >= IO_BASE && p < IO_BASE + IO_SIZE) {
			this.#ioWrite(p - IO_BASE, value & 0xff, 1);
			return;
		}
		if (p >= SCRATCH_BASE && p < SCRATCH_BASE + SCRATCH_SIZE) {
			this.scratch8[p - SCRATCH_BASE] = value;
		}
	}

	/**
	 * I/O read dispatched to the owning device.
	 * @param {number} off - offset from IO_BASE
	 * @param {number} size - 1/2/4
	 * @return {number}
	 */
	#ioRead(off, size) {
		if (this.onIoPoll !== null &&
			(off === IRQ_STAT || (off >= 0x40 && off < 0x60) || (off >= 0x800 && off < 0x804))) {
			this.onIoPoll();
		}
		if (off === IRQ_STAT) return this.iStat;
		if (off === IRQ_MASK) return this.iMask;

		if (off >= 0x40 && off < 0x60 && this.joypad !== null) {
			return this.joypad.read(off - 0x40, size);
		}
		if (off >= 0x80 && off < 0x100 && this.dma !== null) {
			const rel = off - 0x80;
			if (size === 4) return this.dma.read32(rel);
			const w = this.dma.read32(rel & ~3) >>> 0;
			return (w >>> ((rel & 3) * 8)) & (size === 2 ? 0xffff : 0xff);
		}
		if (off >= 0x100 && off < 0x130 && this.timers !== null) {
			return this.timers.read(off - 0x100);
		}
		if (off >= 0x800 && off < 0x804 && this.cdrom !== null) {
			if (size === 1) return this.cdrom.read8(off - 0x800);
			if (size === 2) return this.cdrom.read8(off - 0x800) | (this.cdrom.read8(off - 0x800) << 8);
			return this.cdrom.readDataWord();
		}
		if (off === 0x810 || off === 0x814) {
			if (this.gpu !== null) {
				return off === 0x810 ? this.gpu.readData() : this.gpu.readStatus();
			}
			return off === 0x814 ? GPUSTAT_READY : 0;
		}
		if ((off === 0x820 || off === 0x824) && this.mdec !== null) {
			return off === 0x820 ? this.mdec.readWord() : this.mdec.readStatus();
		}
		if (off >= 0xc00 && off < 0x1000 && this.spu !== null) {
			const lo = this.spu.read16(off - 0xc00);
			if (size !== 4) return lo;
			return lo | (this.spu.read16(off - 0xc00 + 2) << 16);
		}

		// fallback: store-backed register
		if (size === 4) return this.io32[off >>> 2] | 0;
		if (size === 2) return this.io16[off >>> 1];
		return this.io8[off];
	}

	/**
	 * I/O write dispatched to the owning device.
	 * @param {number} off - offset from IO_BASE
	 * @param {number} v
	 * @param {number} size - 1/2/4
	 */
	#ioWrite(off, v, size) {
		if (off === IRQ_STAT) {
			this.iStat &= v; // writing acknowledges (clears) bits
			this.#updateIrqLine();
			return;
		}
		if (off === IRQ_MASK) {
			this.iMask = v & 0x7ff;
			this.#updateIrqLine();
			return;
		}

		if (off >= 0x40 && off < 0x60 && this.joypad !== null) {
			this.joypad.write(off - 0x40, v);
			return;
		}
		if (off >= 0x80 && off < 0x100 && this.dma !== null) {
			const rel = off - 0x80;
			if (size === 4) {
				this.dma.write32(rel, v);
				return;
			}
			// sub-word access: read-modify-write the containing register
			const aligned = rel & ~3;
			const shift = (rel & 3) * 8;
			const mask = (size === 2 ? 0xffff : 0xff) << shift;
			let cur = this.dma.read32(aligned) >>> 0;
			// DICR flag bits ack on 1-writes: untouched bytes must not self-ack
			if (aligned === 0x74) cur &= ~0xff000000;
			this.dma.write32(aligned, (cur & ~mask) | ((v << shift) & mask));
			return;
		}
		if (off >= 0x100 && off < 0x130 && this.timers !== null) {
			this.timers.write(off - 0x100, v);
			return;
		}
		if (off >= 0x800 && off < 0x804 && this.cdrom !== null) {
			this.cdrom.write8(off - 0x800, v & 0xff);
			if (size >= 2) this.cdrom.write8(off - 0x800, (v >>> 8) & 0xff);
			return;
		}
		if ((off === 0x810 || off === 0x814) && this.gpu !== null) {
			if (off === 0x810) this.gpu.gp0(v | 0);
			else this.gpu.gp1(v | 0);
			return;
		}
		if ((off === 0x820 || off === 0x824) && this.mdec !== null) {
			if (off === 0x820) this.mdec.writeWord(v >>> 0);
			else this.mdec.writeControl(v >>> 0);
			return;
		}
		if (off >= 0xc00 && off < 0x1000 && this.spu !== null) {
			this.spu.write16(off - 0xc00, v & 0xffff);
			if (size === 4) this.spu.write16(off - 0xc00 + 2, (v >>> 16) & 0xffff);
			return;
		}

		// fallback: store-backed register
		if (size === 4) this.io32[off >>> 2] = v;
		else if (size === 2) this.io16[off >>> 1] = v;
		else this.io8[off] = v;
	}
}
