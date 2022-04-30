import {CPUTypeError} from "../errors/type-error";
import {ALU} from "./ALU";
import {instruction} from "./instruction";

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
        prevStamp: 0, timeToRender: 0,
    };

    _pc = 0x0;
    _hi = 0x0;
    _lo = 0x0;

    [_isRunning] = false;

    alu = Object.keys(ALU).reduce((acc, curr) => {
        acc[curr] = ALU[curr].bind(this);
        return acc;
    }, {});

    /**
     * @type Registers
     * */
    registers = new Int32Array(32);

    constructor() {
        if (CPU.instance) return this;
        this.init();
        CPU.instance = this;
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
        return this._pc
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
     * @return {void}
     * */
    loop(stamp) {
        requestAnimationFrame(this.loop.bind(this));
        if (!this.isRunning) return;
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
        if (typeof operation !== "string" && typeof operation !== "number") throw new CPUTypeError("Operation MUST be a number or string");
        const i = instruction(operation);
        const opcode = i.opcode();
        switch (opcode) {
            case 0xf:
                this.alu.LUI(i);
                break;
            case 0xd:
                this.alu.ORI(i);
                break;
            default:
                console.log(this.registers)
                throw new Error("Instruction is not implemented!");
        }
        this.pc = this.pc + 1
    }

}
