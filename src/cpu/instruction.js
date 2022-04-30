/**
 * instruction "prototype holder" to create functional object
 *  */
function Instruction(value) {
}

/**
 * Return bits [31:26] of the instruction that is operation id
 * @param {number} instruction
 * @return {number} - operation id
 * */
Instruction.prototype.opcode = function () {
	return this.value >> 26;
};


/**
 * Works only for Immediate and Register formats (I, R)
 * 000000 00000 00000 00000 00000 000000
 *        ^^^^
 * Return bits [26:21]
 * */
Instruction.prototype.rs = function () {
	return (this.value) >> 21 & 0x1f;
};

/**
 * Works only for Immediate and Register formats (I, R)
 * 000000 00000 00000 00000 00000 000000
 *              ^^^^
 * Return bits [20:16] of the instruction that is register ID
 * @param {number} instruction
 * @return {number} - Register id from 0 to 31
 * */
Instruction.prototype.rt = function () {
	return (this.value >> 16) & 0x1f;
};

/**
 * Works only for Register format instruction (R)
 * 000000 00000 00000 00000 00000 000000
 *                    ^^^^
 * Return bits [16:11]
 * */
Instruction.prototype.rd = function () {
	return (this.value >> 11) & 0x1f;
};

/**
 * Works only for Register format instruction (R)
 * 000000 00000 00000 00000 00000 000000
 *                    ^^^^
 * Return bits [16:11]
 * */
Instruction.prototype.shamt = function () {
	return (this.value >> 6) & 0x1f;
};

/**
 * Works only for Register format instruction (R)
 * 000000 00000 00000 00000 00000 000000
 *                                ^^^^
 * Return bits [16:11]
 * */
Instruction.prototype.funct = function () {
	return this.value & 0x3f;
};

/**
 * Works only for Immediate format instruction (I)
 *
 * Return bits [16:0] of the instruction
 *
 * An immediate value (or simply an immediate or imm) is a piece of data
 * that is stored as part of the instruction itself instead of being in a memory location or a register.
 * Immediate values are typically used in instructions that load a value or
 * performs an arithmetic or a logical operation on a constant.
 *
 * read more: https://en.wikichip.org/wiki/immediate_value#:~:text=An%20immediate%20value%20(or%20simply,logical%20operation%20on%20a%20constant.
 *
 *
 * 000000 00000 00000 0000000000000000
 *                    ^^^^^^^^^^^^^^^
 *
 * @return {number} - Immediate value
 * */
Instruction.prototype.imm = function () {
	return this.value & 0xffff;
};

/**
 * Works only for Jump format instruction (J)
 * 000000 00000000000000000000000000
 *        ^^^^^^^^^^^^^^^^^^^^^^^^^
 * Return bits [26:0]
 * */
Instruction.prototype.address = function () {
	return this.value & 0x3ffffff;
};



export function instruction(v) {
	const fn = (v) => {
		fn.value = v;
		return fn;
	};
	Object.setPrototypeOf(fn, Instruction.prototype);
	return Object.assign(fn, {value: undefined})(v);
}

