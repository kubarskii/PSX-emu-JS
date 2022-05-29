import {CPUTypeError} from "../errors/type-error";
import {ALU} from "./mips/alu";
import {instruction} from "./instruction";
import {MA} from "./mips/memory-access";
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
     * COP0 Status register for coprocessor
     * */
	_sr = 0x0;

	/**
     * COP0 register, contains cause of exception
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
	outRegs = new Int32Array(32);

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

	get sr() {
		return this._sr;
	}

	/**
     * @param {number} value - u32
     * */
	set hi(value) {
		this._hi = value;
	}

	get hi() {
		return this._hi;
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

	fetchInstruction(pc) {
		const code = memory.memRead(pc);
		return instruction(code);
	}

	k = 0;

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
		// debugger;
		this.pc = this._nextPc;
		this._nextPc = (this.pc + 4) >>> 0;

		const opcode = i.opcode();

		// if (i.value === 0x8c870000) {
		// 	this.k++;
		// 	if (this.k === 8955) {
		// 		window.useLog = true;
		// 		debugger;
		// 	}
		// }

		const ops = {
			0b000000: () => this.executeSubFunction(i),
			0b001111: () => this.alu.LUI(i),
			0b001101: () => this.alu.ORI(i),
			0b101011: () => this.ma.SW(i),
			0b001001: () => this.alu.ADDIU(i),
			0b010000: () => this.executeCop0(i),
			0b000010: () => this.branch.J(i),
			0b000101: () => this.branch.BNE(i),
			0b001000: () => this.alu.ADDI(i),
			0b100011: () => this.ma.LW(i),
			0b101001: () => this.ma.SH(i),
			0b000011: () => this.branch.JAL(i),
			0b001100: () => this.alu.ANDI(i),
			0b101000: () => this.ma.SB(i),
			0b100000: () => this.ma.LB(i),
			0b000100: () => this.branch.BEQ(i),
			0b000111: () => this.branch.BGTZ(i),
			0b000110: "Box::new (Bltz::new (instruction))",
			0b100100: "Box::new (Lbu::new (instruction))",
			0b000001: "Box::new (Bxx::new (instruction))",
			0b001010: () => this.alu.SLTI(i),
			0b001011: () => this.alu.SLTIU(i),
			0b100101: "Box::new (Lhu::new (instruction))",
			0b100001: "Box::new (Lh::new (instruction))",
			0b100010: "Box::new (Lwl::new (instruction))",
			0b100110: "Box::new (Lwr::new (instruction))",
			0b101010: "Box::new (Swl::new (instruction))",
			0b101110: "Box::new (Swr::new (instruction))",
		};

		if (ops[opcode] && typeof ops[opcode] === "function") {
			ops[opcode]();
		} else {
			console.log("nop, Unknown opcode!");
		}
		this._counter++;
	}

	executeCop0(i) {
		const opcode = i.copOpcode();
		const ops = {
			0b000100: () => this.coprocessor.MTC0(i),
			0b000000: () => this.coprocessor.MFC0(i),
			0b010000: "Box::new(Rfe::new(instruction))",
		};

		if (ops[opcode] && typeof ops[opcode] === "function") {
			ops[opcode]();
		} else {
			console.log("nop, Unknown COP0 opcode!");
		}

	}

	executeSubFunction(i) {
		const opcode = i.funct();

		const ops = {
			0b000000: () => this.shift.SLL(i),
			0b100101: () => this.alu.OR(i),
			0b100111: () => this.alu.NOR(i),
			0b101011: () => this.alu.SLTU(i),
			0b100001: () => this.alu.ADDU(i),
			0b001000: () => this.branch.JR(i),
			0b100100: () => this.alu.AND(i),
			0b100000: () => this.alu.ADD(i),
			0b001001: () => this.branch.JALR(i),
			0b100011: () => this.alu.SUBU(i),
			0b000011: "Box::new(Sra::new(instruction))",
			0b011010: "Box::new(Div::new(instruction))",
			0b010010: "Box::new(Mflo::new(instruction))",
			0b010000: "Box::new(Mfhi::new(instruction))",
			0b000010: "Box::new(Srl::new(instruction))",
			0b011011: "Box::new(Divu::new(instruction))",
			0b101010: () => this.alu.SLT(i),
			0b001100: "Box::new(Syscall::new())",
			0b010011: "Box::new(Mtlo::new(instruction))",
			0b010001: "Box::new(Mthi::new(instruction))",
			0b000100: "Box::new(Sllv::new(instruction))",
			0b100110: () => this.alu.XOR(i),
			0b011001: "Box::new(Multu::new(instruction))",
			0b000110: "Box::new(Srlv::new(instruction))",
			0b100010: () => this.alu.SUB(i),
		};

		if (ops[opcode] && typeof ops[opcode] === "function") {
			ops[opcode](i);
		} else {
			console.log("nop, Unknown sub-function opcode!");
		}
	}


}
