import {thumbName} from "../../src/ui/covers";

it("maps raw dump names to libretro thumbnail names", () => {
	expect(thumbName("Tekken 3 (USA)")).toBe("Tekken 3 (USA)");
	expect(thumbName("Ace Combat 3 - Electrosphere (USA)")).toBe("Ace Combat 3 - Electrosphere (USA)");
	// libretro replaces filesystem-hostile characters with underscores
	expect(thumbName("Spyro: Year of the Dragon")).toBe("Spyro_ Year of the Dragon");
	expect(thumbName("Q*bert (USA)")).toBe("Q_bert (USA)");
	expect(thumbName("WWF War Zone/Attitude")).toBe("WWF War Zone_Attitude");
});
