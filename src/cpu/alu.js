export const ALU = {

	ADD: function (i) {
		const rd = i.rd();
		const rs = i.rd();
		const rt = i.rd();
		this.setReg(rd, (this.getReg(rs) + this.getReg(rt) >>> 0));
	},

	ADDI: function (i) {
		const rt = i.rs();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, (this.getReg(rs) + imm) >>> 0);
	},

	ADDIU: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, (this.getReg(rs) + imm) >>> 0);
	},

	ADDU: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, (this.getReg(rs) + this.getReg(rt)) >>> 0);
	},

	AND: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) & this.getReg(rt));
	},

	ANDI: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) & imm);
	},

	LUI: function (i) {
		const imm = i.imm();
		const rt = i.rt();
		this.setReg(rt, imm << 16);
	},

	NOR: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, ~(this.getReg(rs) | this.getReg(rt)));
	},

	OR: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) | this.getReg(rt));
	},

	ORI: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		const rsValue = this.getReg(rs);
		this.setReg(rt, rsValue | imm);
	},

	SLT: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const rd = i.rd();
		this.setReg(rd, this.getReg(rs) < this.getReg(rt));
	},

	SLTI: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) < imm);
	},

	SLTIU: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) < imm);
	},

	SLTU: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) < this.getReg(rt));
	},

	SUB: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) - this.getReg(rt));
	},

	SUBU: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) - this.getReg(rt));
	},

	XOR: function (i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) ^ this.getReg(rt));
	},

	XORI: function (i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) ^ imm);
	},

};
