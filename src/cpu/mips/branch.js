export const BRANCH = {
	J(i) {
		const target = i.address();
		this.pc = (this.pc & 0xf0000000) | (target << 2);
	}
};
