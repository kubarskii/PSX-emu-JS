/**
 * PSX CDROM controller (0x1f801800-0x1f801803, index-multiplexed).
 *
 * Supports the command set the BIOS and typical games use to boot and
 * stream data. Disc images: raw BIN (2352-byte sectors) or plain ISO
 * (2048-byte sectors). Audio: XA-ADPCM sectors are decoded and CDDA
 * tracks delivered as raw PCM, both mixed by the SPU (this.spu).
 */

/**
 * Response delays in CPU cycles. INIT_DELAY must stay well below ~800K:
 * the kernel's _96_init retries CdlReset if Complete (INT2) does not
 * arrive within roughly two of its ~420K-cycle wait quanta.
 */
const ACK_DELAY = 25000;
const SECOND_DELAY = 60000;
const INIT_DELAY = 250000;

/** stat bits */
const STAT_ERROR = 0x01;
const STAT_MOTOR = 0x02;
const STAT_READING = 0x20;
const STAT_SEEKING = 0x40;
const STAT_PLAYING = 0x80;

const MODE_CDDA_REPORT = 0x04;
const MODE_AUTOPAUSE = 0x02;
const MODE_WHOLE_SECTOR = 0x20;
const MODE_XA_ADPCM = 0x40;
const MODE_DOUBLE_SPEED = 0x80;

const SYSCLOCK = 33868800;

/** XA-ADPCM filter coefficients (same first four as SPU ADPCM) */
const XA_K0 = [0, 60, 115, 98];
const XA_K1 = [0, 0, -52, -55];

/** tagged delayed events (no per-schedule closures) */
const CD = {
	DISPATCH: 0,
	SECTOR: 1,
	IRQ3_STAT: 2,
	IRQ2_STAT: 3,
	IRQ5_ERR: 4,
	READN_START: 5,
	STOP_INT2: 6,
	PAUSE_INT2: 7,
	INIT_IRQ3: 8,
	INIT_INT2: 9,
	GETLOCL: 10,
	GETLOCP: 11,
	GETTN: 12,
	GETTD: 13,
	SEEK_IRQ3: 14,
	SEEK_INT2: 15,
	TEST: 16,
	GETID_INT2: 17,
	READTOC_INT2: 18,
	PLAY_START: 19,
	CDDA_TICK: 20,
};

export class CDROM {

	/**
	 * @param {{schedule: (cycles: number, fn: () => void) => void, scheduleKind: (cycles: number, target: CDROM, kind: number, gen: number) => void}} sched
	 * @param {(bit: number) => void} raiseIrq
	 */
	constructor(sched, raiseIrq) {
		this.schedule = sched.schedule;
		this.scheduleKind = sched.scheduleKind;
		this.raiseIrq = raiseIrq || (() => {});

		this.index = 0;
		this.params = [];
		this._cmdParams = [];
		this.response = [];
		this.responseHead = 0;
		this.intEnable = 0;
		this.intFlag = 0;
		/** queued irq slots waiting for flag acknowledge */
		this.pendingIrq = [];
		this.pendingSectorInt1 = 0;
		this._pendingPool = [];

		this.stat = 0;
		this.mode = 0;
		this.busy = false;
		this.gen = 0;
		this._testParam = 0;

		/** reusable response byte buffers (mutated, never reallocated per irq) */
		this._resp1 = [0];
		this._resp2 = [0, 0];
		this._resp3 = [0, 0, 0];
		this._resp4 = [0x94, 0x09, 0x19, 0xc0];
		this._resp8 = [0, 0, 0, 0, 0, 0, 0, 0];
		this._getloc8 = [0, 0, 0, 0, 0, 0, 0, 0];
		this._getidDisc = [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41];
		this._getidNoDisc = [0x08, 0x40, 0, 0, 0, 0, 0, 0];

		this.disc = null;
		this.sectorSize = 2352;
		/**
		 * Track table: absolute LBA of each track's INDEX 01 plus type.
		 * Single-track data discs get a default entry.
		 * @type {Array<{number: number, startLba: number, audio: boolean}>}
		 */
		this.tracks = [{number: 1, startLba: 0, audio: false}];
		this.leadOutLba = 0;

		this.seekLba = 0;
		this.readLba = 0;
		this.reading = false;

		/** CDDA playback position (audio itself is not synthesized) */
		this.playing = false;
		this.playLba = 0;
		this._playTicks = 0;
		this._tdTrack = 0;

		/** XA stream filter (Setfilter) */
		this.filterFile = 0;
		this.filterChannel = 0;

		/** audio sink (SPU.pushCdAudio), wired by the machine */
		this.spu = null;
		this.audioMuted = false;
		// CD output volume matrix (0x80 = 100%); games fade/pan streamed
		// music through these, latched by the "apply" bit
		this.volLL = 0x80;
		this.volLR = 0;
		this.volRR = 0x80;
		this.volRL = 0;
		this._pendLL = 0x80;
		this._pendLR = 0;
		this._pendRR = 0x80;
		this._pendRL = 0;
		this.adpcmMuted = false;
		/** XA-ADPCM decoder state: previous two samples per channel */
		this._xaPrev = new Int32Array(4); // oldL, olderL, oldR, olderR
		this._xaPcm = new Int16Array(4032 * 2);
		this._cddaPcm = new Int16Array(1176);

		this._emptyData = new Uint8Array(0);
		this.data = this._emptyData;
		this.dataPos = 0;
		this.sectorQueue = [];
		this._sectorPool = [];
		/**
		 * BFRD (request register bit7) is a sticky gate on real hardware:
		 * while set, arriving sectors flow into the data fifo on their own.
		 * Games streaming via DMA poll DRQSTS with BFRD raised in advance.
		 */
		this.wantData = false;
	}

	/**
	 * @param {ArrayBuffer} buffer - disc image (all tracks concatenated)
	 * @param {boolean} isRaw - 2352-byte sectors (BIN) vs 2048 (ISO)
	 * @param {Array<{number: number, startLba: number, audio: boolean}>} [tracks]
	 */
	insert(buffer, isRaw, tracks) {
		this.disc = new Uint8Array(buffer);
		this.sectorSize = isRaw ? 2352 : 2048;
		this.stat |= STAT_MOTOR;
		this.tracks = tracks && tracks.length > 0
			? tracks
			: [{number: 1, startLba: 0, audio: false}];
		this.leadOutLba = Math.floor(this.disc.length / this.sectorSize);
		// GetID region letter from the boot id (SLUS/SCUS -> America,
		// SLES/SCES -> Europe, SLPS/SLPM/SCPS -> Japan): the BIOS shell
		// compares it against its own region on a licensed-disc boot
		try {
			const cnf = this.findFile("SYSTEM.CNF;1");
			if (cnf !== null) {
				const text = String.fromCharCode(
					...this.userData(cnf.lba).subarray(0, Math.min(cnf.size, 2048)));
				const m = text.match(/BOOT\s*=\s*cdrom:?\\?S([LCI])(US|ES|PS|PM)/i);
				if (m) {
					const t = m[2].toUpperCase();
					this._getidDisc[7] = t === "US" ? 0x41 : t === "ES" ? 0x45 : 0x49;
				}
			}
		} catch {
			// unreadable filesystem: keep the default region
		}
	}

	/**
	 * @param {number} lba
	 * @return {{number: number, startLba: number, audio: boolean}}
	 */
	#trackAt(lba) {
		let t = this.tracks[0];
		for (let i = 1; i < this.tracks.length; i++) {
			if (this.tracks[i].startLba <= lba) t = this.tracks[i];
		}
		return t;
	}

	/**
	 * Decodes one XA-ADPCM sector into PCM and hands it to the SPU.
	 * @param {number} base - byte offset of the sector in the disc image
	 */
	#decodeXa(base) {
		const d = this.disc;
		const coding = d[base + 19];
		const stereo = (coding & 0x03) !== 0;
		const rate = (coding & 0x0c) !== 0 ? 18900 : 37800;
		const bits8 = (coding & 0x30) !== 0;
		const prev = this._xaPrev;
		const pcm = this._xaPcm;
		let n = 0; // interleaved output pairs * 2

		const unitsPerGroup = bits8 ? 4 : 8;
		for (let g = 0; g < 18; g++) {
			const gb = base + 24 + g * 128;
			for (let u = 0; u < unitsPerGroup; u++) {
				const param = bits8
					? d[gb + 4 + u]
					: d[gb + (u < 4 ? 4 + u : 8 + u)];
				let shift = param & 0x0f;
				if (shift > 12) shift = 9;
				const filter = (param >> 4) & 0x03;
				const k0 = XA_K0[filter];
				const k1 = XA_K1[filter];
				// stereo: even units are left, odd are right
				const ch = stereo ? (u & 1) * 2 : 0;
				let old = prev[ch];
				let older = prev[ch + 1];
				for (let i = 0; i < 28; i++) {
					let s;
					if (bits8) {
						s = (d[gb + 16 + i * 4 + u] << 24) >> 24;
					} else {
						const t = d[gb + 16 + i * 4 + (u >> 1)];
						s = (u & 1) !== 0 ? (t << 24) >> 28 : (t << 28) >> 28;
					}
					s = (s << 12) >> shift;
					s += ((old * k0 + older * k1 + 32) / 64) | 0;
					if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
					older = old;
					old = s;
					if (!stereo) {
						pcm[n++] = s;
						pcm[n++] = s;
					} else if (ch === 0) {
						// left lands two ahead of the matching right sample
						pcm[n + i * 2] = s;
					} else {
						pcm[n + i * 2 + 1] = s;
					}
				}
				prev[ch] = old;
				prev[ch + 1] = older;
				if (stereo && (u & 1) === 1) n += 56;
			}
		}
		if (this.adpcmMuted) return;
		this.#pushAudio(n === pcm.length ? pcm : pcm.subarray(0, n), rate);
	}

	/** @return {boolean} */
	get hasDisc() {
		return this.disc !== null;
	}

	/**
	 * @param {number} lba
	 * @return {Uint8Array} - 2048 bytes of user data
	 */
	userData(lba) {
		if (this.disc === null) return new Uint8Array(2048);
		if (this.sectorSize === 2352) {
			const from = lba * 2352 + 24;
			return this.disc.subarray(from, from + 2048);
		}
		return this.disc.subarray(lba * 2048, lba * 2048 + 2048);
	}

	/**
	 * Minimal ISO9660 lookup of a file's directory record.
	 * @param {string} path - e.g. "SLPS_123.45;1" or "DIR\\FILE;1"
	 * @return {{lba: number, size: number} | null}
	 */
	findFile(path) {
		if (this.disc === null) return null;
		const pvd = this.userData(16);
		if (String.fromCharCode(...pvd.subarray(1, 6)) !== "CD001") return null;
		let dirLba = readU32(pvd, 156 + 2);
		let dirSize = readU32(pvd, 156 + 10);

		const parts = path.toUpperCase().split(/[\\/]/).filter((p) => p !== "");
		for (let level = 0; level < parts.length; level++) {
			const want = parts[level];
			let found = null;
			for (let s = 0; s < Math.ceil(dirSize / 2048); s++) {
				const dir = this.userData(dirLba + s);
				let off = 0;
				while (off < 2048) {
					const len = dir[off];
					if (len === 0) break;
					const nameLen = dir[off + 32];
					let name = String.fromCharCode(...dir.subarray(off + 33, off + 33 + nameLen));
					if (name.indexOf(";") === -1 && want.indexOf(";") !== -1) name += ";1";
					if (name === want || name === want.replace(/;1$/, "")) {
						found = {lba: readU32(dir, off + 2), size: readU32(dir, off + 10)};
						break;
					}
					off += len;
				}
				if (found) break;
			}
			if (!found) return null;
			dirLba = found.lba;
			dirSize = found.size;
			if (level === parts.length - 1) return found;
		}
		return null;
	}

	/**
	 * Locates the boot executable (SYSTEM.CNF's BOOT line, falling back
	 * to PSX.EXE) and returns its content.
	 * @return {{name: string, data: Uint8Array} | null}
	 */
	readBootExe() {
		let bootPath = "PSX.EXE;1";
		const cnf = this.findFile("SYSTEM.CNF;1");
		if (cnf !== null) {
			const text = String.fromCharCode(...this.userData(cnf.lba).subarray(0, Math.min(cnf.size, 2048)));
			const m = text.match(/BOOT\s*=\s*cdrom:?\\?([^\s;]+(;\d+)?)/i);
			if (m) bootPath = m[1].indexOf(";") === -1 ? m[1] + ";1" : m[1];
		}
		const file = this.findFile(bootPath);
		if (file === null) return null;
		const data = new Uint8Array(file.size);
		for (let s = 0; s < Math.ceil(file.size / 2048); s++) {
			const chunk = this.userData(file.lba + s);
			data.set(chunk.subarray(0, Math.min(2048, file.size - s * 2048)), s * 2048);
		}
		return {name: bootPath, data};
	}

	/**
	 * @param {number} off - 0..3
	 * @return {number} - u8
	 */
	read8(off) {
		switch (off) {
		case 0: {
			let s = this.index & 3;
			s |= 1 << 3;                                // parameter fifo empty
			if (this.params.length < 16) s |= 1 << 4;   // parameter fifo not full
			if (this.responseHead < this.response.length) s |= 1 << 5;  // response fifo not empty
			if (this.dataPos < this.data.length) s |= 1 << 6; // data fifo not empty
			if (this.busy) s |= 1 << 7;
			return s;
		}
		case 1:
			if (this.responseHead < this.response.length) {
				return this.response[this.responseHead++];
			}
			return 0;
		case 2:
			return this.#dataByte();
		case 3:
			if ((this.index & 1) === 0) return this.intEnable | 0xe0;
			return this.intFlag | 0xe0;
		default:
			return 0;
		}
	}

	/**
	 * @param {number} off - 0..3
	 * @param {number} v - u8
	 */
	write8(off, v) {
		v &= 0xff;
		if (off === 0) {
			this.index = v & 3;
			return;
		}
		const port = (this.index << 2) | off;
		switch (port) {
		case 0x01: this.#command(v); return;             // idx0.1801: command
		case 0x02: this.params.push(v); return;          // idx0.1802: parameter
		case 0x03:                                       // idx0.1803: request
			if ((v & 0x80) !== 0) {
				this.wantData = true;
				// BFRD gates the fifo: load the next sector only once the
				// current one is drained. Loading unconditionally skips a
				// sector whenever the drive is ahead of the guest (the
				// arrival auto-load already staged this interrupt's data).
				if (this.dataPos >= this.data.length) this.#loadSector();
			} else {
				this.wantData = false;
				const prev = this.data;
				if (prev !== this._emptyData) {
					// hardware keeps the sector in its buffer across a BFRD
					// clear: an untouched fifo (staged by the arrival auto-
					// load, not yet read) must survive for the BFRD=1 that
					// follows, or the guest reads zeros instead of a sector
					if (this.dataPos === 0) this.sectorQueue.unshift(prev);
					else this._sectorPool.push(prev);
				}
				this.data = this._emptyData;
				this.dataPos = 0;
			}
			return;
		case 0x06: this.intEnable = v & 0x1f; return;    // idx1.1802
		case 0x07:                                       // idx1.1803: ack
			this.intFlag &= ~(v & 0x1f);
			if ((v & 0x40) !== 0) this.params.length = 0;
			// the controller redelivers a queued response a while after
			// the acknowledge, never synchronously inside the ack write -
			// the kernel clears I_STAT right after acking and would lose
			// an instantly re-raised interrupt
			this.scheduleKind(2000, this, CD.DISPATCH, -1);
			return;
		case 0x0a: this._pendLL = v; return;             // idx2.1802: L-CD -> L-SPU
		case 0x0b: this._pendLR = v; return;             // idx2.1803: L-CD -> R-SPU
		case 0x0d: this._pendRR = v; return;             // idx3.1801: R-CD -> R-SPU
		case 0x0e: this._pendRL = v; return;             // idx3.1802: R-CD -> L-SPU
		case 0x0f:                                       // idx3.1803: apply/mute
			this.adpcmMuted = (v & 1) !== 0;
			if ((v & 0x20) !== 0) {
				this.volLL = this._pendLL;
				this.volLR = this._pendLR;
				this.volRR = this._pendRR;
				this.volRL = this._pendRL;
			}
			return;
		default:
			return;
		}
	}

	/**
	 * Routes decoded CD audio through the volume matrix into the SPU.
	 * @param {Int16Array} pcm - interleaved pairs (mutated in place)
	 * @param {number} rate
	 */
	#pushAudio(pcm, rate) {
		const ll = this.volLL, lr = this.volLR, rr = this.volRR, rl = this.volRL;
		if (ll !== 0x80 || rr !== 0x80 || lr !== 0 || rl !== 0) {
			for (let i = 0; i + 1 < pcm.length; i += 2) {
				const l = pcm[i];
				const r = pcm[i + 1];
				let L = (l * ll + r * rl) >> 7;
				let R = (r * rr + l * lr) >> 7;
				if (L > 32767) L = 32767; else if (L < -32768) L = -32768;
				if (R > 32767) R = 32767; else if (R < -32768) R = -32768;
				pcm[i] = L;
				pcm[i + 1] = R;
			}
		}
		this.spu.pushCdAudio(pcm, rate);
	}

	/** @return {number} - next word of the data fifo (for DMA3) */
	readDataWord() {
		return this.#dataByte() | (this.#dataByte() << 8) |
			(this.#dataByte() << 16) | (this.#dataByte() << 24);
	}

	/** @return {number} */
	#dataByte() {
		if (this.dataPos < this.data.length) return this.data[this.dataPos++];
		return 0;
	}

	/**
	 * Queues an interrupt with its response; delivered when the previous
	 * one has been acknowledged.
	 * @param {number} level - INT1..INT5
	 * @param {number[]} bytes - reusable response buffer
	 * @param {number} len
	 */
	#irq(level, bytes, len) {
		let slot = this._pendingPool.pop();
		if (slot === undefined) slot = {level: 0, bytes: new Uint8Array(16), len: 0};
		slot.level = level;
		slot.len = len;
		for (let i = 0; i < len; i++) slot.bytes[i] = bytes[i];
		this.pendingIrq.push(slot);
		this.#dispatchPending();
	}

	#irq3Stat() {
		this._resp1[0] = this.stat;
		this.#irq(3, this._resp1, 1);
	}

	#irq2Stat() {
		this._resp1[0] = this.stat;
		this.#irq(2, this._resp1, 1);
	}

	#dispatchPending() {
		if (this.intFlag !== 0) return;
		if (this.pendingIrq.length === 0) {
			// a sector INT1 swallowed by an in-flight command replays here,
			// after the command's response has been delivered and acked
			if (this.pendingSectorInt1 > 0 && !this.busy && this.reading) {
				this.pendingSectorInt1--;
				this._resp1[0] = this.stat;
				this.#irq(1, this._resp1, 1);
			}
			return;
		}
		const slot = this.pendingIrq.shift();
		const r = this.response;
		const len = slot.len;
		for (let i = 0; i < len; i++) r[i] = slot.bytes[i];
		r.length = len;
		this.responseHead = 0;
		this.intFlag = slot.level;
		this.busy = false;
		this._pendingPool.push(slot);
		if ((this.intEnable & slot.level) !== 0) this.raiseIrq(2);
	}

	/** @param {number} kind - CD.* */
	_onEvent(kind) {
		switch (kind) {
		case CD.DISPATCH:
			this.#dispatchPending();
			return;
		case CD.SECTOR: {
			if (!this.reading) return;
			// XA-ADPCM routing: real-time audio sectors go to the ADPCM
			// decoder, NEVER to the data fifo, and они не поднимают INT1 -
			// иначе стримящие игры захлёбываются
			if ((this.mode & MODE_XA_ADPCM) !== 0 &&
				this.sectorSize === 2352 && this.disc !== null) {
				const base = this.readLba * 2352;
				const submode = this.disc[base + 18];
				if ((submode & 0x44) === 0x44) { // real-time + audio
					const filterOk = (this.mode & 0x08) === 0 ||
						(this.disc[base + 16] === this.filterFile &&
						this.disc[base + 17] === this.filterChannel);
					if (filterOk && !this.audioMuted && this.spu !== null) {
						this.#decodeXa(base);
					}
					this.readLba++;
					this.stat = (this.stat | STAT_READING | STAT_MOTOR) & ~STAT_SEEKING;
					this.#scheduleSector();
					return;
				}
			}
			// the head ran past the last sector: report data end and stop
			// instead of streaming garbage forever
			if (this.leadOutLba > 0 && this.readLba >= this.leadOutLba) {
				this.reading = false;
				this.stat = (this.stat & ~STAT_READING) | STAT_MOTOR;
				this._resp1[0] = this.stat;
				this.#irq(4, this._resp1, 1);
				return;
			}
			this.sectorQueue.push(this.#readSectorData(this.readLba));
			if (this.sectorQueue.length > 16) {
				const old = this.sectorQueue.shift();
				if (old !== undefined) this._sectorPool.push(old);
			}
			this.readLba++;
			this.stat = (this.stat | STAT_READING | STAT_MOTOR) & ~STAT_SEEKING;
			// with BFRD raised and the fifo drained, the new sector flows in
			if (this.wantData && this.dataPos >= this.data.length) this.#loadSector();
			// while a command is in flight its response must be the next
			// delivered interrupt: the sector INT1 is deferred (not lost —
			// per-INT1-paced streamers count every sector) and re-emitted
			// once the response has been delivered and acknowledged
			if (!this.busy) {
				this._resp1[0] = this.stat;
				this.#irq(1, this._resp1, 1);
			} else if (this.pendingSectorInt1 < 16) {
				this.pendingSectorInt1++;
			}
			this.#scheduleSector();
			return;
		}
		case CD.IRQ3_STAT:
			this.#irq3Stat();
			return;
		case CD.IRQ2_STAT:
			this.#irq2Stat();
			return;
		case CD.IRQ5_ERR:
			this._resp2[0] = this.stat | STAT_ERROR;
			this._resp2[1] = 0x40;
			this.#irq(5, this._resp2, 2);
			return;
		case CD.READN_START:
			// the read itself was redirected synchronously in #command;
			// this event only delivers the acknowledge
			this.stat = (this.stat & ~(STAT_SEEKING | STAT_PLAYING)) | STAT_MOTOR | STAT_READING;
			this.#irq3Stat();
			return;
		case CD.STOP_INT2:
			this.stat &= ~(STAT_READING | STAT_MOTOR | STAT_PLAYING);
			this.#irq2Stat();
			return;
		case CD.PAUSE_INT2:
			this.stat &= ~(STAT_READING | STAT_PLAYING);
			this.#irq2Stat();
			return;
		case CD.INIT_IRQ3:
			this.stat = STAT_MOTOR;
			this.#irq3Stat();
			return;
		case CD.INIT_INT2:
			this.#irq2Stat();
			return;
		case CD.GETLOCL: {
			const b = this._getloc8;
			fillMsfBcd(this.readLba, b, 0);
			b[3] = 2; b[4] = 0; b[5] = 0; b[6] = 8; b[7] = 0;
			this.#irq(3, b, 8);
			return;
		}
		case CD.GETLOCP: {
			const pos = this.playing ? this.playLba : this.readLba;
			const track = this.#trackAt(pos);
			const b = this._getloc8;
			b[0] = toBcd(track.number);
			b[1] = 1;
			fillMsfBcd(Math.max(pos - track.startLba - 150, -150), b, 2);
			fillMsfBcd(pos, b, 5);
			this.#irq(3, b, 8);
			return;
		}
		case CD.GETTN:
			this._resp3[0] = this.stat;
			this._resp3[1] = toBcd(this.tracks[0].number);
			this._resp3[2] = toBcd(this.tracks[this.tracks.length - 1].number);
			this.#irq(3, this._resp3, 3);
			return;
		case CD.GETTD: {
			// track 0 = lead-out position; responses carry mm:ss in BCD
			let lba = this.leadOutLba;
			if (this._tdTrack !== 0) {
				const t = this.tracks.find((x) => x.number === this._tdTrack);
				if (t === undefined) {
					this._resp2[0] = this.stat | STAT_ERROR;
					this._resp2[1] = 0x10;
					this.#irq(5, this._resp2, 2);
					return;
				}
				lba = t.startLba;
			}
			const abs = lba + 150;
			this._resp3[0] = this.stat;
			this._resp3[1] = toBcd((abs / (60 * 75)) | 0);
			this._resp3[2] = toBcd(((abs / 75) | 0) % 60);
			this.#irq(3, this._resp3, 3);
			return;
		}
		case CD.PLAY_START: {
			this.stat = (this.stat | STAT_MOTOR | STAT_PLAYING) & ~(STAT_READING | STAT_SEEKING);
			this.playing = true;
			this._playTicks = 0;
			this.#irq3Stat();
			this.#scheduleCdda();
			return;
		}
		case CD.CDDA_TICK: {
			if (!this.playing) return;
			// deliver the sector under the head as raw PCM (588 pairs)
			if (this.spu !== null && !this.audioMuted && this.disc !== null &&
				this.sectorSize === 2352 && this.#trackAt(this.playLba).audio) {
				const d = this.disc;
				let o = this.playLba * 2352;
				if (o + 2352 <= d.length) {
					const pcm = this._cddaPcm;
					for (let i = 0; i < 1176; i++, o += 2) {
						pcm[i] = d[o] | (d[o + 1] << 8);
					}
					this.#pushAudio(pcm, 44100);
				}
			}
			this.playLba++;
			this._playTicks++;
			const track = this.#trackAt(this.playLba);
			const nextIdx = this.tracks.indexOf(track) + 1;
			const trackEnd = nextIdx < this.tracks.length
				? this.tracks[nextIdx].startLba
				: this.leadOutLba;
			if (this.playLba >= trackEnd) {
				if ((this.mode & MODE_AUTOPAUSE) !== 0 || this.playLba >= this.leadOutLba) {
					// end of track/disc: INT4 (data end) and pause
					this.playing = false;
					this.stat = (this.stat & ~STAT_PLAYING) | STAT_MOTOR;
					this._resp1[0] = this.stat;
					this.#irq(4, this._resp1, 1);
					return;
				}
			}
			// once a second, optionally report the position (INT1)
			if ((this.mode & MODE_CDDA_REPORT) !== 0 && this._playTicks % 75 === 0) {
				const b = this._getloc8;
				b[0] = this.stat;
				b[1] = toBcd(track.number);
				b[2] = 0x01;
				fillMsfBcd(this.playLba, b, 3);
				b[6] = 0;
				b[7] = 0;
				this.#irq(1, b, 8);
			}
			this.#scheduleCdda();
			return;
		}
		case CD.SEEK_IRQ3:
			this.stat = (this.stat | STAT_MOTOR | STAT_SEEKING) & ~(STAT_READING | STAT_PLAYING);
			this.reading = false;
			this.#irq3Stat();
			return;
		case CD.SEEK_INT2:
			this.stat &= ~STAT_SEEKING;
			this.readLba = this.seekLba;
			this.#irq2Stat();
			return;
		case CD.TEST:
			if (this._testParam === 0x20) this.#irq(3, this._resp4, 4);
			else this.#irq3Stat();
			return;
		case CD.GETID_INT2:
			if (this.hasDisc) this.#irq(2, this._getidDisc, 8);
			else this.#irq(5, this._getidNoDisc, 8);
			return;
		case CD.READTOC_INT2:
			this.#irq2Stat();
			return;
		default:
			return;
		}
	}

	/**
	 * @param {number} cmd
	 */
	#command(cmd) {
		const src = this.params;
		const p = this._cmdParams;
		const n = src.length;
		for (let i = 0; i < n; i++) p[i] = src[i];
		p.length = n;
		src.length = 0;
		this.busy = true;
		// only commands that START a drive operation replace whatever the
		// drive was doing (cancelling its scheduled second response); query
		// commands leave pending responses alone — a per-vsync GetStat
		// landing between a Seek's INT3 and INT2 must not eat the INT2, or
		// libcd's CdSync never completes and the game hangs
		switch (cmd) {
		case 0x03: case 0x06: case 0x08: case 0x09: case 0x0a:
		case 0x15: case 0x16: case 0x1a: case 0x1b: case 0x1e:
			this.pendingIrq.length = 0;
			this.pendingSectorInt1 = 0;
			this.gen++;
			break;
		default:
			break;
		}

		switch (cmd) {
		case 0x01:
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;

		case 0x02: {
			const m = bcd(p[0]), s = bcd(p[1]), f = bcd(p[2]);
			this.seekLba = (m * 60 + s) * 75 + f - 150;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;
		}

		case 0x03: { // Play: optional BCD track parameter, else Setloc target
			this.reading = false;
			if (p.length > 0 && bcd(p[0]) > 0) {
				const t = this.tracks.find((x) => x.number === bcd(p[0]));
				this.playLba = t !== undefined ? t.startLba : this.seekLba;
			} else {
				this.playLba = this.seekLba;
			}
			this.#after(ACK_DELAY, CD.PLAY_START);
			return;
		}

		case 0x04: // Forward
		case 0x05: // Backward
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;

		case 0x06:
		case 0x1b:
			// the drive redirects immediately (a command retry must not
			// leave the old stream running from the old position); only
			// the INT3 acknowledge is delayed
			this.playing = false;
			this.readLba = this.seekLba;
			if (!this.reading) {
				this.reading = true;
				this.#scheduleSector();
			}
			this.sectorQueue.length = 0;
			this.#after(ACK_DELAY, CD.READN_START);
			return;

		case 0x08:
			this.reading = false;
			this.playing = false;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			this.#after(SECOND_DELAY, CD.STOP_INT2);
			return;

		case 0x09:
			this.reading = false;
			this.playing = false;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			this.#after(SECOND_DELAY, CD.PAUSE_INT2);
			return;

		case 0x0a:
			this.reading = false;
			this.playing = false;
			this.mode = 0;
			this.sectorQueue.length = 0;
			this.#after(ACK_DELAY, CD.INIT_IRQ3);
			this.#after(INIT_DELAY, CD.INIT_INT2);
			return;

		case 0x0b: // Mute
		case 0x0c: // Demute
			this.audioMuted = cmd === 0x0b;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;

		case 0x0d: // Setfilter(file, channel)
			this.filterFile = p[0] & 0xff;
			this.filterChannel = p[1] & 0xff;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;

		case 0x0e:
			this.mode = p[0] & 0xff;
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			return;

		case 0x10:
			this.#after(ACK_DELAY, CD.GETLOCL);
			return;

		case 0x11:
			this.#after(ACK_DELAY, CD.GETLOCP);
			return;

		case 0x13:
			this.#after(ACK_DELAY, CD.GETTN);
			return;

		case 0x14:
			this._tdTrack = p.length > 0 ? bcd(p[0]) : 0;
			this.#after(ACK_DELAY, CD.GETTD);
			return;

		case 0x15:
		case 0x16:
			this.#after(ACK_DELAY, CD.SEEK_IRQ3);
			this.#after(SECOND_DELAY * 2, CD.SEEK_INT2);
			return;

		case 0x19:
			this._testParam = p[0] & 0xff;
			this.#after(ACK_DELAY, CD.TEST);
			return;

		case 0x1a:
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			this.#after(SECOND_DELAY, CD.GETID_INT2);
			return;

		case 0x1e:
			this.#after(ACK_DELAY, CD.IRQ3_STAT);
			this.#after(INIT_DELAY, CD.READTOC_INT2);
			return;

		default:
			this.#after(ACK_DELAY, CD.IRQ5_ERR);
			return;
		}
	}

	#scheduleSector() {
		const perSecond = (this.mode & MODE_DOUBLE_SPEED) !== 0 ? 150 : 75;
		this.scheduleKind((SYSCLOCK / perSecond) | 0, this, CD.SECTOR, -1);
	}

	/** CDDA position advances at 1x regardless of the mode speed bit */
	#scheduleCdda() {
		this.scheduleKind((SYSCLOCK / 75) | 0, this, CD.CDDA_TICK, -1);
	}

	/** moves the oldest delivered sector into the visible data fifo */
	#loadSector() {
		const next = this.sectorQueue.shift();
		if (next !== undefined) {
			const prev = this.data;
			if (prev !== this._emptyData) this._sectorPool.push(prev);
			this.data = next;
			this.dataPos = 0;
		}
	}

	/**
	 * @param {number} lba
	 * @return {Uint8Array}
	 */
	#readSectorData(lba) {
		const wholeSector = (this.mode & MODE_WHOLE_SECTOR) !== 0;
		const outLen = wholeSector ? 2340 : 2048;
		const pool = this._sectorPool;
		let out = pool.length > 0 ? pool.pop() : null;
		if (out === null || out.length !== outLen) out = new Uint8Array(outLen);
		else out.fill(0);
		if (this.disc === null || lba < 0) return out;

		if (this.sectorSize === 2352) {
			const base = lba * 2352;
			// data starts after 12-byte sync; user data of mode2/form1 at +24
			const from = base + (wholeSector ? 12 : 24);
			if (from + outLen <= this.disc.length) {
				out.set(this.disc.subarray(from, from + outLen));
			}
		} else {
			const base = lba * 2048;
			if (wholeSector) {
				// synthesize a header around ISO user data
				const msf = toMsf(lba);
				out[0] = toBcd(msf[0]); out[1] = toBcd(msf[1]); out[2] = toBcd(msf[2]);
				out[3] = 2;
				if (base + 2048 <= this.disc.length) {
					out.set(this.disc.subarray(base, base + 2048), 12);
				}
			} else if (base + 2048 <= this.disc.length) {
				out.set(this.disc.subarray(base, base + 2048));
			}
		}
		return out;
	}

	/**
	 * Schedules a response for the CURRENT command; cancelled when gen changes.
	 * @param {number} cycles
	 * @param {number} kind - CD.*
	 */
	#after(cycles, kind) {
		this.scheduleKind(cycles, this, kind, this.gen);
	}
}

/**
 * @param {Uint8Array} b
 * @param {number} off
 * @return {number} - little-endian u32
 */
function readU32(b, off) {
	return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/**
 * @param {number} v - BCD byte
 * @return {number}
 */
function bcd(v) {
	return ((v >> 4) & 0xf) * 10 + (v & 0xf);
}

/**
 * @param {number} v
 * @return {number} - BCD byte
 */
function toBcd(v) {
	return (((v / 10) | 0) << 4) | (v % 10);
}

/**
 * @param {number} lba
 * @param {number[]} out
 * @param {number} off
 */
function fillMsfBcd(lba, out, off) {
	const abs = lba + 150;
	out[off] = toBcd((abs / (60 * 75)) | 0);
	out[off + 1] = toBcd(((abs / 75) | 0) % 60);
	out[off + 2] = toBcd(abs % 75);
}

/**
 * @param {number} lba
 * @return {number[]} - [m, s, f] (binary, not BCD)
 */
function toMsf(lba) {
	const abs = lba + 150;
	return [(abs / (60 * 75)) | 0, ((abs / 75) | 0) % 60, abs % 75];
}
