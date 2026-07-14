import {pickMeta} from "../../src/ui/library";

const MAP = {
	"Tekken 3 (USA)": {title: "Tekken 3", year: "1998"},
	"Tenchu - Stealth Assassins (USA) (v1.0)": {title: "Tenchu: Stealth Assassins", year: "1998"},
	"Diablo (USA) (En,Fr,De,Sv)": {title: "Diablo", year: "1998"},
};

it("matches by exact raw name", () => {
	expect(pickMeta(MAP, "Tekken 3 (USA)", "Tekken 3").year).toBe("1998");
});

it("matches by cleaned key when the raw names differ", () => {
	// folder game: metadata keyed by folder name, game raw name is the file
	expect(pickMeta(MAP, "Tenchu - Stealth Assassins (USA) (v1.0) (Track 1)",
		"Tenchu - Stealth Assassins").title).toBe("Tenchu: Stealth Assassins");
});

it("matches by the metadata title itself", () => {
	expect(pickMeta(MAP, "diablo.bin", "Diablo").title).toBe("Diablo");
});

it("returns null when nothing matches", () => {
	expect(pickMeta(MAP, "Wipeout (Europe)", "Wipeout")).toBe(null);
});
