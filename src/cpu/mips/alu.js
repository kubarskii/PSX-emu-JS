export const ALU = {

	ADD(i) {
		const rd = i.rd();
		const rs = i.rd();
		const rt = i.rd();
		this.setReg(rd, (this.getReg(rs) + this.getReg(rt) >>> 0));
	},

	ADDI(i) {
		const rt = i.rs();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, (this.getReg(rs) + imm) >>> 0);
	},

	ADDIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, (this.getReg(rs) + imm) >>> 0);
	},

	ADDU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, (this.getReg(rs) + this.getReg(rt)) >>> 0);
	},

	AND(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) & this.getReg(rt));
	},

	ANDI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) & imm);
	},

	LUI(i) {
		const imm = i.imm();
		const rt = i.rt();
		this.setReg(rt, imm << 16);
	},

	NOR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, ~(this.getReg(rs) | this.getReg(rt)));
	},

	OR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) | this.getReg(rt));
	},

	ORI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		const rsValue = this.getReg(rs);
		this.setReg(rt, rsValue | imm);
	},

	SLT(i) {
		const rt = i.rt();
		const rs = i.rs();
		const rd = i.rd();
		this.setReg(rd, this.getReg(rs) < this.getReg(rt));
	},

	SLTI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) < imm);
	},

	SLTIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) < imm);
	},

	SLTU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) < this.getReg(rt));
	},

	SUB(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) - this.getReg(rt));
	},

	SUBU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) - this.getReg(rt));
	},

	XOR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setReg(rd, this.getReg(rs) ^ this.getReg(rt));
	},

	XORI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setReg(rt, this.getReg(rs) ^ imm);
	},

};
