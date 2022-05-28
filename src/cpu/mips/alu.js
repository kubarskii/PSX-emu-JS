import {getSigned16} from "../../utils";
import {memory} from "../../memory";

export const ALU = {
	ADD(i) {
		memory.memRead(0);
		const rd = i.rd();
		const rs = i.rd();
		const rt = i.rd();
		this.setRegV(rd, (this.getRegV(rs) + this.getRegV(rt) >>> 0));
	},

	ADDI(i) {
		const rt = i.rs();
		const rs = i.rs();
		const imm = getSigned16(i.imm());
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: addi  r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, (this.getRegV(rs) + imm) >>> 0);
	},

	ADDIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm() >>> 0;
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: addiu  r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, (this.getRegV(rs) + imm) >>> 0);
	},

	ADDU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: addu  r${rd}, r${rt}, r${rs}`);
		const v = (this.getRegV(rs) >>> 0) + (this.getRegV(rt) >> 0);
		this.setRegV(rd, v >>> 0);
	},

	AND(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: and  r${rd}, r${rt}, r${rs}`);

		this.setRegV(rd, this.getRegV(rs) & this.getRegV(rt));
	},

	ANDI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: andi  r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
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
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: nor     r${rd}, r${rt}, r${rs}`);

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
		const imm = getSigned16(i.imm() >>> 0);
		const rsValue = this.getRegV(rs);
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: ori    r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, rsValue | imm);
	},

	SLT(i) {
		const rt = i.rt();
		const rs = i.rs();
		const rd = i.rd();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: slt     r${rd}, r${rt}, r${rs}`);

		this.setRegV(rd, this.getRegV(rs) < this.getRegV(rt));
	},

	SLTI(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: slti    r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);

		this.setRegV(rt, this.getRegV(rs) < imm);
	},

	SLTIU(i) {
		const rt = i.rt();
		const rs = i.rs();
		const imm = i.imm();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: sltiu   r${rt}, r${rs}, $${imm.toString(16).padStart(4, 0)}`);
		this.setRegV(rt, (this.getRegV(rs) >>> 0) < imm);
	},

	SLTU(i) {
		const rd = i.rd();
		const rs = i.rs();
		const rt = i.rt();
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: sltu     r${rd}, r${rt}, r${rs}`);
		this.setRegV(rd, (this.getRegV(rs) >>> 0) < (this.getRegV(rt) >>> 0));
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
