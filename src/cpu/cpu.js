/**
 * MIPS R3000A interpreter core.
 *
 * Design notes (performance):
 *  - no object is ever allocated per instruction: decode is inline bit math,
 *    dispatch is a switch (compiled to a jump table by V8);
 *  - registers live in an Int32Array, values are kept as signed 32bit
 *    integers internally, converted with >>> 0 only where unsigned
 *    semantics are required;
 *  - load delay slots are modelled with a single pending (reg, value) pair
 *    instead of copying the whole register file every step.
 */

import {GTE} from "./gte";

export const RESET_VECTOR = 0xbfc00000;

/** Exception codes (CAUSE bits [6:2]) */
export const EXC = {
	INTERRUPT: 0x0,
	ADDR_LOAD: 0x4,
	ADDR_STORE: 0x5,
	SYSCALL: 0x8,
	BREAK: 0x9,
	ILLEGAL: 0xa,
	COP_UNUSABLE: 0xb,
	OVERFLOW: 0xc,
};

/**
 * Average cycles per instruction. The real R3000A spends extra cycles on
 * memory access and cache misses (~1.5-2 CPI in practice); counting 1
 * would make guest software-calibrated delay loops and timeouts run twice
 * as fast relative to vblank/timer time.
 */
export const CPI = 2;

/** SR bit: cache isolated (stores must not reach memory) */
const SR_ISC = 0x10000;
/** SR bit: boot exception vectors in ROM */
const SR_BEV = 1 << 22;

export class CPU {

	/**
	 * @param {import("../memory").Memory} mem
	 */
	constructor(mem) {
		this.mem = mem;

		/** @type {Int32Array} general purpose registers, [0] is hardwired to 0 */
		this.regs = new Int32Array(32);

		this.pc = RESET_VECTOR;
		this.nextPc = (RESET_VECTOR + 4) >>> 0;
		/** address of the instruction being executed (for exceptions/logs) */
		this.currentPc = 0;

		/** multiply/divide result registers (signed 32bit) */
		this.hi = 0;
		this.lo = 0;

		/** COP0 */
		this.sr = 0;
		this.cause = 0;
		this.epc = 0;
		this.badVaddr = 0;
		/** breakpoint/misc COP0 regs (BPC, BDA, DCIC...) - stored, unused */
		this.cop0r = new Int32Array(16);

		/** GTE (COP2) geometry coprocessor */
		this.gte = new GTE();

		/** pending delayed load: register index (0 = none) and value */
		this.loadReg = 0;
		this.loadVal = 0;
		/** pending load captured for the currently executing instruction */
		this.dReg = 0;
		this.dVal = 0;
		/** register written by the currently executing instruction */
		this.writtenReg = 0;

		/** true while the *next* instruction is a branch delay slot */
		this.branching = false;
		/** true while the *current* instruction is in a delay slot */
		this.inDelaySlot = false;

		/** executed instruction counter (1 instruction ~ 1 cycle) */
		this.cycles = 0;

		/** TTY output hook: BIOS putchar calls end up here */
		this.onTty = null;
		/** one-shot hook fired when the BIOS reaches the shell entry */
		this.onShell = null;
	}

	/**
	 * @param {number} r - register index 0-31
	 * @param {number} v
	 */
	setReg(r, v) {
		this.regs[r] = v;
		this.regs[0] = 0;
		this.writtenReg = r;
	}

	/**
	 * Schedules a delayed load: the value becomes visible to the second
	 * instruction after the load, and a direct write to the same register
	 * from the very next instruction wins over it.
	 * @param {number} r
	 * @param {number} v
	 */
	setLoad(r, v) {
		this.loadReg = r;
		this.loadVal = v;
	}

	/**
	 * True when an enabled hardware/software interrupt is pending.
	 * @return {boolean}
	 */
	irqPending() {
		let cause = this.cause & ~0x400;
		if (this.mem.irqLine) cause |= 0x400;
		this.cause = cause;
		return (this.sr & 1) !== 0 && (this.sr & cause & 0xff00) !== 0;
	}

	/**
	 * Enters an exception handler.
	 * @param {number} code - EXC.* code
	 * @param {number} epc - address of the faulting instruction
	 * @param {boolean} inDelaySlot - sets the BD bit and rewinds EPC
	 */
	exceptionAt(code, epc, inDelaySlot) {
		const handler = (this.sr & SR_BEV) !== 0 ? 0xbfc00180 : 0x80000080;
		// push the (interrupt enable, user mode) pair onto the SR mode "stack"
		const mode = this.sr & 0x3f;
		this.sr = (this.sr & ~0x3f) | ((mode << 2) & 0x3f);
		this.cause = (this.cause & ~0x7c) | (code << 2);
		if (inDelaySlot) {
			this.epc = (epc - 4) >>> 0;
			this.cause = (this.cause | 0x80000000) | 0;
		} else {
			this.epc = epc >>> 0;
			this.cause = this.cause & 0x7fffffff;
		}
		this.pc = handler;
		this.nextPc = (handler + 4) >>> 0;
		this.branching = false;
	}

	/**
	 * @param {number} code - EXC.* code
	 */
	exception(code) {
		this.exceptionAt(code, this.currentPc, this.inDelaySlot);
	}

	/**
	 * BIOS TTY hook: intercepts putchar kernel calls (A(3Ch) / B(3Dh))
	 * so boot messages are visible without an emulated UART.
	 */
	checkTty() {
		if (this.onTty === null) return;
		const p = this.pc & 0x1fffffff;
		if (p !== 0xa0 && p !== 0xb0) return;
		const fn = this.regs[9] & 0xff;
		if ((p === 0xa0 && fn === 0x3c) || (p === 0xb0 && fn === 0x3d)) {
			this.onTty(String.fromCharCode(this.regs[4] & 0xff));
		}
	}

	/**
	 * Executes a single instruction (fetch, decode, execute, retire
	 * pending delayed load).
	 */
	step() {
		if (this.irqPending() && !this.branching) {
			this.exceptionAt(EXC.INTERRUPT, this.pc, false);
		}

		this.checkTty();

		const pc = this.pc;
		this.currentPc = pc;
		if ((pc & 3) !== 0) {
			this.badVaddr = pc;
			this.inDelaySlot = this.branching;
			this.branching = false;
			this.exception(EXC.ADDR_LOAD);
			return;
		}

		const instr = this.mem.read32(pc) | 0;
		this.pc = this.nextPc;
		this.nextPc = (this.pc + 4) >>> 0;

		this.inDelaySlot = this.branching;
		this.branching = false;

		this.dReg = this.loadReg;
		this.dVal = this.loadVal;
		this.loadReg = 0;
		this.writtenReg = 0;

		this.executeInstr(instr);

		if (this.dReg !== 0 && this.dReg !== this.writtenReg) {
			this.regs[this.dReg] = this.dVal;
		}
		this.cycles += CPI;
	}

	/**
	 * @param {number} i - raw instruction word (signed 32bit)
	 */
	executeInstr(i) {
		const op = i >>> 26;
		const rs = (i >>> 21) & 0x1f;
		const rt = (i >>> 16) & 0x1f;
		const imm = (i << 16) >> 16;      // sign-extended immediate
		const uimm = i & 0xffff;          // zero-extended immediate
		const r = this.regs;

		switch (op) {
		case 0x00: this.executeSpecial(i); return;

		case 0x01: { // BcondZ: BLTZ / BGEZ / BLTZAL / BGEZAL
			this.branching = true;
			const v = r[rs];
			const cond = (rt & 1) !== 0 ? v >= 0 : v < 0;
			if ((rt & 0x1e) === 0x10) this.setReg(31, this.nextPc | 0);
			if (cond) this.nextPc = (this.pc + (imm << 2)) >>> 0;
			return;
		}

		case 0x02: // J
			this.branching = true;
			this.nextPc = ((this.pc & 0xf0000000) | ((i & 0x3ffffff) << 2)) >>> 0;
			return;

		case 0x03: { // JAL
			this.branching = true;
			const ra = this.nextPc | 0;
			this.nextPc = ((this.pc & 0xf0000000) | ((i & 0x3ffffff) << 2)) >>> 0;
			this.setReg(31, ra);
			return;
		}

		case 0x04: // BEQ
			this.branching = true;
			if (r[rs] === r[rt]) this.nextPc = (this.pc + (imm << 2)) >>> 0;
			return;

		case 0x05: // BNE
			this.branching = true;
			if (r[rs] !== r[rt]) this.nextPc = (this.pc + (imm << 2)) >>> 0;
			return;

		case 0x06: // BLEZ
			this.branching = true;
			if (r[rs] <= 0) this.nextPc = (this.pc + (imm << 2)) >>> 0;
			return;

		case 0x07: // BGTZ
			this.branching = true;
			if (r[rs] > 0) this.nextPc = (this.pc + (imm << 2)) >>> 0;
			return;

		case 0x08: { // ADDI (with overflow trap)
			const a = r[rs];
			const res = (a + imm) | 0;
			if ((~(a ^ imm) & (a ^ res)) < 0) {
				this.exception(EXC.OVERFLOW);
				return;
			}
			this.setReg(rt, res);
			return;
		}

		case 0x09: // ADDIU
			this.setReg(rt, (r[rs] + imm) | 0);
			return;

		case 0x0a: // SLTI
			this.setReg(rt, r[rs] < imm ? 1 : 0);
			return;

		case 0x0b: // SLTIU (immediate is sign-extended, compare is unsigned)
			this.setReg(rt, (r[rs] >>> 0) < (imm >>> 0) ? 1 : 0);
			return;

		case 0x0c: // ANDI (immediate is zero-extended)
			this.setReg(rt, r[rs] & uimm);
			return;

		case 0x0d: // ORI
			this.setReg(rt, r[rs] | uimm);
			return;

		case 0x0e: // XORI
			this.setReg(rt, r[rs] ^ uimm);
			return;

		case 0x0f: // LUI
			this.setReg(rt, (uimm << 16) | 0);
			return;

		case 0x10: this.executeCop0(i); return;

		case 0x11: // COP1 does not exist on PSX
		case 0x13: // COP3 does not exist on PSX
			this.exception(EXC.COP_UNUSABLE);
			return;

		case 0x12: this.executeCop2(i); return;

		case 0x20: { // LB
			const addr = (r[rs] + imm) | 0;
			this.setLoad(rt, (this.mem.read8(addr) << 24) >> 24);
			return;
		}

		case 0x21: { // LH
			const addr = (r[rs] + imm) | 0;
			if ((addr & 1) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_LOAD);
				return;
			}
			this.setLoad(rt, (this.mem.read16(addr) << 16) >> 16);
			return;
		}

		case 0x22: { // LWL
			const addr = (r[rs] + imm) | 0;
			const word = this.mem.read32(addr & ~3);
			const cur = this.dReg === rt ? this.dVal : r[rt];
			const shift = (addr & 3) << 3;
			this.setLoad(rt, ((cur & (0x00ffffff >>> shift)) | (word << (24 - shift))) | 0);
			return;
		}

		case 0x23: { // LW
			const addr = (r[rs] + imm) | 0;
			if ((addr & 3) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_LOAD);
				return;
			}
			this.setLoad(rt, this.mem.read32(addr) | 0);
			return;
		}

		case 0x24: { // LBU
			const addr = (r[rs] + imm) | 0;
			this.setLoad(rt, this.mem.read8(addr) & 0xff);
			return;
		}

		case 0x25: { // LHU
			const addr = (r[rs] + imm) | 0;
			if ((addr & 1) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_LOAD);
				return;
			}
			this.setLoad(rt, this.mem.read16(addr) & 0xffff);
			return;
		}

		case 0x26: { // LWR
			const addr = (r[rs] + imm) | 0;
			const word = this.mem.read32(addr & ~3);
			const cur = this.dReg === rt ? this.dVal : r[rt];
			const shift = (addr & 3) << 3;
			this.setLoad(rt, ((cur & ~(-1 >>> shift)) | (word >>> shift)) | 0);
			return;
		}

		case 0x28: { // SB
			if ((this.sr & SR_ISC) !== 0) return;
			const addr = (r[rs] + imm) | 0;
			this.mem.write8(addr, r[rt] & 0xff);
			return;
		}

		case 0x29: { // SH
			if ((this.sr & SR_ISC) !== 0) return;
			const addr = (r[rs] + imm) | 0;
			if ((addr & 1) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_STORE);
				return;
			}
			this.mem.write16(addr, r[rt] & 0xffff);
			return;
		}

		case 0x2a: { // SWL
			if ((this.sr & SR_ISC) !== 0) return;
			const addr = (r[rs] + imm) | 0;
			const aligned = addr & ~3;
			const word = this.mem.read32(aligned);
			const shift = (addr & 3) << 3;
			const merged = ((word & (0xffffff00 << shift)) | ((r[rt] >>> 0) >>> (24 - shift))) | 0;
			this.mem.write32(aligned, merged);
			return;
		}

		case 0x2b: { // SW
			if ((this.sr & SR_ISC) !== 0) return;
			const addr = (r[rs] + imm) | 0;
			if ((addr & 3) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_STORE);
				return;
			}
			this.mem.write32(addr, r[rt]);
			return;
		}

		case 0x2e: { // SWR
			if ((this.sr & SR_ISC) !== 0) return;
			const addr = (r[rs] + imm) | 0;
			const aligned = addr & ~3;
			const word = this.mem.read32(aligned);
			const shift = (addr & 3) << 3;
			const merged = ((word & ~(-1 << shift)) | (r[rt] << shift)) | 0;
			this.mem.write32(aligned, merged);
			return;
		}

		case 0x30: // LWC0
		case 0x31: // LWC1
		case 0x33: // LWC3
		case 0x38: // SWC0
		case 0x39: // SWC1
		case 0x3b: // SWC3
			this.exception(EXC.COP_UNUSABLE);
			return;

		case 0x32: { // LWC2: load into GTE data register
			const addr = (r[rs] + imm) | 0;
			if ((addr & 3) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_LOAD);
				return;
			}
			this.gte.setData(rt, this.mem.read32(addr) | 0);
			return;
		}

		case 0x3a: { // SWC2: store from GTE data register
			const addr = (r[rs] + imm) | 0;
			if ((addr & 3) !== 0) {
				this.badVaddr = addr >>> 0;
				this.exception(EXC.ADDR_STORE);
				return;
			}
			this.mem.write32(addr, this.gte.getData(rt));
			return;
		}

		default:
			this.exception(EXC.ILLEGAL);
			return;
		}
	}

	/**
	 * SPECIAL (opcode 0) instructions.
	 * @param {number} i - raw instruction word
	 */
	executeSpecial(i) {
		const rs = (i >>> 21) & 0x1f;
		const rt = (i >>> 16) & 0x1f;
		const rd = (i >>> 11) & 0x1f;
		const shamt = (i >>> 6) & 0x1f;
		const r = this.regs;

		switch (i & 0x3f) {
		case 0x00: this.setReg(rd, r[rt] << shamt); return;               // SLL
		case 0x02: this.setReg(rd, (r[rt] >>> shamt) | 0); return;        // SRL
		case 0x03: this.setReg(rd, r[rt] >> shamt); return;               // SRA
		case 0x04: this.setReg(rd, r[rt] << (r[rs] & 0x1f)); return;      // SLLV
		case 0x06: this.setReg(rd, (r[rt] >>> (r[rs] & 0x1f)) | 0); return; // SRLV
		case 0x07: this.setReg(rd, r[rt] >> (r[rs] & 0x1f)); return;      // SRAV

		case 0x08: // JR
			this.branching = true;
			this.nextPc = r[rs] >>> 0;
			return;

		case 0x09: { // JALR
			this.branching = true;
			const ra = this.nextPc | 0;
			this.nextPc = r[rs] >>> 0;
			this.setReg(rd, ra);
			return;
		}

		case 0x0c: this.exception(EXC.SYSCALL); return;
		case 0x0d: this.exception(EXC.BREAK); return;

		case 0x10: this.setReg(rd, this.hi); return;                      // MFHI
		case 0x11: this.hi = r[rs]; return;                               // MTHI
		case 0x12: this.setReg(rd, this.lo); return;                      // MFLO
		case 0x13: this.lo = r[rs]; return;                               // MTLO

		case 0x18: this.mult64(r[rs], r[rt], true); return;               // MULT
		case 0x19: this.mult64(r[rs] >>> 0, r[rt] >>> 0, false); return;  // MULTU

		case 0x1a: { // DIV
			const n = r[rs];
			const d = r[rt];
			if (d === 0) {
				this.hi = n;
				this.lo = n >= 0 ? -1 : 1;
			} else if (n === -0x80000000 && d === -1) {
				this.hi = 0;
				this.lo = -0x80000000;
			} else {
				this.lo = (n / d) | 0;
				this.hi = (n % d) | 0;
			}
			return;
		}

		case 0x1b: { // DIVU
			const n = r[rs] >>> 0;
			const d = r[rt] >>> 0;
			if (d === 0) {
				this.hi = n | 0;
				this.lo = -1;
			} else {
				this.lo = (n / d) >>> 0 | 0;
				this.hi = (n % d) | 0;
			}
			return;
		}

		case 0x20: { // ADD (with overflow trap)
			const a = r[rs];
			const b = r[rt];
			const res = (a + b) | 0;
			if ((~(a ^ b) & (a ^ res)) < 0) {
				this.exception(EXC.OVERFLOW);
				return;
			}
			this.setReg(rd, res);
			return;
		}

		case 0x21: this.setReg(rd, (r[rs] + r[rt]) | 0); return;          // ADDU

		case 0x22: { // SUB (with overflow trap)
			const a = r[rs];
			const b = r[rt];
			const res = (a - b) | 0;
			if (((a ^ b) & (a ^ res)) < 0) {
				this.exception(EXC.OVERFLOW);
				return;
			}
			this.setReg(rd, res);
			return;
		}

		case 0x23: this.setReg(rd, (r[rs] - r[rt]) | 0); return;          // SUBU
		case 0x24: this.setReg(rd, r[rs] & r[rt]); return;                // AND
		case 0x25: this.setReg(rd, r[rs] | r[rt]); return;                // OR
		case 0x26: this.setReg(rd, r[rs] ^ r[rt]); return;                // XOR
		case 0x27: this.setReg(rd, ~(r[rs] | r[rt])); return;             // NOR
		case 0x2a: this.setReg(rd, r[rs] < r[rt] ? 1 : 0); return;        // SLT
		case 0x2b: this.setReg(rd, (r[rs] >>> 0) < (r[rt] >>> 0) ? 1 : 0); return; // SLTU

		default:
			this.exception(EXC.ILLEGAL);
			return;
		}
	}

	/**
	 * 32x32 -> 64bit multiply into hi:lo without BigInt: exact 16bit-limb
	 * arithmetic, every intermediate stays below 2^32.
	 * @param {number} a
	 * @param {number} b
	 * @param {boolean} signed
	 */
	mult64(a, b, signed) {
		let neg = false;
		let ua = a;
		let ub = b;
		if (signed) {
			neg = (a < 0) !== (b < 0);
			ua = a < 0 ? (-a) >>> 0 : a >>> 0;
			ub = b < 0 ? (-b) >>> 0 : b >>> 0;
		}
		const aL = ua & 0xffff, aH = ua >>> 16;
		const bL = ub & 0xffff, bH = ub >>> 16;

		let t = aL * bL;
		const w0 = t & 0xffff;
		t = aH * bL + (t >>> 16);
		let w1 = t & 0xffff;
		const w2 = t >>> 16;
		t = aL * bH + w1;
		w1 = t & 0xffff;
		let hi = (aH * bH + w2 + (t >>> 16)) | 0;
		let lo = ((w1 << 16) | w0) | 0;

		if (neg && !(hi === 0 && lo === 0)) {
			lo = (~lo + 1) | 0;
			hi = ~hi | 0;
			if (lo === 0) hi = (hi + 1) | 0;
		}
		this.hi = hi;
		this.lo = lo;
	}

	/**
	 * COP0 (system control coprocessor) instructions.
	 * @param {number} i - raw instruction word
	 */
	executeCop0(i) {
		const sub = (i >>> 21) & 0x1f;
		const rt = (i >>> 16) & 0x1f;
		const rd = (i >>> 11) & 0x1f;

		if (sub === 0x00) { // MFC0 (has a load delay, like memory loads)
			let v = 0;
			switch (rd) {
			case 8: v = this.badVaddr | 0; break;
			case 12: v = this.sr | 0; break;
			case 13: v = this.cause | 0; break;
			case 14: v = this.epc | 0; break;
			case 15: v = 0x00000002; break; // PRID
			default: v = this.cop0r[rd & 0xf] | 0;
			}
			this.setLoad(rt, v);
			return;
		}

		if (sub === 0x04) { // MTC0
			const v = this.regs[rt];
			switch (rd) {
			case 12: this.sr = v | 0; break;
			case 13: this.cause = (this.cause & ~0x300) | (v & 0x300); break; // SW irq bits
			case 14: this.epc = v >>> 0; break;
			default: this.cop0r[rd & 0xf] = v;
			}
			return;
		}

		if (sub >= 0x10 && (i & 0x3f) === 0x10) { // RFE
			this.sr = (this.sr & ~0xf) | ((this.sr >> 2) & 0xf);
			return;
		}

		this.exception(EXC.ILLEGAL);
	}

	/**
	 * COP2 (GTE) instructions.
	 * @param {number} i - raw instruction word
	 */
	executeCop2(i) {
		if ((i & (1 << 25)) !== 0) { // GTE command
			this.gte.execute(i & 0x1ffffff);
			return;
		}

		const sub = (i >>> 21) & 0x1f;
		const rt = (i >>> 16) & 0x1f;
		const rd = (i >>> 11) & 0x1f;

		switch (sub) {
		case 0x00: this.setLoad(rt, this.gte.getData(rd)); return; // MFC2
		case 0x02: this.setLoad(rt, this.gte.getCtrl(rd)); return; // CFC2
		case 0x04: this.gte.setData(rd, this.regs[rt]); return;    // MTC2
		case 0x06: this.gte.setCtrl(rd, this.regs[rt]); return;    // CTC2
		default: this.exception(EXC.ILLEGAL);
		}
	}
}
