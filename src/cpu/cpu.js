import {CPUTypeError} from "../errors/type-error";
import {DEFAULT_BIOS_PC} from "../utils/constants";

/**
 * @typedef {object} Registers
 * @property {number} gp - global pointer, possibly will not be used
 * @property {number} sp - stack pointer
 * @property {number} fp - frame pointer
 * @property {number} ra - return address
 * @property {number} pc - program counter, can be called ip sometimes, the initial value will be 0xbfc00000
 * @property {number} hi - multiply/divide results
 * @property {number} lo - multiply/divide results
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
    }

        [_isRunning] = false;

    /**
     * @type Registers
     * */
    registers = {
        pc: 0x0,
        fp: 0x0,
        ra: 0x0,
        sp: 0x0,
        gp: 0x0,
        hi: 0x0,
        lo: 0x0
    };

    constructor() {
        if (CPU.instance)
            return this;
        this.init()
        CPU.instance = this;
    }

    init() {
        this.loop(performance.now());
    }

    /**
     * setter for PC register value
     * */
    set pc(value) {
        if (typeof value !== 'number')
            throw new CPUTypeError('Program Counter (PC) value MUST be number')
        this.registers.pc = value
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
        if (typeof value !== "boolean")
            throw new CPUTypeError("isRunning value should be true/false");
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
     * @param {string | number} operation - operation in hex
     * @return {void}
     * */
    execute(operation) {
        if (typeof operation !== "string" && typeof operation !== "number")
            throw new CPUTypeError("Operation MUST be a number or string");
        debugger
    }

    /**
     * Returns operation based on PC
     * @return {number}
     * */
    getOperation() {
        const pc = this.registers.pc;
        return (~DEFAULT_BIOS_PC) & pc;
    }

}
