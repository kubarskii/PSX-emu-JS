import {CPUTypeError} from "../errors/type-error";
import {ALU} from "./mips/alu";
import {instruction} from "./instruction";
import {MA} from "./mips/memory-access";
import {stubFn} from "../utils";
import {SHIFTER} from "./mips/shifter";
import {BRANCH} from "./mips/branch";
import {COP} from "./mips/cop";
import {memory} from "../memory";
import {BIOS_POINTER} from "../utils/constants";

/**
 * @typedef {import('./mips/alu.js').ALU} ALU
 * @typedef {import('./mips/memory-access.js').MA} MemoryAccess
 * @typedef {import('./mips/shifter.js').SHIFTER} Shifter
 * @typedef {import('./mips/branch.js').BRANCH} Branch
 * @typedef {import('./mips/cop.js').COP} Coprocessor
 */

/**
 * @typedef {Int32Array} Registers
 * */
const _isRunning = Symbol("isRunning");

export class CPU {

	/**
     * Need to turn CPU into Singleton
     * @type {CPU | null}
     * */
	static instance = null;

	/**
     * Main loop properties
     * @type {Record<string, number>}
     * */
	loopCtx = {
		prevStamp: 0,
		timeToRender: 0,
	};

	_counter = 0;

	/**
     * Program counter register
     * */
	_pc = BIOS_POINTER;
	_nextPc = BIOS_POINTER + 4;
	_currentPc = 0x0;

	/**
     * Special regs (_hi, _lo) for multiplication/division
     * */
	_hi = 0xdeadbeef;
	_lo = 0xdeadbeef;

	/**
     * Status register for coprocessor
     * */
	_sr = 0x0;

	/**
	 *
	 * */
	_cause = 0x0;

	/**
	 *
	 * */
	_epc = 0x0;

	/**
     * Coprocessor COP0 regs
     * https://psx-spx.consoledev.net/cpuspecifications/#cop0-register-summary
     * */
	cop = new Int32Array(32);

	[_isRunning] = false;

	/**
     * @type {ALU}
     * */
	alu = this.#bindInstructions(ALU);

	/**
     * @type {MemoryAccess}
     * */
	ma = this.#bindInstructions(MA);

	/**
     * @type {Shifter}
     * */
	shift = this.#bindInstructions(SHIFTER);

	/**
     * @type Branch
     * */
	branch = this.#bindInstructions(BRANCH);

	/**
     * @type Coprocessor
     * */
	coprocessor = this.#bindInstructions(COP);

	/**
     * @type Registers
     * */
	regs = new Int32Array(32);

	/**
	 * Output registers
	 * @type Registers
	 * */
	out_regs = new Int32Array(32);

	constructor() {
		if (CPU.instance) return this;
		this.init();
		CPU.instance = this;
	}

	/**
     * @param {Record<string, (i: Instruction) => void>} obj
     * */
	#bindInstructions(obj) {
		return Object.keys(obj).reduce((acc, curr) => {
			acc[curr] = obj[curr].bind(this);
			return acc;
		}, {});
	}

	init() {
		this.loop(performance.now());
	}

	/**
     * @param {number} value - u32
     * */
	set pc(value) {
		if (typeof value !== "number")
			throw new CPUTypeError("Program Counter (PC) value MUST be number");
		this._pc = value;
	}

	/**
	 * @return {number} - u32
	 * */
	get pc() {
		return this._pc >>> 0;
	}

	/**
	 * @param {number} value - u32
	 * */
	set sr(value) {
		this._sr = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set hi(value) {
		this._hi = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set cause(value) {
		this._cause = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set epc(value) {
		this._epc = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set lo(value) {
		this._lo = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set nextPc(value) {
		this._nextPc = value;
	}

	/**
	 * @param {number} value - u32
	 * */
	set currentPc(value) {
		this._currentPc = value;
	}

	/**
     * Setting register value by id look register table
     * @param {number} regId
     * @param {number} value
     * */
	setRegV(regId, value) {
		if (regId > 0x1f) throw new CPUTypeError("Register id MUST be less then 32");

		this.regs[regId] = value;
		/**
         * R0 (zero) register MUST be always stay 0
         * */
		this.regs[0] = 0x0;
	}


	/**
     * @param {number} regId
     * */
	getRegV(regId) {
		if (regId > 0x1f) throw new CPUTypeError("Register id MUST be less then 32");
		return this.regs[regId];
	}

	/**
     * @type {FrameRequestCallback}
     * @param {number} stamp
     * @return {unknown}
     * */
	loop(stamp) {
		requestAnimationFrame(this.loop.bind(this));
		if (!this.isRunning) return stamp;
	}


	/**
     * setter for [_isRunning] property
     * @param {boolean} value
     * @return {void}
     * */
	set isRunning(value) {
		if (typeof value !== "boolean") throw new CPUTypeError("isRunning value should be true/false");
		this[_isRunning] = value;
	}

	/**
     * getter for [_isRunning] property
     * @return {boolean}
     * */
	get isRunning() {
		return this[_isRunning];
	}

	fetchInstruction(pc){
		const code = memory.memRead(pc);
		return instruction(code);
	}

	/**
     * Executes operation
     * @return {void}
     * */
	execute() {
		if (this.pc % 4 !== 0x0) {
			throw new Error("PC is not correctly aligned!");
		}

		this._currentPc = this.pc;
		const i = this.fetchInstruction(this.pc);

		this.pc = this._nextPc;
		this._nextPc = (this.pc + 4) >>> 0;

		const opcode = i.opcode();
		switch (opcode) {
		case 0x0:
			switch (i.funct()) {
			case 0x0:
				console.log(`${this._currentPc.toString(16)} nop`);
				this.shift.SLL(i);
				break;
			case 0x2:
				break;
			case 0x3:
				break;
			case 0x4:
				break;
			case 0x6:
				break;
			case 0x7:
				break;
			case 0x8:
				break;
			case 0x9:
				break;
			case 0xc:
				break;
			case 0xd:
				break;
			case 0x10:
				break;
			case 0x11:
				break;
			case 0x12:
				break;
			case 0x13:
				break;
			case 0x18:
				break;
			case 0x19:
				break;
			case 0x1a:
				break;
			case 0x1b:
				break;
			case 0x20:
				this.alu.ADD(i);
				break;
			case 0x21:
				this.alu.ADDU(i);
				break;
			case 0x22:
				this.alu.SUB(i);
				break;
			case 0x23:
				this.alu.SUBU(i);
				break;
			case 0x24:
				this.alu.AND(i);
				break;
			case 0x25:
				this.alu.OR(i);
				break;
			case 0x26:
				this.alu.XOR(i);
				break;
			case 0x27:
				this.alu.NOR(i);
				break;
			case 0x2a:
				this.alu.SLT(i);
				break;
			case 0x2b:
				this.alu.SLTU(i);
				break;
			default:
				console.log(`${this._currentPc.toString(16)} nop`);
				stubFn();
			}
			break;
		case 0x1:
			// BcondZ
			break;
		case 0x2:
			this.branch.J(i);
			break;
		case 0x3:
			//JAL
			break;
		case 0x4:
			//BEQ
			break;
		case 0x5:
			//BNE
			this.branch.BNE(i);
			break;
		case 0x6:
			//BLEZ
			break;
		case 0x7:
			//BGTZ
			break;
		case 0x8:
			this.alu.ADDI(i);
			break;
		case 0x9:
			this.alu.ADDIU(i);
			break;
		case 0xa:
			//SLTI
			break;
		case 0xb:
			//SLTIU
			break;
		case 0xc:
			this.alu.ANDI(i);
			break;
		case 0xd:
			this.alu.ORI(i);
			break;
		case 0xe:
			this.alu.XORI(i);
			break;
		case 0xf:
			this.alu.LUI(i);
			break;
		case 0x10:
			this.coprocessor.MTC0(i);
			break;
		case 0x11:
			//COP1
			break;
		case 0x12:
			//COP2
			break;
		case 0x13:
			//COP3
			break;
		case 0x20:
			//LB
			break;
		case 0x21:
			//LH
			break;
		case 0x22:
			//LWL
			break;
		case 0x23:
			//LW
			break;
		case 0x24:
			//LBU
			break;
		case 0x25:
			//LHU
			break;
		case 0x26:
			//LWR
			break;
		case 0x28:
			//SB
			break;
		case 0x29:
			//SH
			break;
		case 0x2a:
			//SWL
			break;
		case 0x2b:
			this.ma.SW(i);
			break;
		case 0x2e:
			//SWR
			break;
		case 0x30:
			//LWC0
			break;
		case 0x31:
			//LWC1
			break;
		case 0x32:
			//LWC2
			break;
		case 0x33:
			//LWC3
			break;
		case 0x38:
			//SWC0
			break;
		case 0x39:
			break;
		case 0x3a:
			break;
		case 0x3b:
			break;
		default:
			console.log(`${this._currentPc.toString(16)} nop`);
			stubFn();
		}
		this._counter++;
	}

}
