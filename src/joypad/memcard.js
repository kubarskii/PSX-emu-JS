/**
 * PSX memory card (128KB, 1024 sectors x 128 bytes) speaking the SIO0
 * byte-exchange protocol. Lives on the same port as the controller; the
 * Joypad routes bytes here when the CPU addresses device 0x81.
 *
 * https://psx-spx.consoledev.net/controllersandmemorycards/#memory-card-protocol
 */

export const CARD_SIZE = 128 * 1024;
const SECTOR = 128;
const SECTORS = CARD_SIZE / SECTOR;

/** FLAG bit3: card was not read since powerup/insertion */
const FLAG_FRESH = 0x08;

export class MemoryCard {

	constructor() {
		this.data = new Uint8Array(CARD_SIZE);
		this.flag = FLAG_FRESH;
		/** called after a sector write is committed */
		this.onWrite = null;

		this.cmd = 0;
		this.step = 0;
		this.addr = 0;
		this.chk = 0;
		this.buf = new Uint8Array(SECTOR);
		this.bad = false;

		this.format();
	}

	/**
	 * Loads a card image (e.g. from persisted storage).
	 * @param {ArrayBuffer | Uint8Array} image
	 */
	load(image) {
		const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
		if (bytes.length === CARD_SIZE) {
			this.data.set(bytes);
			this.flag = FLAG_FRESH;
		}
	}

	/** Writes a fresh, formatted card image (so games can save right away). */
	format() {
		const d = this.data;
		d.fill(0);
		// header frame: "MC"
		d[0] = 0x4d;
		d[1] = 0x43;
		this.#frameChecksum(0);
		// directory frames 1-15: free blocks
		for (let f = 1; f <= 15; f++) {
			const o = f * SECTOR;
			d[o] = 0xa0;                 // free, freshly formatted
			d[o + 8] = 0xff;             // no next block
			d[o + 9] = 0xff;
			this.#frameChecksum(f);
		}
		// broken-sector list frames 16-35: none broken
		for (let f = 16; f <= 35; f++) {
			const o = f * SECTOR;
			d[o] = 0xff;
			d[o + 1] = 0xff;
			d[o + 2] = 0xff;
			d[o + 3] = 0xff;
			d[o + 8] = 0xff;
			d[o + 9] = 0xff;
			this.#frameChecksum(f);
		}
		// test-write frame 63 mirrors the header
		d[63 * SECTOR] = 0x4d;
		d[63 * SECTOR + 1] = 0x43;
		this.#frameChecksum(63);
	}

	/**
	 * @param {number} frame
	 */
	#frameChecksum(frame) {
		const o = frame * SECTOR;
		let x = 0;
		for (let i = 0; i < SECTOR - 1; i++) x ^= this.data[o + i];
		this.data[o + SECTOR - 1] = x;
	}

	/** starts a new exchange (after the 0x81 address byte) */
	begin() {
		this.cmd = 0;
		this.step = 0;
		this.bad = false;
	}

	/**
	 * Exchanges one byte with the card.
	 * @param {number} v - byte from the CPU
	 * @return {{reply: number, ack: boolean}} - ack=false ends the exchange
	 */
	transfer(v) {
		if (this.cmd === 0) {
			// command byte
			if (v === 0x52 || v === 0x57 || v === 0x53) {
				this.cmd = v;
				this.step = 0;
				return {reply: this.flag, ack: true};
			}
			return {reply: this.flag, ack: false};
		}
		if (this.cmd === 0x52) return this.#read(v);
		if (this.cmd === 0x57) return this.#write(v);
		return this.#id();
	}

	/**
	 * Read-sector state machine.
	 * @param {number} v
	 * @return {{reply: number, ack: boolean}}
	 */
	#read(v) {
		const s = this.step++;
		if (s === 0) return {reply: 0x5a, ack: true};
		if (s === 1) return {reply: 0x5d, ack: true};
		if (s === 2) {
			this.addr = (v << 8);
			return {reply: 0x00, ack: true};
		}
		if (s === 3) {
			this.addr = (this.addr | v) & 0x3ff;
			return {reply: (this.addr >> 8) & 0xff, ack: true};
		}
		if (s === 4) return {reply: 0x5c, ack: true};
		if (s === 5) return {reply: 0x5d, ack: true};
		if (s === 6) return {reply: (this.addr >> 8) & 0xff, ack: true};
		if (s === 7) {
			this.chk = ((this.addr >> 8) & 0xff) ^ (this.addr & 0xff);
			return {reply: this.addr & 0xff, ack: true};
		}
		if (s >= 8 && s < 8 + SECTOR) {
			const byte = this.data[this.addr * SECTOR + (s - 8)];
			this.chk ^= byte;
			return {reply: byte, ack: true};
		}
		if (s === 8 + SECTOR) return {reply: this.chk & 0xff, ack: true};
		this.flag &= ~FLAG_FRESH; // a completed read marks the card as seen
		return {reply: 0x47, ack: false};
	}

	/**
	 * Write-sector state machine.
	 * @param {number} v
	 * @return {{reply: number, ack: boolean}}
	 */
	#write(v) {
		const s = this.step++;
		if (s === 0) return {reply: 0x5a, ack: true};
		if (s === 1) return {reply: 0x5d, ack: true};
		if (s === 2) {
			this.addr = (v << 8);
			return {reply: 0x00, ack: true};
		}
		if (s === 3) {
			this.addr = this.addr | v; // sector validity checked at the end
			this.chk = ((this.addr >> 8) & 0xff) ^ (this.addr & 0xff);
			return {reply: (this.addr >> 8) & 0xff, ack: true};
		}
		if (s >= 4 && s < 4 + SECTOR) {
			this.buf[s - 4] = v;
			this.chk ^= v;
			return {reply: s === 4 ? this.addr & 0xff : this.buf[s - 5], ack: true};
		}
		if (s === 4 + SECTOR) {
			this.bad = (v !== (this.chk & 0xff));
			return {reply: this.buf[SECTOR - 1], ack: true};
		}
		if (s === 5 + SECTOR) return {reply: 0x5c, ack: true};
		if (s === 6 + SECTOR) return {reply: 0x5d, ack: true};
		// end status
		if (this.bad) return {reply: 0xff, ack: false};
		if (this.addr > 0x3ff) return {reply: 0x4e, ack: false};
		this.data.set(this.buf, this.addr * SECTOR);
		this.flag &= ~FLAG_FRESH;
		if (this.onWrite !== null) this.onWrite();
		return {reply: 0x47, ack: false};
	}

	/**
	 * Get-ID state machine.
	 * @return {{reply: number, ack: boolean}}
	 */
	#id() {
		const s = this.step++;
		const seq = [0x5a, 0x5d, 0x5c, 0x5d, 0x04, 0x00, 0x00, 0x80];
		if (s < seq.length - 1) return {reply: seq[s], ack: true};
		return {reply: seq[seq.length - 1], ack: false};
	}
}

export {SECTORS};
