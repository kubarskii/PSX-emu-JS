/**
 * SPU with sound synthesis.
 *
 * 24 ADPCM voices with ADSR envelopes, pitch stepping (linear
 * interpolation instead of the hardware's gaussian filter), noise (LFSR)
 * and stereo mixing at 44100Hz. The machine pulls samples once per video
 * frame; the browser feeds them to WebAudio.
 *
 * Sound RAM IRQ (0x1da4 + SPUCNT bit6) is emulated: voices fetching the
 * ADPCM block at the IRQ address and transfer writes crossing it raise
 * IRQ9 — streamed music (double-buffered through SPU RAM) relies on it
 * to advance, otherwise the same buffer loops forever.
 *
 * Not implemented: reverb, pitch modulation (PMON).
 */

const SPUCNT = 0x1aa;
const SPUSTAT = 0x1ae;
const TRANSFER_ADDR = 0x1a6;
const TRANSFER_FIFO = 0x1a8;
const IRQ_ADDR = 0x1a4;

export const SAMPLE_RATE = 44100;

/** ADPCM predictor filter coefficients */
const F0 = [0, 60, 115, 98, 122];
const F1 = [0, 0, -52, -55, -60];

class Voice {

	constructor() {
		this.volL = 0;
		this.volR = 0;
		this.pitch = 0;
		this.startAddr = 0;
		this.repeatAddr = 0;
		this.adsr = 0;        // 32bit ADSR config
		this.envVol = 0;      // 0..0x7fff
		this.envTick = 0;     // samples until the next envelope step
		this.phase = 0;       // 0 off, 1 attack, 2 decay, 3 sustain, 4 release
		this.addr = 0;        // current ADPCM block address
		this.old = 0;
		this.older = 0;
		this.block = new Int16Array(28);
		this.blockPos = 28;   // force decode on first step
		this.counter = 0;     // 12.12 fixed point sample counter
		this.cur = 0;         // current/previous samples for interpolation
		this.prev = 0;
		this.endx = false;
	}

	keyOn() {
		this.addr = this.startAddr;
		this.repeatAddr = this.startAddr;
		this.old = 0;
		this.older = 0;
		this.blockPos = 28;
		this.counter = 0;
		this.envVol = 0;
		this.envTick = 0;
		this.phase = 1;
		this.endx = false;
	}

	keyOff() {
		if (this.phase !== 0) this.phase = 4;
	}
}

export class SPU {

	/**
	 * @param {(bit: number) => void} [raiseIrq]
	 */
	constructor(raiseIrq) {
		this.raiseIrq = raiseIrq || (() => {});
		this.regs = new Uint16Array(0x200); // register backing store
		this.ram = new Uint8Array(512 * 1024);
		this.transferAddr = 0;
		this.irqFlag = false;
		this.voices = Array.from({length: 24}, () => new Voice());
		this.noiseLevel = 0x7fff;
		this.noiseTimer = 0;
		/** mixed stereo output, interleaved L/R, pulled by the frontend */
		this.buffer = new Float32Array(16384);
		this.bufLen = 0;

		/**
		 * CD audio input (CDDA sectors / decoded XA-ADPCM), a ring of
		 * interleaved s16 pairs already resampled to 44100Hz.
		 */
		this.cdRing = new Int16Array(65536 * 2);
		this.cdHead = 0;
		this.cdTail = 0;
		// resampler phase and boundary pair, carried across sectors so the
		// stream stays gapless (dropping even one pair per sector starves
		// the ring by 75 pairs/s and crackles constantly); starts at 1 so
		// the very first emission lands on the first source pair
		this.cdResamplePos = 1;
		this.cdPrevL = 0;
		this.cdPrevR = 0;
	}

	/**
	 * Queues CD audio, resampling to 44100Hz with linear interpolation.
	 * @param {Int16Array} pcm - interleaved stereo samples
	 * @param {number} rate - source sample rate (44100/37800/18900)
	 */
	pushCdAudio(pcm, rate) {
		const pairs = pcm.length >> 1;
		if (pairs === 0) return;
		const step = rate / 44100;
		const ring = this.cdRing;
		const mask = ring.length - 1;
		// pos is measured in source pairs, -1 being the previous sector's
		// final pair, so interpolation crosses the sector boundary
		let pos = this.cdResamplePos - 1;
		while (pos < pairs - 1) {
			const i = Math.floor(pos);
			const f = pos - i;
			const l0 = i < 0 ? this.cdPrevL : pcm[i * 2];
			const r0 = i < 0 ? this.cdPrevR : pcm[i * 2 + 1];
			const l = (l0 + (pcm[(i + 1) * 2] - l0) * f) | 0;
			const r = (r0 + (pcm[(i + 1) * 2 + 1] - r0) * f) | 0;
			const used = (this.cdHead - this.cdTail) & mask;
			if (used >= ring.length - 4) this.cdTail = (this.cdTail + 2) & mask; // drop oldest
			ring[this.cdHead] = l;
			ring[(this.cdHead + 1) & mask] = r;
			this.cdHead = (this.cdHead + 2) & mask;
			pos += step;
		}
		this.cdResamplePos = pos - (pairs - 1);
		this.cdPrevL = pcm[(pairs - 1) * 2];
		this.cdPrevR = pcm[(pairs - 1) * 2 + 1];
	}

	/**
	 * @param {number} off - offset from 0x1f801c00
	 * @return {number} - u16
	 */
	read16(off) {
		off &= 0x3fe;
		if (off === SPUSTAT) {
			return (this.regs[SPUCNT >> 1] & 0x3f) | (this.irqFlag ? 0x40 : 0);
		}
		if (off < 0x180) { // voice registers
			const v = this.voices[(off >> 4) & 0x1f];
			if (v === undefined) return 0;
			if ((off & 0xf) === 0xc) return v.envVol & 0xffff; // current ADSR volume
		}
		if (off === 0x19c) { // ENDX low
			let e = 0;
			for (let i = 0; i < 16; i++) if (this.voices[i].endx) e |= 1 << i;
			return e;
		}
		if (off === 0x19e) { // ENDX high
			let e = 0;
			for (let i = 16; i < 24; i++) if (this.voices[i].endx) e |= 1 << (i - 16);
			return e;
		}
		return this.regs[off >> 1];
	}

	/**
	 * @param {number} off - offset from 0x1f801c00
	 * @param {number} v - u16
	 */
	write16(off, v) {
		off &= 0x3fe;
		v &= 0xffff;
		this.regs[off >> 1] = v;

		if (off < 0x180) {
			const voice = this.voices[(off >> 4) & 0x1f];
			if (voice === undefined) return;
			switch (off & 0xf) {
			case 0x0: voice.volL = volumeOf(v); return;
			case 0x2: voice.volR = volumeOf(v); return;
			case 0x4: voice.pitch = v; return;
			case 0x6: voice.startAddr = (v * 8) & 0x7ffff; return;
			case 0x8: voice.adsr = (voice.adsr & 0xffff0000) | v; return;
			case 0xa: voice.adsr = ((v << 16) | (voice.adsr & 0xffff)) >>> 0; return;
			case 0xc: voice.envVol = v & 0x7fff; return; // overwrite live envelope
			case 0xe: voice.repeatAddr = (v * 8) & 0x7ffff; return;
			default: return;
			}
		}

		switch (off) {
		case 0x188: this.#keyOn(v, 0); return;
		case 0x18a: this.#keyOn(v, 16); return;
		case 0x18c: this.#keyOff(v, 0); return;
		case 0x18e: this.#keyOff(v, 16); return;
		case SPUCNT:
			if ((v & 0x40) === 0) this.irqFlag = false; // ack IRQ9
			return;
		case TRANSFER_FIFO:
			this.#checkIrq(this.transferAddr & 0x7fffe);
			this.ram[this.transferAddr] = v & 0xff;
			this.ram[(this.transferAddr + 1) & 0x7ffff] = v >> 8;
			this.transferAddr = (this.transferAddr + 2) & 0x7ffff;
			return;
		case TRANSFER_ADDR:
			this.transferAddr = (v * 8) & 0x7ffff;
			return;
		default:
			return;
		}
	}

	/**
	 * Raises IRQ9 when the sound RAM IRQ is armed (SPUCNT bit6) and `addr`
	 * lands in the same 8-byte unit as the IRQ address register.
	 * @param {number} addr - sound RAM byte address being accessed
	 */
	#checkIrq(addr) {
		if (this.irqFlag || (this.regs[SPUCNT >> 1] & 0x40) === 0) return;
		const irqAddr = (this.regs[IRQ_ADDR >> 1] * 8) & 0x7ffff;
		if ((addr & 0x7fff8) === (irqAddr & 0x7fff8)) {
			this.irqFlag = true;
			this.raiseIrq(9);
		}
	}

	/**
	 * @param {number} bits
	 * @param {number} base - 0 or 16
	 */
	#keyOn(bits, base) {
		for (let i = 0; i < 16; i++) {
			if ((bits & (1 << i)) !== 0 && this.voices[base + i] !== undefined) {
				this.voices[base + i].keyOn();
			}
		}
	}

	/**
	 * @param {number} bits
	 * @param {number} base - 0 or 16
	 */
	#keyOff(bits, base) {
		for (let i = 0; i < 16; i++) {
			if ((bits & (1 << i)) !== 0 && this.voices[base + i] !== undefined) {
				this.voices[base + i].keyOff();
			}
		}
	}

	/**
	 * @param {number} w - word arriving over DMA4
	 */
	dmaWrite(w) {
		this.write16(TRANSFER_FIFO, w & 0xffff);
		this.write16(TRANSFER_FIFO, (w >>> 16) & 0xffff);
	}

	/** @return {number} - word for DMA4 reads */
	dmaRead() {
		this.#checkIrq(this.transferAddr & 0x7fffc);
		const lo = this.ram[this.transferAddr] | (this.ram[(this.transferAddr + 1) & 0x7ffff] << 8);
		const hi = this.ram[(this.transferAddr + 2) & 0x7ffff] | (this.ram[(this.transferAddr + 3) & 0x7ffff] << 8);
		this.transferAddr = (this.transferAddr + 4) & 0x7ffff;
		return (lo | (hi << 16)) | 0;
	}

	/**
	 * Synthesizes stereo samples into the pull buffer.
	 * @param {number} count - samples (pairs) to generate
	 */
	generate(count) {
		const cnt = this.regs[SPUCNT >> 1];
		const spuEnabled = (cnt & 0x8000) !== 0;
		const muted = (cnt & 0x4000) === 0;
		const cdEnabled = (cnt & 0x0001) !== 0;
		const mainL = volumeOf(this.regs[0x180 >> 1]);
		const mainR = volumeOf(this.regs[0x182 >> 1]);
		const cdL = volumeOf(this.regs[0x1b0 >> 1]);
		const cdR = volumeOf(this.regs[0x1b2 >> 1]);
		const noiseOn = (this.regs[0x194 >> 1] | (this.regs[0x196 >> 1] << 16)) >>> 0;
		const ring = this.cdRing;
		const mask = ring.length - 1;

		for (let s = 0; s < count; s++) {
			// the CD input is a live stream: it drains even while the CD
			// enable bit is off, otherwise stale audio bursts on re-enable
			let cdInL = 0;
			let cdInR = 0;
			if (this.cdTail !== this.cdHead) {
				cdInL = ring[this.cdTail];
				cdInR = ring[(this.cdTail + 1) & mask];
				this.cdTail = (this.cdTail + 2) & mask;
			}
			let outL = 0;
			let outR = 0;
			if (cdEnabled) {
				outL = (cdInL * cdL) >> 15;
				outR = (cdInR * cdR) >> 15;
			}
			if (spuEnabled) {
				this.#stepNoise(cnt);
				let mixL = 0;
				let mixR = 0;
				for (let i = 0; i < 24; i++) {
					const v = this.voices[i];
					if (v.phase === 0) continue;
					// the ADPCM fetch keeps stepping in noise mode: ENDX and
					// the sound-RAM IRQ still fire from the voice address
					const adpcm = this.#voiceSample(v);
					const sample = (noiseOn & (1 << i)) !== 0
						? ((this.noiseLevel << 16) >> 16)
						: adpcm;
					stepEnvelope(v);
					const amplified = (sample * v.envVol) >> 15;
					mixL += (amplified * v.volL) >> 15;
					mixR += (amplified * v.volR) >> 15;
				}
				// SPUCNT mute silences the voices; CD audio passes through
				if (!muted) {
					outL += mixL;
					outR += mixR;
				}
			}
			outL = (outL * mainL) >> 15;
			outR = (outR * mainR) >> 15;
			if (outL > 32767) outL = 32767; else if (outL < -32768) outL = -32768;
			if (outR > 32767) outR = 32767; else if (outR < -32768) outR = -32768;
			if (this.bufLen < this.buffer.length - 1) {
				this.buffer[this.bufLen++] = outL / 32768;
				this.buffer[this.bufLen++] = outR / 32768;
			}
		}
	}

	/**
	 * Drains the pull buffer into `out` (interleaved stereo), zero-filling
	 * on underrun.
	 * @param {Float32Array} out
	 * @return {number} - samples written
	 */
	drain(out) {
		const n = Math.min(out.length, this.bufLen);
		out.set(this.buffer.subarray(0, n));
		out.fill(0, n);
		this.buffer.copyWithin(0, n, this.bufLen);
		this.bufLen -= n;
		return n;
	}

	/**
	 * @param {Voice} v
	 * @return {number} - signed 16bit sample
	 */
	#voiceSample(v) {
		// advance the 12.12 pitch counter (0x1000 = 44100Hz)
		let step = v.pitch;
		if (step > 0x3fff) step = 0x3fff;
		v.counter += step;
		while (v.counter >= 0x1000) {
			v.counter -= 0x1000;
			v.prev = v.cur;
			if (v.blockPos >= 28) this.#decodeBlock(v);
			v.cur = v.block[v.blockPos++];
		}
		// linear interpolation between the two most recent samples
		const frac = v.counter & 0xfff;
		return (v.prev + (((v.cur - v.prev) * frac) >> 12)) | 0;
	}

	/**
	 * Decodes the next 16-byte ADPCM block of a voice.
	 * @param {Voice} v
	 */
	#decodeBlock(v) {
		const ram = this.ram;
		const base = v.addr & 0x7fff0;
		this.#checkIrq(base);
		this.#checkIrq(base + 8);
		const shiftFilter = ram[base];
		const flags = ram[base + 1];
		let shift = shiftFilter & 0xf;
		if (shift > 12) shift = 9;
		const filter = Math.min((shiftFilter >> 4) & 0xf, 4);
		const f0 = F0[filter];
		const f1 = F1[filter];

		let old = v.old;
		let older = v.older;
		for (let i = 0; i < 28; i++) {
			const byte = ram[base + 2 + (i >> 1)];
			let nibble = (i & 1) === 0 ? (byte & 0xf) : (byte >> 4);
			nibble = (nibble << 28) >> 28; // sign extend
			let sample = (nibble << 12) >> shift;
			sample += ((old * f0 + older * f1 + 32) / 64) | 0;
			if (sample > 32767) sample = 32767;
			else if (sample < -32768) sample = -32768;
			v.block[i] = sample;
			older = old;
			old = sample;
		}
		v.old = old;
		v.older = older;
		v.blockPos = 0;

		if ((flags & 0x4) !== 0) v.repeatAddr = base;      // loop start
		if ((flags & 0x1) !== 0) {                          // loop end
			v.endx = true;
			v.addr = v.repeatAddr;
			if ((flags & 0x2) === 0) {                      // no repeat: silence
				v.phase = 4;
				v.envVol = 0;
			}
		} else {
			v.addr = (base + 16) & 0x7ffff;
		}
	}

	/**
	 * @param {number} cnt - SPUCNT
	 */
	#stepNoise(cnt) {
		const shift = (cnt >> 10) & 0xf;
		this.noiseTimer -= 4 + ((cnt >> 8) & 3);
		if (this.noiseTimer <= 0) {
			this.noiseTimer += 0x20000 >> shift;
			const b = ((this.noiseLevel >> 15) ^ (this.noiseLevel >> 12) ^
				(this.noiseLevel >> 11) ^ (this.noiseLevel >> 10) ^ 1) & 1;
			this.noiseLevel = ((this.noiseLevel << 1) | b) & 0xffff;
		}
	}
}

/**
 * Converts a volume register to a linear -0x8000..0x7fff value.
 * Sweep mode (bit15) is approximated by its current fixed level.
 * @param {number} reg - u16
 * @return {number}
 */
function volumeOf(reg) {
	if ((reg & 0x8000) !== 0) {
		// sweep mode: approximate with max volume
		return 0x7fff;
	}
	return ((reg << 17) >> 16); // sign-extend 15bit, scale x2
}

/**
 * Advances a voice ADSR envelope by one sample using the standard PSX
 * rate formula.
 * @param {Voice} v
 */
function stepEnvelope(v) {
	const adsr = v.adsr;
	switch (v.phase) {
	case 1: { // attack
		const rate = (adsr >> 8) & 0x7f;
		const exp = (adsr & 0x8000) !== 0;
		envAdvance(v, rate, false, exp);
		if (v.envVol >= 0x7fff) {
			v.envVol = 0x7fff;
			v.phase = 2;
		}
		return;
	}
	case 2: { // decay (always exponential decrease, 4bit rate)
		envAdvance(v, ((adsr >> 4) & 0xf) << 2, true, true);
		const sustainLevel = Math.min(0x7fff, ((adsr & 0xf) + 1) * 0x800);
		if (v.envVol <= sustainLevel) {
			v.envVol = sustainLevel;
			v.phase = 3;
		}
		return;
	}
	case 3: { // sustain
		const rate = (adsr >> 22) & 0x7f;
		const decrease = (adsr & (1 << 30)) !== 0;
		const exp = (adsr >>> 31) !== 0;
		envAdvance(v, rate, decrease, exp);
		if (v.envVol < 0) v.envVol = 0;
		else if (v.envVol > 0x7fff) v.envVol = 0x7fff;
		return;
	}
	case 4: { // release (5bit rate, always shift-scaled like a 7bit x4)
		envAdvance(v, ((adsr >> 16) & 0x1f) << 2, true, (adsr & (1 << 21)) !== 0);
		if (v.envVol <= 0) {
			v.envVol = 0;
			v.phase = 0;
		}
		return;
	}
	default:
		return;
	}
}

/**
 * Hardware envelope stepping (nocash SPU ADSR): every
 * `1 << max(0, shift-11)` samples the level moves by
 * `step << max(0, 11-shift)`. Exponential increase runs at 1/4 speed
 * above 0x6000; exponential decrease scales the step by the level.
 * Counting ticks (instead of dividing the step) is what makes slow
 * fades take seconds-to-minutes like real hardware.
 * @param {Voice} v
 * @param {number} rate - 7bit rate, bigger = slower
 * @param {boolean} decrease
 * @param {boolean} exp
 */
function envAdvance(v, rate, decrease, exp) {
	if (rate >= 0x7f) return; // slowest encoding never moves
	const shift = rate >> 2;
	let cycles = 1 << Math.max(0, shift - 11);
	let step = (decrease ? -8 + (rate & 3) : 7 - (rate & 3)) << Math.max(0, 11 - shift);
	if (exp) {
		if (!decrease && v.envVol > 0x6000) cycles <<= 2;
		if (decrease) step = (step * v.envVol) >> 15;
	}
	if (--v.envTick > 0) return;
	v.envTick = cycles;
	v.envVol += step;
}
