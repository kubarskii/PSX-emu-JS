/**
 * Basic-block compiler ("dynarec light").
 *
 * Guest programs consist of the same blocks of instructions executed over
 * and over, so instead of fetch/decode/execute per instruction we translate
 * a whole basic block (everything up to and including the next branch and
 * its delay slot) into a single JavaScript function once, cache it by
 * physical PC and let V8 JIT-compile the hot ones to machine code.
 *
 * Correctness notes:
 *  - load/branch delay slots are resolved statically at compile time where
 *    possible (register numbers are literals), the only dynamic part is the
 *    pending load carried in from the previous block;
 *  - every compiled function returns the number of executed instructions
 *    and leaves cpu.pc/nextPc/pending-load state consistent, so the
 *    interpreter and compiled blocks can be mixed freely;
 *  - writes to RAM pages containing compiled code invalidate the affected
 *    blocks (self-modifying code, kernel/exe loading). A block that
 *    invalidates itself finishes its current run with the old code, which
 *    matches real-hardware instruction cache behaviour closely enough.
 */

import {Memory, PAGE_SHIFT} from "../memory";
import {CPI, EXC} from "./cpu";

/** Maximum instructions scanned per block (delay slot may add one more). */
const MAX_BLOCK = 128;

const RAM_MASK = 0x1fffff;

export class BlockCache {

	/**
	 * @param {import("./cpu").CPU} cpu
	 * @param {Memory} mem
	 */
	constructor(cpu, mem) {
		this.cpu = cpu;
		this.mem = mem;
		/** @type {Map<number, {fn: Function, pages: number[]} | null>} */
		this.blocks = new Map();
		/** @type {Map<number, Set<number>>} page -> block keys */
		this.byPage = new Map();
		mem.onCodeWrite = (page) => this.invalidatePage(page);
	}

	/**
	 * Runs at least `budget` instructions through cached blocks,
	 * falling back to the interpreter for odd cases.
	 *
	 * Blocks are keyed by the full virtual PC (not the physical address):
	 * compiled code embeds segment-specific address literals (branch
	 * targets, return addresses), so KUSEG/KSEG0/KSEG1 mirrors of the same
	 * physical code each get their own block.
	 * @param {number} budget - instructions to execute
	 * @return {number} - instructions actually executed
	 */
	run(budget) {
		const c = this.cpu;
		let executed = 0;
		while (executed < budget) {
			if (c.branching) {
				// previous interpreter step was a branch: let the
				// interpreter finish the delay slot, a block would
				// clobber the already computed nextPc
				c.step();
				executed++;
				continue;
			}
			if (c.irqPending()) {
				c.exceptionAt(EXC.INTERRUPT, c.pc, false);
			}
			if (c.onTty !== null) c.checkTty();
			if (c.onShell !== null && (c.pc >>> 0) === 0x80030000) {
				const hook = c.onShell;
				c.onShell = null;
				hook();
			}
			const pc = c.pc;
			if ((pc & 3) !== 0) {
				c.step(); // interpreter raises the address error
				executed++;
				continue;
			}
			const key = pc >>> 0;
			let block = this.blocks.get(key);
			if (block === undefined) {
				block = this.compile(pc);
				this.blocks.set(key, block);
				this.registerBlock(key, block);
			}
			if (block === null) {
				c.step();
				executed += CPI;
				continue;
			}
			const n = block.fn(c, this.mem, c.regs) * CPI;
			c.cycles += n;
			executed += n;
		}
		return executed;
	}

	/**
	 * Registers a block in the RAM page index so writes can invalidate it.
	 * BIOS is ROM: blocks fetched from it never register.
	 * @param {number} key - virtual start address (block cache key)
	 * @param {{lastOff: number} | null} block
	 */
	registerBlock(key, block) {
		const phys = Memory.toPhysical(key);
		if (phys >= 0x00800000) return;
		const first = (phys & RAM_MASK) >>> PAGE_SHIFT;
		const last = block === null ? first : block.lastOff >>> PAGE_SHIFT;
		for (let page = first; page <= last; page++) {
			this.mem.codePages[page] = 1;
			let set = this.byPage.get(page);
			if (set === undefined) {
				set = new Set();
				this.byPage.set(page, set);
			}
			set.add(key);
		}
	}

	/**
	 * Drops every compiled block overlapping the given RAM page.
	 * @param {number} page
	 */
	invalidatePage(page) {
		const set = this.byPage.get(page);
		if (set !== undefined) {
			for (const key of set) this.blocks.delete(key);
			set.clear();
		}
		this.mem.codePages[page] = 0;
	}

	/** Drops everything (e.g. when a new executable is loaded). */
	invalidateAll() {
		this.blocks.clear();
		this.byPage.clear();
		this.mem.codePages.fill(0);
	}

	/**
	 * Translates the basic block starting at `pc` into a JS function.
	 * @param {number} pc - virtual start address
	 * @return {{fn: Function, lastOff: number} | null} - null: interpret
	 */
	compile(pc) {
		const mem = this.mem;
		const start = pc >>> 0;
		const src = [];
		/**
		 * Pending-load state threaded through emission:
		 * {t: "dyn"} - unknown, carried in from the previous block
		 * {t: "st", reg, v} - static: created by a load inside this block
		 * null - none
		 */
		let pend = {t: "dyn"};
		src.push("var lr = c.loadReg | 0; var lv = c.loadVal | 0; c.loadReg = 0;");

		let k = 0;
		let ended = false;

		while (!ended && k <= MAX_BLOCK) {
			const at = (start + k * 4) >>> 0;
			const word = mem.read32(at) | 0;
			const g = genOp(word, at, k, false, pend);

			if (g === null) {
				// uncompilable at the very start: let the interpreter run it
				if (k === 0) return null;
				// otherwise cut the block right before it
				src.push(exitTo(at));
				src.push(carryOut(pend));
				src.push(`return ${k};`);
				ended = true;
				break;
			}

			if (g.branch) {
				const delayAt = (start + (k + 1) * 4) >>> 0;
				const delayWord = mem.read32(delayAt) | 0;
				const gd = genOp(delayWord, delayAt, k + 1, true, g.pend);
				if (gd === null || gd.branch || gd.ends) {
					// branch in delay slot / uncompilable delay slot:
					// too exotic for the compiler, cut before the branch
					if (k === 0) return null;
					src.push(exitTo(at));
					src.push(carryOut(pend));
					src.push(`return ${k};`);
					ended = true;
					break;
				}
				src.push(g.code);
				src.push(gd.code);
				src.push(carryOut(gd.pend));
				const ft = (start + (k + 2) * 4) >>> 0;
				if (g.cond === null) {
					src.push(`c.pc = ${g.target} >>> 0; c.nextPc = (${g.target} + 4) >>> 0;`);
				} else {
					src.push(`if (${g.cond}) { c.pc = ${g.target} >>> 0; c.nextPc = (${g.target} + 4) >>> 0; }`);
					src.push(`else { c.pc = ${hex(ft)}; c.nextPc = ${hex((ft + 4) >>> 0)}; }`);
				}
				src.push(`return ${k + 2};`);
				k += 2;
				ended = true;
				break;
			}

			src.push(g.code);
			pend = g.pend;

			if (g.ends) {
				// SYSCALL/BREAK: exceptionAt already set pc/nextPc
				src.push(`return ${k + 1};`);
				k += 1;
				ended = true;
				break;
			}
			k += 1;
		}

		if (!ended) {
			// hit the size cap on a straight line of code
			const at = (start + k * 4) >>> 0;
			src.push(exitTo(at));
			src.push(carryOut(pend));
			src.push(`return ${k};`);
		}

		const lastPhys = Memory.toPhysical((start + Math.max(k - 1, 0) * 4) >>> 0);
		const lastOff = lastPhys & RAM_MASK;

		const body = "\"use strict\";\n" + src.filter(s => s !== "").join("\n");
		const fn = new Function("c", "m", "r", body);
		return {fn, lastOff};
	}
}

/**
 * @param {number} v
 * @return {string} - hex literal
 */
function hex(v) {
	return "0x" + (v >>> 0).toString(16);
}

/**
 * @param {number} at - virtual address to continue from
 * @return {string}
 */
function exitTo(at) {
	return `c.pc = ${hex(at)}; c.nextPc = ${hex((at + 4) >>> 0)};`;
}

/**
 * Applies the pending load at an instruction boundary.
 * @param {{t: string, reg?: number, v?: string} | null} pend
 * @param {number} written - register the instruction wrote, -1 if none
 * @return {string}
 */
function applyPend(pend, written) {
	if (pend === null) return "";
	if (pend.t === "dyn") {
		const guard = written >= 1 ? ` && lr !== ${written}` : "";
		return `if (lr !== 0${guard}) { r[lr] = lv; } lr = 0;`;
	}
	if (pend.reg === written || pend.reg === 0) return "";
	return `r[${pend.reg}] = ${pend.v};`;
}

/**
 * Applies the pending load on an exception path (the faulting instruction
 * never writes its result, so no overwrite guard is needed).
 * @param {{t: string, reg?: number, v?: string} | null} pend
 * @return {string}
 */
function applyPendExc(pend) {
	if (pend === null) return "";
	if (pend.t === "dyn") return "if (lr !== 0) { r[lr] = lv; }";
	if (pend.reg === 0) return "";
	return `r[${pend.reg}] = ${pend.v};`;
}

/**
 * Writes an in-flight load back to CPU state at block exit.
 * @param {{t: string, reg?: number, v?: string} | null} pend
 * @return {string}
 */
function carryOut(pend) {
	if (pend === null || pend.t !== "st" || pend.reg === 0) return "";
	return `c.loadReg = ${pend.reg}; c.loadVal = ${pend.v};`;
}

/**
 * Current value of register `n` as seen by LWL/LWR (they read the
 * in-flight load value if one targets the same register).
 * @param {number} n
 * @param {{t: string, reg?: number, v?: string} | null} pend
 * @return {string}
 */
function lwlwrCur(n, pend) {
	if (pend !== null && pend.t === "dyn") return `(lr === ${n} ? lv : r[${n}])`;
	if (pend !== null && pend.t === "st" && pend.reg === n) return `(${pend.v})`;
	return `r[${n}]`;
}

/**
 * Emits JS source for one instruction.
 *
 * @param {number} i - raw instruction word
 * @param {number} at - virtual address of the instruction
 * @param {number} k - index inside the block (for unique local names)
 * @param {boolean} bd - true when the instruction sits in a delay slot
 * @param {{t: string, reg?: number, v?: string} | null} pend - pending load
 * @return {{
 *   code: string,
 *   pend: object | null,
 *   branch: boolean,
 *   cond: string | null,
 *   target: string,
 *   ends: boolean,
 * } | null} - null when the instruction cannot be compiled
 */
function genOp(i, at, k, bd, pend) {
	const op = i >>> 26;
	const rs = (i >>> 21) & 0x1f;
	const rt = (i >>> 16) & 0x1f;
	const rd = (i >>> 11) & 0x1f;
	const shamt = (i >>> 6) & 0x1f;
	const funct = i & 0x3f;
	const simm = (i << 16) >> 16;
	const uimm = i & 0xffff;
	const pcLit = hex(at);
	const bdLit = bd ? "true" : "false";
	/** executed count if this instruction faults */
	const n = k + 1;

	const res = {code: "", pend: null, branch: false, cond: null, target: "", ends: false};

	/** plain register write + pending retire boilerplate */
	const alu = (target, expr) => {
		const w = target === 0 ? "" : `r[${target}] = ${expr};`;
		res.code = w + " " + applyPend(pend, target);
		return res;
	};

	const exc = (code, extra) => `{ ${extra || ""} ${applyPendExc(pend)} c.exceptionAt(${code}, ${pcLit}, ${bdLit}); return ${n}; }`;

	/** delayed load: memory reads happen even for r0 targets (I/O side effects) */
	const load = (valueExpr, addrCode) => {
		res.code = `${addrCode} var v${k} = ${valueExpr}; ${applyPend(pend, -1)}`;
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;
	};

	const branchTo = (targetExpr, cond, linkReg) => {
		res.branch = true;
		res.cond = cond;
		res.target = targetExpr;
		const link = linkReg !== undefined && linkReg !== 0
			? `r[${linkReg}] = ${hex((at + 8) >>> 0)} | 0;`
			: "";
		res.code = (res.code || "") + link + " " + applyPend(pend, linkReg === undefined ? -1 : linkReg);
		res.pend = null;
		return res;
	};

	switch (op) {
	case 0x00:
		switch (funct) {
		case 0x00: return alu(rd, `r[${rt}] << ${shamt}`);                    // SLL
		case 0x02: return alu(rd, `(r[${rt}] >>> ${shamt}) | 0`);             // SRL
		case 0x03: return alu(rd, `r[${rt}] >> ${shamt}`);                    // SRA
		case 0x04: return alu(rd, `r[${rt}] << (r[${rs}] & 0x1f)`);           // SLLV
		case 0x06: return alu(rd, `(r[${rt}] >>> (r[${rs}] & 0x1f)) | 0`);    // SRLV
		case 0x07: return alu(rd, `r[${rt}] >> (r[${rs}] & 0x1f)`);           // SRAV

		case 0x08: // JR
			res.code = `var t${k} = r[${rs}] >>> 0;`;
			return branchTo(`t${k}`, null);

		case 0x09: // JALR
			res.code = `var t${k} = r[${rs}] >>> 0;`;
			return branchTo(`t${k}`, null, rd);

		case 0x0c: res.code = exc(EXC.SYSCALL); res.ends = true; return res;
		case 0x0d: res.code = exc(EXC.BREAK); res.ends = true; return res;

		case 0x10: return alu(rd, "c.hi");                                    // MFHI
		case 0x11: res.code = `c.hi = r[${rs}]; ` + applyPend(pend, -1); return res; // MTHI
		case 0x12: return alu(rd, "c.lo");                                    // MFLO
		case 0x13: res.code = `c.lo = r[${rs}]; ` + applyPend(pend, -1); return res; // MTLO

		case 0x18: res.code = `c.mult64(r[${rs}], r[${rt}], true); ` + applyPend(pend, -1); return res;  // MULT
		case 0x19: res.code = `c.mult64(r[${rs}] >>> 0, r[${rt}] >>> 0, false); ` + applyPend(pend, -1); return res; // MULTU

		case 0x1a: // DIV
			res.code = `var n${k} = r[${rs}]; var d${k} = r[${rt}]; ` +
				`if (d${k} === 0) { c.hi = n${k}; c.lo = n${k} >= 0 ? -1 : 1; } ` +
				`else if (n${k} === -0x80000000 && d${k} === -1) { c.hi = 0; c.lo = -0x80000000; } ` +
				`else { c.lo = (n${k} / d${k}) | 0; c.hi = (n${k} % d${k}) | 0; } ` +
				applyPend(pend, -1);
			return res;

		case 0x1b: // DIVU
			res.code = `var n${k} = r[${rs}] >>> 0; var d${k} = r[${rt}] >>> 0; ` +
				`if (d${k} === 0) { c.hi = n${k} | 0; c.lo = -1; } ` +
				`else { c.lo = (n${k} / d${k}) | 0; c.hi = (n${k} % d${k}) | 0; } ` +
				applyPend(pend, -1);
			return res;

		case 0x20: // ADD with overflow trap
			res.code = `var a${k} = r[${rs}]; var b${k} = r[${rt}]; var s${k} = (a${k} + b${k}) | 0; ` +
				`if ((~(a${k} ^ b${k}) & (a${k} ^ s${k})) < 0) ${exc(EXC.OVERFLOW)} ` +
				(rd === 0 ? "" : `r[${rd}] = s${k};`) + " " + applyPend(pend, rd);
			return res;

		case 0x21: return alu(rd, `(r[${rs}] + r[${rt}]) | 0`);               // ADDU

		case 0x22: // SUB with overflow trap
			res.code = `var a${k} = r[${rs}]; var b${k} = r[${rt}]; var s${k} = (a${k} - b${k}) | 0; ` +
				`if (((a${k} ^ b${k}) & (a${k} ^ s${k})) < 0) ${exc(EXC.OVERFLOW)} ` +
				(rd === 0 ? "" : `r[${rd}] = s${k};`) + " " + applyPend(pend, rd);
			return res;

		case 0x23: return alu(rd, `(r[${rs}] - r[${rt}]) | 0`);               // SUBU
		case 0x24: return alu(rd, `r[${rs}] & r[${rt}]`);                     // AND
		case 0x25: return alu(rd, `r[${rs}] | r[${rt}]`);                     // OR
		case 0x26: return alu(rd, `r[${rs}] ^ r[${rt}]`);                     // XOR
		case 0x27: return alu(rd, `~(r[${rs}] | r[${rt}])`);                  // NOR
		case 0x2a: return alu(rd, `r[${rs}] < r[${rt}] ? 1 : 0`);             // SLT
		case 0x2b: return alu(rd, `(r[${rs}] >>> 0) < (r[${rt}] >>> 0) ? 1 : 0`); // SLTU
		default: return null;
		}

	case 0x01: { // BcondZ
		const ge = (rt & 1) !== 0;
		const link = (rt & 0x1e) === 0x10 ? 31 : undefined;
		res.code = `var c${k} = r[${rs}] ${ge ? ">=" : "<"} 0;`;
		return branchTo(hex((at + 4 + (simm << 2)) >>> 0), `c${k}`, link);
	}

	case 0x02: // J
		return branchTo(hex((((at + 4) & 0xf0000000) | ((i & 0x3ffffff) << 2)) >>> 0), null);

	case 0x03: // JAL
		return branchTo(hex((((at + 4) & 0xf0000000) | ((i & 0x3ffffff) << 2)) >>> 0), null, 31);

	case 0x04: // BEQ
		res.code = `var c${k} = r[${rs}] === r[${rt}];`;
		return branchTo(hex((at + 4 + (simm << 2)) >>> 0), `c${k}`);

	case 0x05: // BNE
		res.code = `var c${k} = r[${rs}] !== r[${rt}];`;
		return branchTo(hex((at + 4 + (simm << 2)) >>> 0), `c${k}`);

	case 0x06: // BLEZ
		res.code = `var c${k} = r[${rs}] <= 0;`;
		return branchTo(hex((at + 4 + (simm << 2)) >>> 0), `c${k}`);

	case 0x07: // BGTZ
		res.code = `var c${k} = r[${rs}] > 0;`;
		return branchTo(hex((at + 4 + (simm << 2)) >>> 0), `c${k}`);

	case 0x08: // ADDI with overflow trap
		res.code = `var a${k} = r[${rs}]; var s${k} = (a${k} + ${simm}) | 0; ` +
			`if ((~(a${k} ^ ${simm}) & (a${k} ^ s${k})) < 0) ${exc(EXC.OVERFLOW)} ` +
			(rt === 0 ? "" : `r[${rt}] = s${k};`) + " " + applyPend(pend, rt);
		return res;

	case 0x09: return alu(rt, `(r[${rs}] + ${simm}) | 0`);                    // ADDIU
	case 0x0a: return alu(rt, `r[${rs}] < ${simm} ? 1 : 0`);                  // SLTI
	case 0x0b: return alu(rt, `(r[${rs}] >>> 0) < ${hex(simm >>> 0)} ? 1 : 0`); // SLTIU
	case 0x0c: return alu(rt, `r[${rs}] & ${hex(uimm)}`);                     // ANDI
	case 0x0d: return alu(rt, `r[${rs}] | ${hex(uimm)}`);                     // ORI
	case 0x0e: return alu(rt, `r[${rs}] ^ ${hex(uimm)}`);                     // XORI
	case 0x0f: return alu(rt, `${(uimm << 16) | 0}`);                         // LUI

	case 0x12: { // COP2 (GTE)
		if ((i & (1 << 25)) !== 0) { // GTE command
			res.code = `c.gte.execute(${hex(i & 0x1ffffff)}); ` + applyPend(pend, -1);
			return res;
		}
		const sub = (i >>> 21) & 0x1f;
		if (sub === 0x00 || sub === 0x02) { // MFC2/CFC2: delayed, like a load
			const getter = sub === 0x00 ? "getData" : "getCtrl";
			res.code = `var v${k} = c.gte.${getter}(${rd}) | 0; ${applyPend(pend, -1)}`;
			res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
			return res;
		}
		if (sub === 0x04) { // MTC2
			res.code = `c.gte.setData(${rd}, r[${rt}]); ` + applyPend(pend, -1);
			return res;
		}
		if (sub === 0x06) { // CTC2
			res.code = `c.gte.setCtrl(${rd}, r[${rt}]); ` + applyPend(pend, -1);
			return res;
		}
		return null;
	}

	case 0x32: // LWC2: load into a GTE data register
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 3) !== 0) ${exc(EXC.ADDR_LOAD, `c.badVaddr = a${k} >>> 0;`)} ` +
			`c.gte.setData(${rt}, m.read32(a${k}) | 0); ` + applyPend(pend, -1);
		return res;

	case 0x3a: // SWC2: store from a GTE data register
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 3) !== 0) ${exc(EXC.ADDR_STORE, `c.badVaddr = a${k} >>> 0;`)} ` +
			`m.write32(a${k}, c.gte.getData(${rt})); ` + applyPend(pend, -1);
		return res;

	case 0x10: { // COP0
		const sub = (i >>> 21) & 0x1f;
		if (sub === 0x00) { // MFC0: delayed, like a load
			let v;
			switch (rd) {
			case 8: v = "c.badVaddr | 0"; break;
			case 12: v = "c.sr | 0"; break;
			case 13: v = "c.cause | 0"; break;
			case 14: v = "c.epc | 0"; break;
			case 15: v = "0x00000002"; break;
			default: v = `c.cop0r[${rd & 0xf}] | 0`;
			}
			res.code = `var v${k} = ${v}; ${applyPend(pend, -1)}`;
			res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
			return res;
		}
		if (sub === 0x04) { // MTC0
			let w;
			switch (rd) {
			case 12: w = `c.sr = r[${rt}] | 0;`; break;
			case 13: w = `c.cause = (c.cause & ~0x300) | (r[${rt}] & 0x300);`; break;
			case 14: w = `c.epc = r[${rt}] >>> 0;`; break;
			default: w = `c.cop0r[${rd & 0xf}] = r[${rt}];`;
			}
			res.code = w + " " + applyPend(pend, -1);
			return res;
		}
		if (sub >= 0x10 && funct === 0x10) { // RFE
			res.code = "c.sr = (c.sr & ~0xf) | ((c.sr >> 2) & 0xf); " + applyPend(pend, -1);
			return res;
		}
		return null;
	}

	case 0x20: // LB
		return load(`(m.read8((r[${rs}] + ${simm}) | 0) << 24) >> 24`, "");

	case 0x21: // LH
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 1) !== 0) ${exc(EXC.ADDR_LOAD, `c.badVaddr = a${k} >>> 0;`)} ` +
			`var v${k} = (m.read16(a${k}) << 16) >> 16; ${applyPend(pend, -1)}`;
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;

	case 0x22: { // LWL
		const cur = lwlwrCur(rt, pend);
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; var w${k} = m.read32(a${k} & ~3); ` +
			`var h${k} = (a${k} & 3) << 3; ` +
			`var v${k} = ((${cur} & (0x00ffffff >>> h${k})) | (w${k} << (24 - h${k}))) | 0; ` +
			applyPend(pend, -1);
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;
	}

	case 0x23: // LW
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 3) !== 0) ${exc(EXC.ADDR_LOAD, `c.badVaddr = a${k} >>> 0;`)} ` +
			`var v${k} = m.read32(a${k}) | 0; ${applyPend(pend, -1)}`;
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;

	case 0x24: // LBU
		return load(`m.read8((r[${rs}] + ${simm}) | 0) & 0xff`, "");

	case 0x25: // LHU
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 1) !== 0) ${exc(EXC.ADDR_LOAD, `c.badVaddr = a${k} >>> 0;`)} ` +
			`var v${k} = m.read16(a${k}) & 0xffff; ${applyPend(pend, -1)}`;
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;

	case 0x26: { // LWR
		const cur = lwlwrCur(rt, pend);
		res.code = `var a${k} = (r[${rs}] + ${simm}) | 0; var w${k} = m.read32(a${k} & ~3); ` +
			`var h${k} = (a${k} & 3) << 3; ` +
			`var v${k} = ((${cur} & ~(-1 >>> h${k})) | (w${k} >>> h${k})) | 0; ` +
			applyPend(pend, -1);
		res.pend = rt === 0 ? null : {t: "st", reg: rt, v: `v${k}`};
		return res;
	}

	case 0x28: // SB
		res.code = `if ((c.sr & 0x10000) === 0) { m.write8((r[${rs}] + ${simm}) | 0, r[${rt}] & 0xff); } ` +
			applyPend(pend, -1);
		return res;

	case 0x29: // SH
		res.code = `if ((c.sr & 0x10000) === 0) { var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 1) !== 0) ${exc(EXC.ADDR_STORE, `c.badVaddr = a${k} >>> 0;`)} ` +
			`m.write16(a${k}, r[${rt}] & 0xffff); } ` +
			applyPend(pend, -1);
		return res;

	case 0x2a: // SWL
		res.code = `if ((c.sr & 0x10000) === 0) { var a${k} = (r[${rs}] + ${simm}) | 0; var l${k} = a${k} & ~3; ` +
			`var w${k} = m.read32(l${k}); var h${k} = (a${k} & 3) << 3; ` +
			`m.write32(l${k}, ((w${k} & (0xffffff00 << h${k})) | ((r[${rt}] >>> 0) >>> (24 - h${k}))) | 0); } ` +
			applyPend(pend, -1);
		return res;

	case 0x2b: // SW
		res.code = `if ((c.sr & 0x10000) === 0) { var a${k} = (r[${rs}] + ${simm}) | 0; ` +
			`if ((a${k} & 3) !== 0) ${exc(EXC.ADDR_STORE, `c.badVaddr = a${k} >>> 0;`)} ` +
			`m.write32(a${k}, r[${rt}]); } ` +
			applyPend(pend, -1);
		return res;

	case 0x2e: // SWR
		res.code = `if ((c.sr & 0x10000) === 0) { var a${k} = (r[${rs}] + ${simm}) | 0; var l${k} = a${k} & ~3; ` +
			`var w${k} = m.read32(l${k}); var h${k} = (a${k} & 3) << 3; ` +
			`m.write32(l${k}, ((w${k} & ~(-1 << h${k})) | (r[${rt}] << h${k})) | 0); } ` +
			applyPend(pend, -1);
		return res;

	default:
		// COP2/LWC/SWC/illegal: rare, the interpreter handles them
		return null;
	}
}
