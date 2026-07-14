/**
 * PSX root counters (three 16bit timers at 0x1f801100).
 *
 * Clock sources: timer0 counts sysclock or dotclock, timer1 sysclock or
 * hblanks, timer2 sysclock or sysclock/8. IRQs fire on reaching the
 * target and/or on 16bit overflow. The machine advances timers once per
 * scanline, which is enough resolution for BIOS and typical game timing.
 */

const IRQ_BITS = [4, 5, 6]; // I_STAT bits for timers 0..2

const MODE_SYNC_EN = 1 << 0;
const MODE_RESET_AT_TARGET = 1 << 3;
const MODE_IRQ_AT_TARGET = 1 << 4;
const MODE_IRQ_AT_MAX = 1 << 5;
const MODE_IRQ_REPEAT = 1 << 6;
const REACHED_TARGET = 1 << 11;
const REACHED_MAX = 1 << 12;

export class Timers {

	/**
	 * @param {(bit: number) => void} raiseIrq
	 */
	constructor(raiseIrq) {
		this.raiseIrq = raiseIrq || (() => {});
		this.value = new Uint32Array(3);
		this.mode = new Uint32Array(3);
		this.target = new Uint32Array(3);
		this.irqFired = [false, false, false];
		/** fractional accumulators for divided clock sources */
		this.frac = new Float64Array(3);
		/** dotclock divider, provided by the GPU each scanline */
		this.dotDivider = 8;
	}

	/**
	 * @param {number} off - register offset from 0x1f801100
	 * @return {number}
	 */
	read(off) {
		const t = (off >> 4) & 3;
		switch (off & 0xf) {
		case 0x0: return this.value[t] & 0xffff;
		case 0x4: {
			const m = this.mode[t] | (1 << 10); // no IRQ currently requested
			this.mode[t] &= ~(REACHED_TARGET | REACHED_MAX); // reset on read
			return m;
		}
		case 0x8: return this.target[t] & 0xffff;
		default: return 0;
		}
	}

	/**
	 * @param {number} off - register offset from 0x1f801100
	 * @param {number} v
	 */
	write(off, v) {
		const t = (off >> 4) & 3;
		switch (off & 0xf) {
		case 0x0:
			this.value[t] = v & 0xffff;
			return;
		case 0x4:
			this.mode[t] = v & 0x3ff;
			this.value[t] = 0;
			this.irqFired[t] = false;
			return;
		case 0x8:
			this.target[t] = v & 0xffff;
			return;
		default:
			return;
		}
	}

	/**
	 * Advances all three counters by one scanline worth of time.
	 * @param {number} cycles - CPU cycles in the scanline
	 * @param {number} hblanks - hblanks passed (1 per scanline)
	 * @param {boolean} inVblank
	 */
	advance(cycles, hblanks, inVblank) {
		// timer 0: sysclock or dotclock (video clock = sysclk * 11 / 7)
		const src0 = (this.mode[0] >> 8) & 3;
		if ((src0 & 1) === 0) {
			this.#tick(0, cycles);
		} else {
			this.frac[0] += cycles * 11 / (7 * this.dotDivider);
			const n = this.frac[0] | 0;
			this.frac[0] -= n;
			this.#tick(0, n);
		}

		// timer 1: sysclock or hblank; vblank sync modes
		const sync1 = this.mode[1] & MODE_SYNC_EN ? (this.mode[1] >> 1) & 3 : -1;
		let run1 = true;
		if (sync1 === 0 && inVblank) run1 = false;      // pause during vblank
		if (sync1 === 2 && !inVblank) run1 = false;     // pause outside vblank
		if (run1) {
			const src1 = (this.mode[1] >> 8) & 3;
			this.#tick(1, (src1 & 1) === 0 ? cycles : hblanks);
		}

		// timer 2: sysclock or sysclock/8; sync modes 0/3 stop it
		const sync2 = this.mode[2] & MODE_SYNC_EN ? (this.mode[2] >> 1) & 3 : -1;
		if (sync2 !== 0 && sync2 !== 3) {
			const src2 = (this.mode[2] >> 8) & 3;
			if (src2 < 2) {
				this.#tick(2, cycles);
			} else {
				this.frac[2] += cycles / 8;
				const n = this.frac[2] | 0;
				this.frac[2] -= n;
				this.#tick(2, n);
			}
		}
	}

	/** signals the start of vblank (reset-sync mode for timer 1) */
	onVblank() {
		if ((this.mode[1] & MODE_SYNC_EN) !== 0 && (((this.mode[1] >> 1) & 3) === 1)) {
			this.value[1] = 0;
		}
	}

	/**
	 * @param {number} t - timer index
	 * @param {number} n - ticks to add
	 */
	#tick(t, n) {
		if (n <= 0) return;
		const target = this.target[t] & 0xffff;
		let v = this.value[t] + n;

		if (target !== 0 && this.value[t] <= target && v > target) {
			this.mode[t] |= REACHED_TARGET;
			if ((this.mode[t] & MODE_IRQ_AT_TARGET) !== 0) this.#fire(t);
			if ((this.mode[t] & MODE_RESET_AT_TARGET) !== 0) {
				v = v % (target + 1);
			}
		}
		if (v > 0xffff) {
			this.mode[t] |= REACHED_MAX;
			if (target === 0) {
				this.mode[t] |= REACHED_TARGET;
				if ((this.mode[t] & MODE_IRQ_AT_TARGET) !== 0) this.#fire(t);
			}
			if ((this.mode[t] & MODE_IRQ_AT_MAX) !== 0) this.#fire(t);
			v &= 0xffff;
		}
		this.value[t] = v;
	}

	/**
	 * @param {number} t - timer index
	 */
	#fire(t) {
		if (this.irqFired[t] && (this.mode[t] & MODE_IRQ_REPEAT) === 0) return;
		this.irqFired[t] = true;
		this.raiseIrq(IRQ_BITS[t]);
	}
}
