/**
 * MDEC - the PSX macroblock (video) decoder at 0x1f801820.
 *
 * Implements the full decode pipeline per psx-spx: run-length coefficient
 * decoding, dequantization, IDCT with the uploaded scale table and
 * YUV->RGB conversion into 15bpp/24bpp (and monochrome 4/8bpp) pixels.
 * Decoding completes instantly; games only observe the fifo/busy/request
 * status bits, which behave like the real chip.
 */

/** zigzag order: zagzig[scan position] = block index */
const ZAGZIG = [
	0, 1, 8, 16, 9, 2, 3, 10,
	17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34,
	27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36,
	29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46,
	53, 60, 61, 54, 47, 55, 62, 63,
];

/** command being processed (state of the input stream) */
const IDLE = 0;
const DECODE = 1;
const QUANT = 2;
const SCALE = 3;

export class MDEC {

	constructor() {
		this.qtLuma = new Uint8Array(64);
		this.qtChroma = new Uint8Array(64);
		this.scale = new Int32Array(64); // pre-divided by 8

		this.state = IDLE;
		this.wordsLeft = 0;
		this.quantColor = false;
		this.quantPos = 0;

		/** decode parameters from the command word */
		this.depth = 2;      // 0=4bit 1=8bit 2=24bit 3=15bit
		this.signed = false;
		this.bit15 = false;

		/** halfword stream of the current decode command */
		this.codes = [];

		/** decoded pixels waiting to be read (32bit words, grown on demand) */
		this.out = new Int32Array(64 * 1024);
		this.outLen = 0;
		this.outPos = 0;

		/** control register: DMA enable bits */
		this.dmaInEnable = false;
		this.dmaOutEnable = false;

		/** scratch blocks */
		this._blk = new Int32Array(64);
		this._tmp = new Int32Array(64);
		this._cr = new Int32Array(64);
		this._cb = new Int32Array(64);
		this._y = [new Int32Array(64), new Int32Array(64), new Int32Array(64), new Int32Array(64)];
	}

	reset() {
		this.state = IDLE;
		this.wordsLeft = 0;
		this.codes.length = 0;
		this.outLen = 0;
		this.outPos = 0;
	}

	/**
	 * Makes room for n more output words without allocating per word.
	 * @param {number} n
	 * @return {Int32Array} - the (possibly regrown) output buffer
	 */
	#reserve(n) {
		if (this.outLen + n > this.out.length) {
			const bigger = new Int32Array(Math.max(this.out.length * 2, this.outLen + n));
			bigger.set(this.out.subarray(0, this.outLen));
			this.out = bigger;
		}
		return this.out;
	}

	/** @return {number} - MDEC1 status */
	readStatus() {
		let s = 0;
		const outEmpty = this.outPos >= this.outLen;
		if (outEmpty) s |= 1 << 31;
		// data-in fifo never fills (instant decode), bit30 stays 0
		if (this.state !== IDLE && this.wordsLeft > 0) s |= 1 << 29; // busy
		if (this.dmaInEnable) s |= 1 << 28;                          // in request
		if (this.dmaOutEnable && !outEmpty) s |= 1 << 27;            // out request
		s |= (this.depth & 3) << 25;
		if (this.signed) s |= 1 << 24;
		if (this.bit15) s |= 1 << 23;
		return s | 0;
	}

	/**
	 * MDEC1 control write.
	 * @param {number} v
	 */
	writeControl(v) {
		if ((v & 0x80000000) !== 0) this.reset();
		this.dmaInEnable = (v & 0x40000000) !== 0;
		this.dmaOutEnable = (v & 0x20000000) !== 0;
	}

	/**
	 * MDEC0 command/parameter write (also the DMA0 path).
	 * @param {number} word
	 */
	writeWord(word) {
		if (this.state === IDLE) {
			const cmd = word >>> 29;
			if (cmd === 1) { // decode macroblocks
				this.depth = (word >>> 27) & 3;
				this.signed = (word & (1 << 26)) !== 0;
				this.bit15 = (word & (1 << 25)) !== 0;
				this.wordsLeft = word & 0xffff;
				this.codes.length = 0;
				this.outLen = 0;
				this.outPos = 0;
				this.state = this.wordsLeft > 0 ? DECODE : IDLE;
			} else if (cmd === 2) { // set quant tables
				this.quantColor = (word & 1) !== 0;
				this.quantPos = 0;
				this.wordsLeft = this.quantColor ? 32 : 16;
				this.state = QUANT;
			} else if (cmd === 3) { // set scale table
				this.quantPos = 0;
				this.wordsLeft = 32;
				this.state = SCALE;
			}
			return;
		}

		this.wordsLeft--;
		if (this.state === DECODE) {
			this.codes.push(word & 0xffff, (word >>> 16) & 0xffff);
			if (this.wordsLeft === 0) {
				this.#decodeStream();
				this.state = IDLE;
			}
			return;
		}
		if (this.state === QUANT) {
			const base = this.quantPos * 4;
			const table = base < 64 ? this.qtLuma : this.qtChroma;
			const off = base & 63;
			table[off] = word & 0xff;
			table[off + 1] = (word >>> 8) & 0xff;
			table[off + 2] = (word >>> 16) & 0xff;
			table[off + 3] = (word >>> 24) & 0xff;
			this.quantPos++;
			if (this.wordsLeft === 0) this.state = IDLE;
			return;
		}
		if (this.state === SCALE) {
			const i = this.quantPos * 2;
			this.scale[i] = (word << 16) >> 16;
			this.scale[i + 1] = word >> 16;
			this.quantPos++;
			if (this.wordsLeft === 0) this.state = IDLE;
			return;
		}
	}

	/** @return {number} - next decoded word (also the DMA1 path) */
	readWord() {
		if (this.outPos < this.outLen) return this.out[this.outPos++] | 0;
		return 0;
	}

	/** decodes the buffered halfword stream into pixels */
	#decodeStream() {
		const codes = this.codes;
		let pos = 0;

		const next = () => (pos < codes.length ? codes[pos++] : 0xfe00);
		const hasMore = () => {
			while (pos < codes.length && codes[pos] === 0xfe00) pos++;
			return pos < codes.length;
		};

		if (this.depth >= 2) {
			// color: Cr, Cb, Y1..Y4 per 16x16 macroblock
			while (hasMore()) {
				if (!this.#rlBlock(this._cr, this.qtChroma, next)) break;
				this.#rlBlock(this._cb, this.qtChroma, next);
				for (let i = 0; i < 4; i++) this.#rlBlock(this._y[i], this.qtLuma, next);
				this.#emitColorMacroblock();
			}
		} else {
			// monochrome: independent Y blocks (8x8)
			while (hasMore()) {
				if (!this.#rlBlock(this._y[0], this.qtLuma, next)) break;
				this.#emitMonoBlock();
			}
		}
	}

	/**
	 * Run-length decodes + dequantizes + IDCTs one 8x8 block.
	 * @param {Int32Array} blk
	 * @param {Uint8Array} qt
	 * @param {() => number} next
	 * @return {boolean} - false when the stream ran out
	 */
	#rlBlock(blk, qt, next) {
		blk.fill(0);
		let n = next();
		while (n === 0xfe00) n = next();
		if (n === 0xfe00) return false;

		const qScale = (n >> 10) & 0x3f;
		let val = ext10(n & 0x3ff) * qt[0];
		let k = 0;
		for (;;) {
			if (qScale === 0) val = ext10(n & 0x3ff) * 2;
			val = clamp(val, -0x400, 0x3ff);
			if (qScale > 0) blk[ZAGZIG[k]] = val;
			else blk[k] = val;

			n = next();
			if (n === 0xfe00) break;
			k += ((n >> 10) & 0x3f) + 1;
			if (k > 63) break;
			// division truncates toward zero (>> would floor negatives
			// one off, which shows up as pixel noise on decoded stills)
			val = ((ext10(n & 0x3ff) * qt[k] * qScale + 4) / 8) | 0;
		}
		this.#idct(blk);
		return true;
	}

	/**
	 * Two-pass IDCT with the uploaded scale table.
	 * @param {Int32Array} blk
	 */
	#idct(blk) {
		const tmp = this._tmp;
		const scale = this.scale;
		let src = blk;
		let dst = tmp;
		// games upload the canonical 15bit-fixed cosine basis (row 0 =
		// 0x5A82 = sqrt(1/2)*32768); one 1D pass is sum/32768 with the
		// IDCT's own 1/2 factor on top, hence >> 16 with rounding
		for (let pass = 0; pass < 2; pass++) {
			for (let x = 0; x < 8; x++) {
				for (let y = 0; y < 8; y++) {
					let sum = 0;
					for (let z = 0; z < 8; z++) {
						sum += src[y + z * 8] * scale[x + z * 8];
					}
					dst[x + y * 8] = (sum + 0x8000) >> 16;
				}
			}
			const t = src;
			src = dst;
			dst = t;
		}
		if (src !== blk) blk.set(src);
	}

	/** converts the six decoded blocks into one 16x16 RGB macroblock */
	#emitColorMacroblock() {
		const cr = this._cr;
		const cb = this._cb;
		const out = this.#reserve(192); // 15bpp: 128 words, 24bpp: 192
		let n = this.outLen;
		const bias = this.signed ? 0 : 128;
		const stpBit = this.bit15 ? 0x8000 : 0;
		const px = this._pxScratch || (this._pxScratch = new Int32Array(256));

		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				const yblk = this._y[(y >> 3) * 2 + (x >> 3)];
				const lum = yblk[(y & 7) * 8 + (x & 7)];
				const ci = (y >> 1) * 8 + (x >> 1);
				const r = clamp(lum + ((1435 * cr[ci]) >> 10), -128, 127) + bias;
				const g = clamp(lum - ((352 * cb[ci] + 731 * cr[ci]) >> 10), -128, 127) + bias;
				const b = clamp(lum + ((1815 * cb[ci]) >> 10), -128, 127) + bias;
				px[y * 16 + x] = (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);
			}
		}

		if (this.depth === 3) { // 15bpp: two pixels per word
			for (let i = 0; i < 256; i += 2) {
				const a = to15(px[i]) | stpBit;
				const b = to15(px[i + 1]) | stpBit;
				out[n++] = (a | (b << 16)) | 0;
			}
		} else { // 24bpp: packed bytes
			let acc = 0;
			let bits = 0;
			for (let i = 0; i < 256; i++) {
				const p = px[i];
				for (let s = 0; s < 24; s += 8) {
					acc |= ((p >> s) & 0xff) << bits;
					bits += 8;
					if (bits === 32) {
						out[n++] = acc | 0;
						acc = 0;
						bits = 0;
					}
				}
			}
			if (bits > 0) out[n++] = acc | 0;
		}
		this.outLen = n;
	}

	/** emits one 8x8 monochrome block (4bit or 8bit) */
	#emitMonoBlock() {
		const y = this._y[0];
		const out = this.#reserve(16);
		let n = this.outLen;
		const bias = this.signed ? 0 : 128;
		if (this.depth === 1) { // 8bit: 4 pixels per word
			for (let i = 0; i < 64; i += 4) {
				let w = 0;
				for (let j = 0; j < 4; j++) {
					w |= (clamp(y[i + j], -128, 127) + bias & 0xff) << (j * 8);
				}
				out[n++] = w | 0;
			}
		} else { // 4bit: 8 pixels per word
			for (let i = 0; i < 64; i += 8) {
				let w = 0;
				for (let j = 0; j < 8; j++) {
					const v = (clamp(y[i + j], -128, 127) + bias) >> 4;
					w |= (v & 0xf) << (j * 4);
				}
				out[n++] = w | 0;
			}
		}
		this.outLen = n;
	}
}

/**
 * @param {number} v - 10bit value
 * @return {number} - sign-extended
 */
function ext10(v) {
	return (v << 22) >> 22;
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @return {number}
 */
function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * @param {number} rgb - 8:8:8 in low 24 bits
 * @return {number} - 5:5:5
 */
function to15(rgb) {
	return ((rgb >> 3) & 0x1f) | ((rgb >> 6) & 0x3e0) | ((rgb >> 9) & 0x7c00);
}
