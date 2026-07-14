/**
 * PSX DMA controller (7 channels at 0x1f801080).
 *
 * Transfers complete instantly (no cycle stealing): fine for everything
 * that polls the busy bit or waits for the completion IRQ.
 *
 * Implemented channels: 2 GPU (block + linked list, both directions),
 * 3 CDROM (block reads), 4 SPU (data accepted/dropped), 6 OTC (ordering
 * table). MDEC channels accept and drop data.
 */

import {PAGE_SHIFT} from "../memory";

const CHCR_FROM_RAM = 1 << 0;
const CHCR_BACKWARD = 1 << 1;
const CHCR_START = 1 << 24;
const CHCR_TRIGGER = 1 << 28;

export class DMA {

	/**
	 * @param {import("../memory").Memory} mem
	 * @param {(bit: number) => void} raiseIrq
	 */
	constructor(mem, raiseIrq) {
		this.mem = mem;
		this.raiseIrq = raiseIrq || (() => {});
		this.gpu = null;
		this.cdrom = null;
		this.spu = null;
		this.mdec = null;
		this.madr = new Uint32Array(7);
		this.bcr = new Uint32Array(7);
		this.chcr = new Uint32Array(7);
		this.dpcr = 0x07654321;
		this.dicr = 0;
		/** @type {((cycles: number, fn: () => void) => void) | null} */
		this.schedule = null;
		/** @type {(() => number) | null} - current CPU cycle */
		this.now = null;
		/** cycle when each channel's last queued transfer drains */
		this._chFreeAt = new Float64Array(7);
	}

	/**
	 * @param {number} off - register offset from 0x1f801080
	 * @return {number}
	 */
	read32(off) {
		if (off === 0x70) return this.dpcr | 0;
		if (off === 0x74) return this.#dicrValue() | 0;
		const ch = off >> 4;
		if (ch > 6) return 0;
		switch (off & 0xf) {
		case 0x0: return this.madr[ch] | 0;
		case 0x4: return this.bcr[ch] | 0;
		case 0x8: return this.chcr[ch] | 0;
		default: return 0;
		}
	}

	/**
	 * @param {number} off - register offset from 0x1f801080
	 * @param {number} v - u32
	 */
	write32(off, v) {
		if (off === 0x70) {
			this.dpcr = v >>> 0;
			return;
		}
		if (off === 0x74) {
			// bits 0-23 control, bits 24-30 acknowledge flags by writing 1
			const flags = this.dicr & 0x7f000000 & ~(v & 0x7f000000);
			this.dicr = (v & 0x00ff803f) | flags;
			return;
		}
		const ch = off >> 4;
		if (ch > 6) return;
		switch (off & 0xf) {
		case 0x0: this.madr[ch] = v & 0x00ffffff; return;
		case 0x4: this.bcr[ch] = v >>> 0; return;
		case 0x8:
			this.chcr[ch] = v >>> 0;
			if (this.#active(ch)) this.#transfer(ch);
			return;
		default: return;
		}
	}

	/** @return {number} - DICR with the computed master flag (bit 31) */
	#dicrValue() {
		let v = this.dicr;
		const force = (v & 0x8000) !== 0;
		const enabled = (v & 0x800000) !== 0;
		const some = (v & ((v & 0x7f0000) << 8)) !== 0;
		if (force || (enabled && some)) v |= 0x80000000;
		return v;
	}

	/**
	 * @param {number} ch
	 * @return {boolean} - channel enabled and started
	 */
	#active(ch) {
		if ((this.dpcr & (8 << (ch * 4))) === 0) return false;
		const chcr = this.chcr[ch];
		if ((chcr & CHCR_START) === 0) return false;
		const sync = (chcr >>> 9) & 3;
		if (sync === 0 && (chcr & CHCR_TRIGGER) === 0) return false;
		return true;
	}

	/**
	 * Moves the data immediately, but models the channel draining at the
	 * bus rate (~1 word/cycle): CHCR stays busy and the completion flag +
	 * IRQ3 arrive together when the transfer would really end. Games chain
	 * work from the DMA-complete ISR (NFS Porsche builds its menu display
	 * list there); completing inside the CHCR write runs that ISR nested in
	 * the code that kicked the DMA, which never happens on hardware. Kicks
	 * issued while the channel drains queue up behind it; channels drain
	 * independently of each other.
	 * @param {number} ch
	 */
	#transfer(ch) {
		const chcr = this.chcr[ch];
		const sync = (chcr >>> 9) & 3;

		let words;
		if (ch === 6) {
			words = this.#otc();
		} else if (sync === 2) {
			words = this.#linkedList(ch);
		} else {
			words = this.#block(ch, sync);
		}

		if (this.schedule !== null && this.now !== null) {
			const now = this.now();
			const doneAt = Math.max(now, this._chFreeAt[ch]) + Math.max(24, words);
			this._chFreeAt[ch] = doneAt;
			this.schedule(doneAt - now, () => {
				if (this.now() >= this._chFreeAt[ch]) {
					this.chcr[ch] &= ~(CHCR_START | CHCR_TRIGGER);
				}
				this.#finishIrq(ch);
			});
		} else {
			// no scheduler attached (unit tests drive the DMA directly)
			this.chcr[ch] = chcr & ~(CHCR_START | CHCR_TRIGGER);
			this.#finishIrq(ch);
		}
	}

	/**
	 * Ordering table clear: builds a reverse singly-linked list in RAM.
	 * @return {number} - words written
	 */
	#otc() {
		const ram32 = this.mem.ram32;
		let count = this.bcr[6] & 0xffff;
		if (count === 0) count = 0x10000;
		let a = this.madr[6] & 0x1ffffc;
		for (let i = count - 1; i > 0; i--) {
			this.#invalidate(a);
			ram32[a >>> 2] = (a - 4) & 0x1fffff;
			a = (a - 4) & 0x1ffffc;
		}
		this.#invalidate(a);
		ram32[a >>> 2] = 0x00ffffff;
		return count;
	}

	/**
	 * @param {number} ch
	 * @param {number} sync - 0 burst / 1 block
	 * @return {number} - words moved
	 */
	#block(ch, sync) {
		const ram32 = this.mem.ram32;
		const fromRam = (this.chcr[ch] & CHCR_FROM_RAM) !== 0;
		const step = (this.chcr[ch] & CHCR_BACKWARD) !== 0 ? -4 : 4;
		let addr = this.madr[ch] & 0x1ffffc;
		let words;
		if (sync === 0) {
			words = this.bcr[ch] & 0xffff;
			if (words === 0) words = 0x10000;
		} else {
			let blockSize = this.bcr[ch] & 0xffff;
			if (blockSize === 0) blockSize = 0x10000;
			let blocks = (this.bcr[ch] >>> 16) & 0xffff;
			if (blocks === 0) blocks = 0x10000;
			words = blockSize * blocks;
		}

		for (let i = 0; i < words; i++) {
			if (fromRam) {
				const w = ram32[addr >>> 2] | 0;
				this.#deviceWrite(ch, w);
			} else {
				this.#invalidate(addr);
				ram32[addr >>> 2] = this.#deviceRead(ch);
			}
			addr = (addr + step) & 0x1ffffc;
		}
		this.madr[ch] = addr;
		return words;
	}

	/**
	 * GPU linked-list mode: walks ordering table packets in RAM.
	 * @param {number} ch
	 * @return {number} - words fed to the device (incl. one per header)
	 */
	#linkedList(ch) {
		const ram32 = this.mem.ram32;
		let addr = this.madr[ch] & 0x1ffffc;
		let words = 0;
		// hard bound protects against corrupt/looping lists
		for (let guard = 0; guard < 0x100000; guard++) {
			const header = ram32[addr >>> 2] >>> 0;
			const count = header >>> 24;
			words += count + 1;
			for (let i = 1; i <= count; i++) {
				this.#deviceWrite(ch, ram32[((addr + i * 4) & 0x1ffffc) >>> 2] | 0);
			}
			if ((header & 0x800000) !== 0) break;
			addr = header & 0x1ffffc;
		}
		// hardware leaves the end marker, not the terminator's address
		this.madr[ch] = 0x00ffffff;
		return words;
	}

	/**
	 * @param {number} ch
	 * @param {number} w - word going to the device
	 */
	#deviceWrite(ch, w) {
		if (ch === 0 && this.mdec !== null) this.mdec.writeWord(w >>> 0);
		else if (ch === 2 && this.gpu !== null) this.gpu.gp0(w);
		else if (ch === 4 && this.spu !== null) this.spu.dmaWrite(w);
		// PIO and others: dropped
	}

	/**
	 * @param {number} ch
	 * @return {number} - word coming from the device
	 */
	#deviceRead(ch) {
		if (ch === 1 && this.mdec !== null) return this.mdec.readWord();
		if (ch === 2 && this.gpu !== null) return this.gpu.readData();
		if (ch === 3 && this.cdrom !== null) return this.cdrom.readDataWord();
		if (ch === 4 && this.spu !== null) return this.spu.dmaRead();
		return 0;
	}

	/**
	 * Sets the per-channel completion flag and raises IRQ3 when enabled.
	 * @param {number} ch
	 */
	#finishIrq(ch) {
		const enabled = (this.dicr & (1 << (16 + ch))) !== 0;
		const master = (this.dicr & 0x800000) !== 0;
		if (enabled) {
			this.dicr |= 1 << (24 + ch);
			if (master) this.raiseIrq(3);
		}
	}

	/**
	 * Keeps the block cache honest when DMA lands in executable pages.
	 * @param {number} addr - RAM offset
	 */
	#invalidate(addr) {
		const page = addr >>> PAGE_SHIFT;
		if (this.mem.codePages[page] !== 0 && this.mem.onCodeWrite !== null) {
			this.mem.onCodeWrite(page);
		}
	}
}
