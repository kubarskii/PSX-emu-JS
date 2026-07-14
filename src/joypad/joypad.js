import {MemoryCard} from "./memcard";

/**
 * SIO0 controller/memory-card port (0x1f801040) with one digital pad and
 * one memory card in slot 1. Slot 2 responds as absent.
 *
 * Protocol: the CPU exchanges bytes one at a time; after every byte the
 * device pulses /ACK which shows up as bit7 of JOY_STAT and raises IRQ7.
 */

/** button bits (0 = pressed) */
export const BUTTONS = {
	SELECT: 0x0001,
	START: 0x0008,
	UP: 0x0010,
	RIGHT: 0x0020,
	DOWN: 0x0040,
	LEFT: 0x0080,
	L2: 0x0100,
	R2: 0x0200,
	L1: 0x0400,
	R1: 0x0800,
	TRIANGLE: 0x1000,
	CIRCLE: 0x2000,
	CROSS: 0x4000,
	SQUARE: 0x8000,
};

/**
 * Cycles from a TX byte to the /ACK interrupt. The kernel pad routine
 * polls I_STAT for it with a timeout of ~1300 cycles, so this must stay
 * comfortably below that (and above the couple hundred cycles the kernel
 * spends acknowledging the previous /ACK first).
 */
const ACK_DELAY = 500;

export class Joypad {

	/**
	 * @param {(cycles: number, fn: () => void) => void} schedule
	 * @param {(bit: number) => void} raiseIrq
	 */
	constructor(schedule, raiseIrq) {
		this.schedule = schedule;
		this.raiseIrq = raiseIrq || (() => {});
		this._cbAckPulse = () => {
			this.ackPending = true;
			if ((this.ctrl & 0x1000) !== 0) {
				this.irqFlag = true;
				this.raiseIrq(7);
			}
			this.schedule(100, this._cbAckEnd);
		};
		this._cbAckEnd = () => { this.ackPending = false; };
		this.buttons = 0xffff; // all released
		this.rx = -1;          // received byte (-1 = fifo empty)
		this.seq = 0;          // position in the exchange
		this.device = 0;       // 0 none, 1 pad, 2 memory card
		this.ackPending = false;
		this.irqFlag = false;
		this.ctrl = 0;
		this.mode = 0;
		this.baud = 0;
		this.card = new MemoryCard();
	}

	/** @param {number} mask - BUTTONS.* */
	press(mask) {
		this.buttons &= ~mask;
	}

	/** @param {number} mask - BUTTONS.* */
	release(mask) {
		this.buttons |= mask;
	}

	/**
	 * @param {number} off - offset from 0x1f801040
	 * @param {number} size - 1/2/4
	 * @return {number}
	 */
	read(off, size) {
		switch (off) {
		case 0x0: { // JOY_DATA
			const v = this.rx < 0 ? 0xff : this.rx;
			this.rx = -1;
			return size === 4 ? (v | 0xffffff00) : v;
		}
		case 0x4: { // JOY_STAT
			let s = 0x5; // tx ready | tx done
			if (this.rx >= 0) s |= 1 << 1;
			if (this.ackPending) s |= 1 << 7;
			if (this.irqFlag) s |= 1 << 9;
			return s;
		}
		case 0x8: return this.mode;
		case 0xa: return this.ctrl;
		case 0xe: return this.baud;
		default: return 0;
		}
	}

	/**
	 * @param {number} off - offset from 0x1f801040
	 * @param {number} v
	 */
	write(off, v) {
		switch (off) {
		case 0x0: this.#tx(v & 0xff); return;
		case 0x8: this.mode = v & 0xffff; return;
		case 0xa:
			this.ctrl = v & 0xffff;
			if ((v & 0x40) !== 0) { // reset
				this.seq = 0;
				this.device = 0;
				this.rx = -1;
				this.irqFlag = false;
				this.ctrl = 0;
			}
			if ((v & 0x10) !== 0) this.irqFlag = false; // acknowledge
			if ((v & 0x2) === 0) { // deselect ends the exchange
				this.seq = 0;
				this.device = 0;
			}
			return;
		case 0xe: this.baud = v & 0xffff; return;
		default: return;
		}
	}

	/**
	 * @param {number} v - byte sent by the CPU
	 */
	#tx(v) {
		const selected = (this.ctrl & 0x2) !== 0 && (this.ctrl & 0x1) !== 0;
		const slot2 = (this.ctrl & 0x2000) !== 0;
		if (!selected || slot2) {
			this.rx = 0xff;
			return;
		}

		let reply = 0xff;
		let ack = true;
		if (this.seq === 0) {
			// address byte selects the device on the port
			if (v === 0x01) {
				this.device = 1;
			} else if (v === 0x81) {
				this.device = 2;
				this.card.begin();
			} else {
				this.device = 0;
			}
			ack = this.device !== 0;
		} else if (this.device === 2) {
			const r = this.card.transfer(v & 0xff);
			reply = r.reply;
			ack = r.ack;
		} else if (this.device === 1) {
			switch (this.seq) {
			case 1:
				if (v === 0x42) reply = 0x41; // digital pad id
				else { reply = 0xff; ack = false; this.device = 0; }
				break;
			case 2: reply = 0x5a; break;
			case 3: reply = this.buttons & 0xff; break;
			case 4: reply = (this.buttons >> 8) & 0xff; ack = false; break; // last byte: no /ACK
			default: reply = 0xff; ack = false;
			}
		} else {
			reply = 0xff;
			ack = false;
		}
		this.seq++;
		this.rx = reply;

		if (ack) {
			this.schedule(ACK_DELAY, this._cbAckPulse);
		}
	}
}
