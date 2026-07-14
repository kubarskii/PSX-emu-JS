/**
 * Tiny i18n layer for the launcher UI.
 *
 * Static markup is translated by tagging elements with `data-i18n` (text
 * content) or `data-i18n-title` (the `title` attribute) and calling
 * {@link applyStaticTranslations}. Dynamic strings go through {@link t},
 * which supports `{name}` placeholder interpolation.
 */

const STORAGE_KEY = "psx-lang";

/** @type {Record<string, Record<string, string>>} */
const STRINGS = {
	ru: {
		langName: "Русский",

		// top bar / chrome
		resume: "▶ Вернуться в игру",
		settings: "Настройки",
		back: "Назад",
		fullscreen: "Полный экран",

		// home / library
		library: "Библиотека",
		emptyHint: "Выбери папку с играми — карточки появятся здесь",
		pickFolder: "Выбрать папку с играми",

		// settings rows
		rowFolder: "Папка с играми",
		folderNotSelected: "не выбрана",
		rowRescan: "Обновить библиотеку",
		rowRescanDesc: "пересканировать выбранную папку",
		biosNotLoaded: "не загружен — выбери файл образа BIOS",
		rowFile: "Запустить файл",
		rowFileDesc: "PS-X EXE / BIN / ISO вручную",
		rowBiosMenu: "BIOS-меню консоли",
		rowBiosMenuDesc: "карты памяти и CD-плеер без диска",
		rowRenderer: "Рендер",
		rowFullscreenDesc: "переключить (или F11)",
		rowLang: "Язык / Language",
		ttyLog: "TTY-лог эмулятора",

		// player OSD / legend
		osdBack: "⟵ Библиотека",
		statusLoading: "загрузка...",
		playerHint: "Esc или удерживай Select — в библиотеку · стрелки/Enter/RShift = крестовина/Start/Select · X C Z V = ✕ ◯ ▢ △ · Q/E/1/3 = L1/R1/L2/R2",
		rotateHint: "Поверни телефон горизонтально — так удобнее играть",
		legendSelect: "Выбрать",
		legendBack: "Назад",
		legendResume: "Вернуться в игру",
		legendSettings: "Настройки",

		// dynamic
		statusStats: "{mips} MIPS · {speed}% скорости консоли",
		loadingExe: "загружаю EXE...",
		fastBoot: "быстрая загрузка диска...",
		loadingBios: "загрузка BIOS...",
		onePlayer: "1 игрок",
		players: "до {n} игроков",
		cdImage: "CD-образ",
		tracks: " · {n} трек.",
		reading: "читаю {name}...",
		readingMulti: "читаю {name}: файл {done}/{total} ({file})...",
		buildFailed: "не удалось собрать образ: {err}",
		scanning: "сканирую...",
		noGames: "в папке не нашлось .bin/.iso игр",
		gamesCount: "игр: {n}",
		loadBiosHint: " · загрузи BIOS в настройках",
		folderReadFailed: "не удалось прочитать папку: {err}",
		browserUnsupported: "браузер не поддерживает доступ к папкам (нужен Chrome/Edge)",
		continueFolder: "Продолжить с папкой «{name}»",
		confirmAccess: "{name} — нужно подтвердить доступ",
		biosLoaded: "загружен ✓",
		gpu: "видеокарта ×{n}",
		software: "программный",
		afterReload: "{active} → {wanted} после перезагрузки",
		loadFailed: "не удалось загрузить файл: {err}",
		cueMissingFile: "нет файла из cue: {file}",
	},
	en: {
		langName: "English",

		resume: "▶ Resume game",
		settings: "Settings",
		back: "Back",
		fullscreen: "Fullscreen",

		library: "Library",
		emptyHint: "Pick a games folder — covers will show up here",
		pickFolder: "Choose games folder",

		rowFolder: "Games folder",
		folderNotSelected: "not selected",
		rowRescan: "Refresh library",
		rowRescanDesc: "rescan the selected folder",
		biosNotLoaded: "not loaded — pick a BIOS image file",
		rowFile: "Run a file",
		rowFileDesc: "PS-X EXE / BIN / ISO manually",
		rowBiosMenu: "Console BIOS menu",
		rowBiosMenuDesc: "memory cards and CD player without a disc",
		rowRenderer: "Renderer",
		rowFullscreenDesc: "toggle (or F11)",
		rowLang: "Язык / Language",
		ttyLog: "Emulator TTY log",

		osdBack: "⟵ Library",
		statusLoading: "loading...",
		playerHint: "Esc or hold Select — back to library · Arrows/Enter/RShift = D-pad/Start/Select · X C Z V = ✕ ◯ ▢ △ · Q/E/1/3 = L1/R1/L2/R2",
		rotateHint: "Turn your phone sideways — it plays better in landscape",
		legendSelect: "Select",
		legendBack: "Back",
		legendResume: "Resume game",
		legendSettings: "Settings",

		statusStats: "{mips} MIPS · {speed}% console speed",
		loadingExe: "loading EXE...",
		fastBoot: "fast-booting disc...",
		loadingBios: "loading BIOS...",
		onePlayer: "1 player",
		players: "up to {n} players",
		cdImage: "CD image",
		tracks: " · {n} tracks",
		reading: "reading {name}...",
		readingMulti: "reading {name}: file {done}/{total} ({file})...",
		buildFailed: "could not assemble image: {err}",
		scanning: "scanning...",
		noGames: "no .bin/.iso games found in the folder",
		gamesCount: "games: {n}",
		loadBiosHint: " · load a BIOS in settings",
		folderReadFailed: "could not read the folder: {err}",
		browserUnsupported: "this browser can't access folders (use Chrome/Edge)",
		continueFolder: "Continue with folder «{name}»",
		confirmAccess: "{name} — access needs confirmation",
		biosLoaded: "loaded ✓",
		gpu: "GPU ×{n}",
		software: "software",
		afterReload: "{active} → {wanted} after reload",
		loadFailed: "could not load the file: {err}",
		cueMissingFile: "missing file from cue: {file}",
	},
};

/** @type {Array<string>} */
export const LANGS = Object.keys(STRINGS);

/**
 * Best supported language advertised by the Browser Object Model.
 * Walks the full `navigator.languages` preference list (falling back to
 * the single `navigator.language`) and returns the first entry whose
 * primary subtag we actually ship, defaulting to English.
 * @return {string}
 */
function detectFromBrowser() {
	if (typeof navigator === "undefined") return "en";
	const prefs = Array.isArray(navigator.languages) && navigator.languages.length > 0
		? navigator.languages
		: [navigator.language];
	for (const pref of prefs) {
		if (typeof pref !== "string" || pref === "") continue;
		const primary = pref.toLowerCase().split("-")[0];
		if (STRINGS[primary] !== undefined) return primary;
	}
	return "en";
}

/** @return {string} */
function detectLang() {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved !== null && STRINGS[saved] !== undefined) return saved;
	} catch {
		// storage unavailable: fall through to navigator detection
	}
	return detectFromBrowser();
}

let lang = detectLang();

/** @return {string} */
export function getLang() {
	return lang;
}

/**
 * @param {string} next
 */
export function setLang(next) {
	if (STRINGS[next] === undefined) return;
	lang = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// storage unavailable: language just won't persist across reloads
	}
}

/** cycles to the next available language and returns it */
export function cycleLang() {
	const i = LANGS.indexOf(lang);
	setLang(LANGS[(i + 1) % LANGS.length]);
	return lang;
}

/** @return {string} - human name of the active language */
export function langName() {
	return STRINGS[lang].langName;
}

/**
 * Looks up a key in the active language (falling back to the key itself)
 * and interpolates `{placeholder}` tokens from `params`.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @return {string}
 */
export function t(key, params) {
	const table = STRINGS[lang] || STRINGS.en;
	let s = table[key];
	if (s === undefined) s = (STRINGS.en[key] !== undefined ? STRINGS.en[key] : key);
	if (params === undefined) return s;
	return s.replace(/\{(\w+)\}/g, (m, name) =>
		(params[name] !== undefined ? String(params[name]) : m));
}

/**
 * Translates every `[data-i18n]` (text) and `[data-i18n-title]` (title
 * attribute) element under `root`. Safe to call repeatedly.
 * @param {ParentNode} [root]
 */
export function applyStaticTranslations(root) {
	const scope = root || document;
	for (const el of scope.querySelectorAll("[data-i18n]")) {
		el.textContent = t(el.getAttribute("data-i18n"));
	}
	for (const el of scope.querySelectorAll("[data-i18n-title]")) {
		el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
	}
	if (typeof document !== "undefined" && document.documentElement) {
		document.documentElement.setAttribute("lang", lang);
	}
}
