import {PSX} from "./psx";
import {readFile} from "./loader/load";
import {saveBinary, loadBinary} from "./loader/db";
import {isBios} from "./utils";
import {BINARY_TYPES} from "./utils/constants";
import {BUTTONS} from "./joypad/joypad";
import {pollGamepads, connectedGamepadId} from "./ui/gamepad";
import {pollTouch, mountTouchControls} from "./ui/touchpad";
import {
	librarySupported, pickLibraryFolder, restoreLibraryFolder,
	requestLibraryPermission, scanLibrary,
} from "./ui/library";
import {fetchCover} from "./ui/covers";
import {createDisplay} from "./ui/display";
import {t, getLang, cycleLang, langName, applyStaticTranslations} from "./ui/i18n";

const ttyOut = document.getElementById("tty");
window.__PSX = PSX;
const statusOut = document.getElementById("status");
const canvas = document.getElementById("screen");
const display = createDisplay(canvas);
window.__display = display;
const grid = document.getElementById("grid");
const homeHint = document.getElementById("home-hint");
const homeEmpty = document.getElementById("home-empty");
const pickFolderEmpty = document.getElementById("pick-folder-empty");
const gamepadStatus = document.getElementById("gamepad-status");
const clockEl = document.getElementById("clock");
const folderState = document.getElementById("folder-state");
const biosState = document.getElementById("bios-state");
const btnResume = document.getElementById("btn-resume");
const btnSettings = document.getElementById("btn-settings");
const playerOsd = document.getElementById("player-osd");
const biosFile = document.getElementById("bios-file");
const anyFile = document.getElementById("any-file");
const legend = {
	a: document.getElementById("legend-a"),
	b: document.getElementById("legend-b"),
	start: document.getElementById("legend-start"),
	select: document.getElementById("legend-select"),
};
const gameInfo = document.getElementById("game-info");
const giTitle = document.getElementById("gi-title");
const giMeta = document.getElementById("gi-meta");
const giOverview = document.getElementById("gi-overview");
const langState = document.getElementById("lang-state");

let biosBuf = null;
let discBuf = null;
let discRaw = false;
let discTracks = null;
let exeBuf = null;
let cardImage = null;
let psx = null;
let kbMask = 0;

import {WorkerClient} from "./worker/client";
let client = null;
let useWorker = false;
let inputRafId = 0;

let cardSaveTimer = 0;
function scheduleCardSave() {
	clearTimeout(cardSaveTimer);
	cardSaveTimer = setTimeout(() => {
		if (psx !== null) {
			cardImage = psx.joypad.card.data.slice().buffer;
			saveBinary(BINARY_TYPES.MEMCARD, cardImage).catch(() => {});
		}
	}, 800);
}

const views = {
	home: document.getElementById("view-home"),
	settings: document.getElementById("view-settings"),
	player: document.getElementById("view-player"),
};
let activeView = "home";

function showView(name) {
	activeView = name;
	for (const key of Object.keys(views)) views[key].classList.toggle("active", key === name);
	document.body.classList.toggle("in-player", name === "player");
	gameInfo.classList.toggle("hidden", name !== "home" || libSelected < 0);
	if (name === "player") pokeOsd();
	updateChrome();
}

function updateChrome() {
	const running = psx !== null || client !== null;
	btnResume.classList.toggle("visible", running && activeView !== "player");
	legend.a.style.display = "";
	legend.b.style.display = activeView === "settings" ? "" : "none";
	legend.select.style.display = activeView === "home" ? "" : "none";
	legend.start.style.display = running && activeView === "home" ? "" : "none";
}

btnResume.addEventListener("click", () => showView("player"));
btnSettings.addEventListener("click", () => openSettings());
document.querySelector("#topbar .logo").addEventListener("click", () => showView("home"));
document.getElementById("settings-close").addEventListener("click", () => showView("home"));
document.getElementById("osd-back").addEventListener("click", () => showView("home"));
document.getElementById("osd-settings").addEventListener("click", () => openSettings());
document.getElementById("osd-fullscreen").addEventListener("click", () => {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen();
});

function tickClock() {
	const locale = getLang() === "ru" ? "ru-RU" : "en-GB";
	clockEl.textContent = new Date().toLocaleTimeString(locale, {hour: "2-digit", minute: "2-digit"});
}
setInterval(tickClock, 15000);
tickClock();

let osdTimer = 0;
function pokeOsd() {
	playerOsd.classList.remove("hidden");
	clearTimeout(osdTimer);
	osdTimer = setTimeout(() => playerOsd.classList.add("hidden"), 4000);
}
document.addEventListener("mousemove", () => { if (activeView === "player") pokeOsd(); });

let ttyLine = "";
let ttyLastKey = "";
let ttyRepeat = 0;
const onTty = (ch) => {
	if (ch !== "\n") { ttyLine += ch; return; }
	const key = ttyLine.replace(/\d+/g, "#");
	if (key === ttyLastKey && ttyLine !== "") {
		ttyRepeat++;
		const t = ttyOut.textContent;
		const cut = t.lastIndexOf("\n", t.length - 2);
		ttyOut.textContent = t.slice(0, cut + 1) + ttyLine + " x" + (ttyRepeat + 1) + "\n";
	} else { ttyLastKey = key; ttyRepeat = 0; ttyOut.textContent += ttyLine + "\n"; }
	ttyLine = "";
	if (ttyOut.textContent.length > 8192) ttyOut.textContent = ttyOut.textContent.slice(-4096);
};

let selectHeld = 0;
let lastPadMask = 0;

function boot(opts) {
	const biosOnly = opts !== undefined && opts.biosOnly === true;
	if (biosBuf === null) { openSettings("bios"); return; }
	if (psx !== null) { psx.stop(); psx = null; }
	stopWorkerInputLoop();
	if (client !== null) { client.destroy(); client = null; }
	const workerCapable = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
	useWorker = workerCapable && display.hw === undefined && !biosOnly;
	if (useWorker) bootInWorker({biosOnly});
	else bootOnMainThread({biosOnly});
}

function bootInWorker(ctx) {
	client = new WorkerClient(canvas);
	client.onTty = onTty;
	client.onStats = (stats) => {
		const mips = (stats.ips / 1e6).toFixed(1);
		const speed = (stats.emulationSpeed * 100).toFixed(0);
		statusOut.textContent = t("statusStats", {mips, speed});
	};
	client.onCardSave = (buffer) => {
		cardImage = buffer;
		clearTimeout(cardSaveTimer);
		cardSaveTimer = setTimeout(() => { saveBinary(BINARY_TYPES.MEMCARD, cardImage).catch(() => {}); }, 800);
	};
	statusOut.textContent = t("loadingBios");
	client.start().then(() => {
		const bootOpts = {bios: biosBuf, card: cardImage, fastBoot: true};
		if (!ctx.biosOnly && discBuf !== null) bootOpts.disc = {buffer: discBuf, isRaw: discRaw, tracks: discTracks};
		if (!ctx.biosOnly && exeBuf !== null) bootOpts.exe = exeBuf;
		return client.boot(bootOpts);
	}).then((status) => {
		if (status === "exe") statusOut.textContent = t("loadingExe");
		else if (status === "fastBoot") statusOut.textContent = t("fastBoot");
		else statusOut.textContent = t("loadingBios");
		initAudio();
		startWorkerInputLoop();
		showView("player");
	}).catch((err) => {
		console.error("worker boot failed, falling back:", err);
		if (client !== null) { client.destroy(); client = null; }
		useWorker = false;
		bootOnMainThread(ctx);
	});
}

function bootOnMainThread(ctx) {
	psx = new PSX();
	if (display.hw !== undefined) psx.gpu.hw = display.hw;
	window.__psx = psx;
	window.psx = psx;
	psx.cpu.onTty = onTty;
	psx.onStats = (stats) => {
		const mips = (stats.ips / 1e6).toFixed(1);
		const speed = (stats.emulationSpeed * 100).toFixed(0);
		statusOut.textContent = t("statusStats", {mips, speed});
	};
	psx.onFrame = () => {
		const mask = kbMask | pollGamepads() | pollTouch();
		psx.joypad.buttons = (~mask) & 0xffff;
		if (activeView === "player" && (mask & ~lastPadMask) !== 0) pokeOsd();
		lastPadMask = mask;
		selectHeld = (mask & BUTTONS.SELECT) !== 0 ? selectHeld + 1 : 0;
		if (selectHeld === 90 && activeView === "player") showView("home");
		if (display.hw !== undefined) {
			display.present(psx.gpu);
		} else {
			const w = psx.gpu.hres;
			const h = psx.gpu.vres;
			display.resize(w, h);
			psx.gpu.renderDisplay(display.frameBuffer(), w, h);
			display.present();
		}
	};
	if (cardImage !== null) psx.joypad.card.load(cardImage);
	psx.joypad.card.onWrite = scheduleCardSave;
	if (!ctx.biosOnly && discBuf !== null) psx.insertDisc(discBuf, discRaw, discTracks);
	psx.loadBios(biosBuf);
	if (!ctx.biosOnly && exeBuf !== null) { psx.sideloadExe(exeBuf); statusOut.textContent = t("loadingExe"); }
	else if (!ctx.biosOnly && discBuf !== null && psx.fastBootDisc()) statusOut.textContent = t("fastBoot");
	else statusOut.textContent = t("loadingBios");
	psx.start();
	showView("player");
}

function startWorkerInputLoop() {
	const loop = () => {
		if (client === null) return;
		const mask = kbMask | pollGamepads() | pollTouch();
		client.sendInput(mask);
		if (activeView === "player" && (mask & ~lastPadMask) !== 0) pokeOsd();
		lastPadMask = mask;
		selectHeld = (mask & BUTTONS.SELECT) !== 0 ? selectHeld + 1 : 0;
		if (selectHeld === 90 && activeView === "player") showView("home");
		inputRafId = requestAnimationFrame(loop);
	};
	inputRafId = requestAnimationFrame(loop);
}

function stopWorkerInputLoop() { if (inputRafId !== 0) { cancelAnimationFrame(inputRafId); inputRafId = 0; } }

let audioCtx = null;
function initAudio() {
	if (audioCtx !== null) { audioCtx.resume(); return; }
	audioCtx = new AudioContext({sampleRate: 44100});
	const node = audioCtx.createScriptProcessor(1024, 0, 2);
	node.onaudioprocess = (e) => {
		const left = e.outputBuffer.getChannelData(0);
		const right = e.outputBuffer.getChannelData(1);
		if (useWorker && client !== null) { client.drainAudio(left, right); }
		else if (psx !== null) {
			const tmp = new Float32Array(2048);
			psx.spu.drain(tmp);
			for (let i = 0; i < 1024; i++) { left[i] = tmp[i * 2]; right[i] = tmp[i * 2 + 1]; }
		} else { left.fill(0); right.fill(0); }
	};
	node.connect(audioCtx.destination);
	audioCtx.resume();
}
document.addEventListener("click", initAudio);
document.addEventListener("keydown", initAudio);
document.addEventListener("pointerdown", initAudio);

const KEYMAP = {
	ArrowUp: BUTTONS.UP, ArrowDown: BUTTONS.DOWN, ArrowLeft: BUTTONS.LEFT, ArrowRight: BUTTONS.RIGHT,
	Enter: BUTTONS.START, ShiftRight: BUTTONS.SELECT, KeyX: BUTTONS.CROSS, KeyC: BUTTONS.CIRCLE,
	KeyZ: BUTTONS.SQUARE, KeyV: BUTTONS.TRIANGLE, KeyQ: BUTTONS.L1, KeyE: BUTTONS.R1,
	Digit1: BUTTONS.L2, Digit3: BUTTONS.R2,
};

document.addEventListener("keydown", (e) => {
	if (e.code === "Escape") {
		if (activeView === "player") showView("home");
		else if (activeView === "settings") showView("home");
		else if (psx !== null || client !== null) showView("player");
		return;
	}
	const b = KEYMAP[e.code];
	if (b === undefined) return;
	e.preventDefault();
	if (activeView === "home") { navigateHome(b); return; }
	if (activeView === "settings") { navigateSettings(b); return; }
	kbMask |= b;
});
document.addEventListener("keyup", (e) => {
	const b = KEYMAP[e.code];
	if (b === undefined) return;
	e.preventDefault();
	kbMask &= ~b;
});

function refreshGamepadStatus() {
	const id = connectedGamepadId();
	if (id !== null) { gamepadStatus.textContent = `🎮 ${id.slice(0, 32)}`; gamepadStatus.classList.add("on"); }
	else { gamepadStatus.textContent = "🎮"; gamepadStatus.classList.remove("on"); }
}
window.addEventListener("gamepadconnected", refreshGamepadStatus);
window.addEventListener("gamepaddisconnected", refreshGamepadStatus);
refreshGamepadStatus();
mountTouchControls(document.getElementById("touch-controls"));

let lastNavMask = 0;
setInterval(() => {
	const mask = pollGamepads();
	const pressed = mask & ~lastNavMask;
	lastNavMask = mask;
	if (pressed === 0 || activeView === "player") return;
	if (activeView === "home") navigateHome(pressed);
	else navigateSettings(pressed);
}, 60);

let libraryHandle = null;
let libCards = [];
let libGames = [];
let libSelected = -1;

function setSelected(i) {
	if (libCards.length === 0) return;
	i = Math.max(0, Math.min(libCards.length - 1, i));
	if (libSelected >= 0 && libCards[libSelected]) libCards[libSelected].classList.remove("focus");
	libSelected = i;
	libCards[i].classList.add("focus");
	libCards[i].scrollIntoView({block: "nearest", behavior: "smooth"});
	updateGameInfo(libGames[i]);
}

function updateGameInfo(game) {
	if (game === undefined || activeView !== "home") { gameInfo.classList.add("hidden"); return; }
	const m = game.meta || null;
	giTitle.textContent = m !== null && m.title ? m.title : game.name;
	const bits = [];
	if (m !== null && m.year) bits.push(m.year);
	if (m !== null && m.genres && m.genres.length > 0) bits.push(m.genres.join(" · "));
	if (m !== null && m.players) bits.push(m.players === 1 ? t("onePlayer") : t("players", {n: m.players}));
	bits.push(game.isExe ? "PS-X EXE" : t("cdImage") + (game.trackCount > 1 ? t("tracks", {n: game.trackCount}) : ""));
	giMeta.textContent = bits.join("  ·  ");
	giOverview.textContent = m !== null && m.overview ? m.overview.replace(/\s+/g, " ") : "";
	gameInfo.classList.remove("hidden");
}

function gridCols() { return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length); }

function navigateHome(pressed) {
	if (pressed & BUTTONS.SELECT) { openSettings(); return; }
	if (pressed & BUTTONS.START) {
		if (psx !== null || client !== null) showView("player");
		else if (libSelected >= 0 && libCards[libSelected]) libCards[libSelected].click();
		return;
	}
	if (libCards.length === 0) return;
	if (libSelected < 0) { setSelected(0); return; }
	if (pressed & BUTTONS.LEFT) setSelected(libSelected - 1);
	if (pressed & BUTTONS.RIGHT) setSelected(libSelected + 1);
	if (pressed & BUTTONS.UP) setSelected(libSelected - gridCols());
	if (pressed & BUTTONS.DOWN) setSelected(libSelected + gridCols());
	if (pressed & BUTTONS.CROSS) { const card = libCards[libSelected]; if (card) card.click(); }
}

function fmtSize(size) { return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(0)} MB` : `${(size / 1024).toFixed(0)} KB`; }

function renderGrid(games) {
	grid.textContent = "";
	libCards = []; libGames = games; libSelected = -1;
	homeEmpty.classList.toggle("visible", games.length === 0);
	for (const game of games) {
		const card = document.createElement("div");
		card.className = "card";
		card.title = `${game.name} · ${fmtSize(game.size)}`;
		if (game.coverUrl !== null) {
			const img = document.createElement("img"); img.className = "cover"; img.src = game.coverUrl; img.alt = game.name;
			card.appendChild(img);
		} else {
			const ph = document.createElement("div"); ph.className = "cover placeholder"; ph.textContent = "▲ ◯ ✕ ▢";
			const name = document.createElement("div"); name.className = "ph-name"; name.textContent = game.name;
			ph.appendChild(name); card.appendChild(ph);
			fetchCover(game.rawName).then((url) => {
				const src = url !== null ? url : (game.meta && game.meta.boxart ? game.meta.boxart : null);
				if (src === null || !card.isConnected) return;
				const img = document.createElement("img"); img.className = "cover"; img.src = src; img.alt = game.name;
				ph.replaceWith(img);
			});
		}
		const title = document.createElement("div"); title.className = "title"; title.textContent = game.name;
		card.appendChild(title);
		const cardIndex = libCards.length;
		card.addEventListener("mouseenter", () => setSelected(cardIndex));
		card.addEventListener("click", async () => {
			homeHint.textContent = t("reading", {name: game.name});
			try {
				const disc = await game.getDisc((done, total, fileName) => {
					if (total > 1) homeHint.textContent = t("readingMulti", {name: game.name, done, total, file: fileName});
				});
				if (disc.exe !== undefined) { exeBuf = disc.exe; discBuf = null; discTracks = null; }
				else { discBuf = disc.buffer; discRaw = disc.isRaw; discTracks = disc.tracks; exeBuf = null; }
				boot();
			} catch (err) { homeHint.textContent = t("buildFailed", {err: err.message || err}); }
		});
		grid.appendChild(card); libCards.push(card);
	}
	if (libCards.length > 0) setSelected(0);
}

async function useLibrary(handle) {
	libraryHandle = handle;
	folderState.textContent = handle.name; folderState.classList.add("ok");
	homeHint.textContent = t("scanning");
	try {
		const games = await scanLibrary(handle);
		homeHint.textContent = games.length === 0 ? t("noGames") : t("gamesCount", {n: games.length}) + (biosBuf === null ? t("loadBiosHint") : "");
		renderGrid(games);
	} catch (err) { homeHint.textContent = t("folderReadFailed", {err}); }
}

let pendingHandle = null;
pickFolderEmpty.addEventListener("click", async () => {
	if (pendingHandle !== null) {
		const handle = pendingHandle;
		if (await requestLibraryPermission(handle)) {
			pendingHandle = null; pickFolderEmpty.textContent = t("pickFolder"); await useLibrary(handle);
		}
		return;
	}
	await pickFolder();
});

async function pickFolder() {
	if (!librarySupported()) { homeHint.textContent = t("browserUnsupported"); return; }
	const handle = await pickLibraryFolder();
	if (handle !== null) { showView("home"); await useLibrary(handle); }
}

async function restoreLibrary() {
	homeEmpty.classList.add("visible");
	if (!librarySupported()) { homeHint.textContent = t("browserUnsupported"); return; }
	const saved = await restoreLibraryFolder();
	if (saved === null) return;
	if (saved.granted) { await useLibrary(saved.handle); return; }
	pendingHandle = saved.handle;
	pickFolderEmpty.textContent = t("continueFolder", {name: saved.handle.name});
	folderState.textContent = t("confirmAccess", {name: saved.handle.name});
}

const settingsRows = Array.from(document.querySelectorAll(".srow"));
let settingsSelected = 0;

function focusSettingsRow(i) {
	i = Math.max(0, Math.min(settingsRows.length - 1, i));
	settingsRows[settingsSelected].classList.remove("focus");
	settingsSelected = i;
	settingsRows[i].classList.add("focus");
	settingsRows[i].scrollIntoView({block: "nearest", behavior: "smooth"});
}

function openSettings(focusAction) {
	showView("settings");
	const i = focusAction === undefined ? 0 : settingsRows.findIndex((r) => r.dataset.action === focusAction);
	focusSettingsRow(i < 0 ? 0 : i);
}

function navigateSettings(pressed) {
	if (pressed & BUTTONS.UP) focusSettingsRow(settingsSelected - 1);
	if (pressed & BUTTONS.DOWN) focusSettingsRow(settingsSelected + 1);
	if (pressed & (BUTTONS.CROSS | BUTTONS.START)) settingsRows[settingsSelected].click();
	if (pressed & (BUTTONS.CIRCLE | BUTTONS.SELECT)) showView("home");
}

function updateBiosState() {
	if (biosBuf !== null) { biosState.textContent = t("biosLoaded"); biosState.classList.add("ok"); }
	else { biosState.textContent = t("biosNotLoaded"); biosState.classList.remove("ok"); }
}

const rendererState = document.getElementById("renderer-state");
function storedGpuScale() { try { return parseInt(localStorage.getItem("psx-gpu-scale"), 10) || 0; } catch { return 0; } }
function rendererLabel() {
	const s = storedGpuScale();
	const active = display.backend === "webgl2-hw" ? t("gpu", {n: display.hw.scale}) : t("software");
	if ((s > 0) === (display.backend === "webgl2-hw") && (s === 0 || display.hw.scale === s)) return active;
	const wanted = s > 0 ? t("gpu", {n: s}) : t("software");
	return t("afterReload", {active, wanted});
}
function cycleRenderer() {
	const s = storedGpuScale();
	const next = s === 0 ? 2 : (s === 2 ? 4 : 0);
	try { localStorage.setItem("psx-gpu-scale", String(next)); } catch {}
	if (rendererState !== null) rendererState.textContent = rendererLabel();
}
if (rendererState !== null) rendererState.textContent = rendererLabel();

function applyLanguage() {
	applyStaticTranslations();
	if (langState !== null) langState.textContent = langName();
	if (rendererState !== null) rendererState.textContent = rendererLabel();
	updateBiosState();
	if (libraryHandle !== null) folderState.textContent = libraryHandle.name;
	else if (pendingHandle !== null) {
		folderState.textContent = t("confirmAccess", {name: pendingHandle.name});
		pickFolderEmpty.textContent = t("continueFolder", {name: pendingHandle.name});
	}
	if (libSelected >= 0) updateGameInfo(libGames[libSelected]);
	tickClock();
}

for (const row of settingsRows) {
	row.addEventListener("mouseenter", () => focusSettingsRow(settingsRows.indexOf(row)));
	row.addEventListener("click", () => {
		switch (row.dataset.action) {
		case "folder": pickFolder(); return;
		case "rescan": if (libraryHandle !== null) { showView("home"); useLibrary(libraryHandle); } return;
		case "bios": biosFile.click(); return;
		case "file": anyFile.click(); return;
		case "biosmenu": boot({biosOnly: true}); return;
		case "renderer": cycleRenderer(); return;
		case "lang": cycleLang(); applyLanguage(); return;
		case "fullscreen": if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); return;
		default: return;
		}
	});
}

function isExeBuffer(buffer) {
	if (buffer.byteLength < 0x800) return false;
	const magic = new Uint8Array(buffer, 0, 8);
	return String.fromCharCode(...magic) === "PS-X EXE";
}
function loadAny(buffer) {
	if (isBios(buffer)) { biosBuf = buffer; saveBinary(BINARY_TYPES.BIOS, buffer).catch(() => {}); updateBiosState(); return; }
	if (isExeBuffer(buffer)) { exeBuf = buffer; discBuf = null; boot(); return; }
	discRaw = buffer.byteLength % 2352 === 0; discTracks = null; discBuf = buffer; exeBuf = null; boot();
}
function hookFileInput(input) {
	input.addEventListener("change", () => {
		const file = input.files[0]; input.value = "";
		if (!file) return;
		readFile(file).then(loadAny).catch((err) => { homeHint.textContent = t("loadFailed", {err}); });
	});
}
hookFileInput(biosFile);
hookFileInput(anyFile);

applyLanguage();
Promise.all([loadBinary(BINARY_TYPES.BIOS).catch(() => null), loadBinary(BINARY_TYPES.MEMCARD).catch(() => null)])
	.then(([bios, card]) => {
		if (bios) biosBuf = bios;
		if (card) cardImage = card;
		updateBiosState();
		updateChrome();
		return restoreLibrary();
	});
