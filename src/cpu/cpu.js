import {CPUTypeError} from "../errors/type-error";
import {ALU} from "./mips/alu";
import {instruction} from "./instruction";
import {MA} from "./mips/memory-access";
import {stubFn} from "../utils";
import {SHIFTER} from "./mips/shifter";
import {BRANCH} from "./mips/branch";

/**
 * @typedef {import('./mips/alu.js').ALU} ALU
 * @typedef {import('./mips/memory-access.js').MA} MemoryAccess
 * @typedef {import('./mips/shifter.js').SHIFTER} Shifter
 * @typedef {import('./mips/branch.js').BRANCH} Branch
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

	_pc = 0x0;
	_hi = 0x0;
	_lo = 0x0;

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
     * @type Registers
     * */
	registers = new Int32Array(32);

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
     * setter for PC register value
     * */
	set pc(value) {
		if (typeof value !== "number") throw new CPUTypeError("Program Counter (PC) value MUST be number");
		this._pc = value;
	}

	get pc() {
		return this._pc;
	}


	/**
     * Setting register value by id look register table
     * @param {number} regId
     * @param {number} value
     * */
	setReg(regId, value) {
		if (regId > 0x1f) throw new CPUTypeError("Register id MUST be less then 32");

		this.registers[regId] = value;
		/**
         * R0 (zero) register MUST be always stay 0
         * */
		this.registers[0] = 0x0;
	}


	/**
     * @param {number} regId
     * */
	getReg(regId) {
		if (regId > 0x1f) throw new CPUTypeError("Register id MUST be less then 32");
		return this.registers[regId];
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

	/**
     * Executes operation
     * @param {number} operation - operation / instruction (32 bits)
     * @return {void}
     * */
	execute(operation) {
		if (typeof operation !== "number")
			throw new CPUTypeError("Operation MUST be a number or string");
		const i = instruction(operation);
		const opcode = i.opcode();
		switch (opcode) {
		case 0x0:
			switch (operation & 0x3f) {
			case 0x0:
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
				break;
			case 0x21:
				break;
			case 0x22:
				break;
			case 0x23:
				break;
			case 0x24:
				break;
			case 0x25:
				break;
			case 0x26:
				break;
			case 0x27:
				break;
			case 0x2a:
				break;
			case 0x2b:
				break;
			default:
				stubFn();
			}
			break;
		case 0x1:
			break;
		case 0x2:
			this.branch.J(i);
			break;
		case 0x3:
			break;
		case 0x4:
			break;
		case 0x5:
			break;
		case 0x6:
			break;
		case 0x7:
			break;
		case 0x8:
			this.alu.ADDI(i);
			break;
		case 0x9:
			this.alu.ADDIU(i);
			break;
		case 0xa:
			break;
		case 0xb:
			break;
		case 0xc:
			this.alu.ANDI(i);
			break;
		case 0xd:
			this.alu.ORI(i);
			break;
		case 0xe:
			break;
		case 0xf:
			this.alu.LUI(i);
			break;
		case 0x10:
			break;
		case 0x11:
			break;
		case 0x12:
			break;
		case 0x13:
			break;
		case 0x20:
			break;
		case 0x21:
			break;
		case 0x22:
			break;
		case 0x23:
			break;
		case 0x24:
			break;
		case 0x25:
			break;
		case 0x26:
			break;
		case 0x28:
			break;
		case 0x29:
			break;
		case 0x2a:
			break;
		case 0x2b:
			this.ma.SW(i);
			break;
		case 0x2e:
			break;
		case 0x30:
			break;
		case 0x31:
			break;
		case 0x32:
			break;
		case 0x33:
			break;
		case 0x38:
			break;
		case 0x39:
			break;
		case 0x3a:
			break;
		case 0x3b:
			break;
		default:
			stubFn();
		}
		this.pc = this.pc + 4 >>> 0;
		this._counter++;
	}

}
