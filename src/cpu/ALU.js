/**
 * Arithmetic Logic Unit
 * https://opencores.org/projects/plasma/opcodes
 * */
export const ALU = {

	ADD: function (i) {

	},

	ADDI: function () {

	},

	ADDIU: function () {

	},

	ADDU: function () {

	},

	AND: function () {

	},

	ANDI: function () {

	},

	LUI: function (i) {
		const imm = i.imm();
		const rt = i.rt();
		const v = imm << 16;
		this.setReg(rt, v);
	},

	NOR: function () {

	},

	OR: function () {

	},

	ORI: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		const v = rs | imm;
		this.setReg(rt, v);
	},

	SLT: function () {

	},

	SLTI: function () {

	},

	SLTIU: function () {

	},

	SLTU: function () {

	},

	SUB: function () {

	},

	SUBU: function () {

	},

	XOR: function () {

	},

	XORI: function () {

	},

};
