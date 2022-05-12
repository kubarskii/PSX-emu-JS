export const ALU = {

	ADD(i) {
		const rd = i.rd();
		const rs = i.rd();
		const rt = i.rd();
		this.setRegV(rd, (this.getRegV(rs) + this.getRegV(rt) >>> 0));
	},

	ADDI(i) {
		const rt = i.rs();
		const rs = i.rs();
		const imm = i.imm();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: addi  r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, (this.getRegV(rs) + imm) >>> 0);
	},

	ADDIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: addiu  r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, (this.getRegV(rs) + imm) >>> 0);
	},

	ADDU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, (this.getRegV(rs) + this.getRegV(rt)) >>> 0);
	},

	AND(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, this.getRegV(rs) & this.getRegV(rt));
	},

	ANDI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setRegV(rt, this.getRegV(rs) & imm);
	},

	LUI(i) {
		const imm = i.imm() & 0x0000ffff;
		const rt = i.rt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: lui    r${rt}, $${(imm).toString(16).padStart(4, 0)}`);
		this.setRegV(rt, imm << 16);
	},

	NOR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, ~(this.getRegV(rs) | this.getRegV(rt)));
	},

	OR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: or     r${rd}, r${rt}, r${rs}`);
		this.setRegV(rd, this.getRegV(rs) | this.getRegV(rt));
	},

	ORI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		const rsValue = this.getRegV(rs);
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: ori    r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, rsValue | imm);
	},

	SLT(i) {
		const rt = i.rt();
		const rs = i.rs();
		const rd = i.rd();
		this.setRegV(rd, this.getRegV(rs) < this.getRegV(rt));
	},

	SLTI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setRegV(rt, this.getRegV(rs) < imm);
	},

	SLTIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setRegV(rt, this.getRegV(rs) < imm);
	},

	SLTU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, this.getRegV(rs) < this.getRegV(rt));
	},

	SUB(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, this.getRegV(rs) - this.getRegV(rt));
	},

	SUBU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, this.getRegV(rs) - this.getRegV(rt));
	},

	XOR(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		this.setRegV(rd, this.getRegV(rs) ^ this.getRegV(rt));
	},

	XORI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		this.setRegV(rt, this.getRegV(rs) ^ imm);
	},

};