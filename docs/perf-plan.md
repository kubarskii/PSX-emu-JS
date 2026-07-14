# План оптимизации PSX-emu-JS

Документ с идеями по ускорению эмулятора. Основан на профилировании, бенчмарках и опыте неудачных попыток (регрессии в играх / падение FPS).

## Контекст

| Компонент | Нагрузка | Запас |
|-----------|----------|-------|
| CPU (block cache) | ~230–350 Minstr/s | большой (~34 Minstr/s реальная PS1) |
| GPU software raster | основной bottleneck в 3D | узкое место |
| renderDisplay + blit | каждый кадр | заметно |
| GC / аллокации JS | всплески, провисания | средне |

**Вывод:** CPU уже с запасом. В 3D-сценах упираемся в **растеризацию GPU** и **вывод кадра**, а не в интерпретатор.

---

## Принципы для JS

1. **Не создавать объекты в hot path** — `{}`, `[]`, closures, arrow functions в цикле.
2. **Reuse scratch** — поля класса, TypedArray, pool с возвратом *после* compaction (не во время callback).
3. **Инлайн вместо вызовов** — `#plot`, `#texel` в inner loop треугольника дороги для JIT.
4. **Один алгоритм — один результат** — любая смена покрытия пикселей = регресс в играх.
5. **Сначала замер, потом правка** — DevTools Performance, `% скорости` в status bar, эталонные GPU-тесты.

---

## Что уже пробовали (и чего избегать)

| Изменение | Результат |
|-----------|-----------|
| Span-based rasterization | Регресс: другое покрытие пикселей |
| Incremental UV без `& 0xff` | Игры ломаются |
| `c.mem.irqLine` в block cache | Только BIOS, IRQ не срабатывает |
| Event pool: return в pool *до* compaction | CDROM timeout, игры не стартуют |
| Closure cache `#plotWriter` (32 fn) | Не дало выигрыша в 3D, объекты в куче |
| While-циклы + split paths в `#triangle` | Заметно хуже в играх |
| Object pooling (GTE/GPU/events) | Мало эффекта в 3D, CPU не bottleneck |

---

## Приоритет 1 — безопасные, локальные

### GPU: inner loop `#triangle`

- [ ] **Integer fixed-point barycentric** — `invAreaFp` (16-bit frac) вместо float `l1/l2` на пиксель.
- [ ] **Инлайн plot + texel** без method dispatch; параметры texture window в reuse-объекте `_polyOpts`.
- [ ] **Специализированные пути** через `if` *до* цикла: flat / gouraud / textured / gouraud+tex.
- [ ] **LUT RGB555 → RGBA** в `renderDisplay` (таблица 65536 при загрузке модуля).

### Вывод кадра

- [ ] **WebGL blit** VRAM → экран (`src/ui/display.js`, отдельный WebGL context на canvas).
- [ ] **V-flip в vertex shader** (UV), CPU-буфер без переворота.
- [ ] Fallback на canvas 2D если WebGL недоступен.

### PSX main loop

- [ ] **`#pumpEvents`**: compact без `splice`, fire с конца.
- [ ] **Event pool** — возврат в pool после compaction.
- [ ] **CDROM tagged events** — без closure на каждый IRQ.
- [ ] **Wall-clock budget** (`VISIBLE_BUDGET_MS`) — уже есть; не трогать без замера.

### CPU / compiler

- [ ] **`if (c.onTty !== null) c.checkTty()`** в block cache.
- [ ] **IRQ в block cache** — только `c.irqPending()`, никогда `mem.irqLine`.
- [ ] Inline RAM read/write в compiler — осторожно, только `p < 0x00800000`; покрыть тестами.

### GTE

- [ ] Reuse `_v`, `_m`, `_t` буферы.
- [ ] Прогон `tests/cpu/gte.test.js` после правок.

---

## Приоритет 2 — средний риск, нужны тесты

### GPU: incremental interpolation

- [ ] **UV/color gradient** вдоль scanline: `u += dudx` с **`& 0xff` на каждом texel**.
- [ ] **Тот же edge-function test** `(w0|w1|w2) >= 0` — не менять fill rule.
- [ ] Сравнить побайтово с эталонным растеризатором на 10–20 синтетических треугольников.

### GPU: сужение bbox по строкам

- [ ] Per-row `xMin`/`xMax` из пересечений рёбер (не span fill — только сократить диапазон `x`).
- [ ] Обязательно: pixel-perfect тест против текущего `#triangle`.

### DMA / GPU

- [ ] Профилировать GP0 flood (много мелких полигонов vs мало крупных).
- [ ] Batch-обработка команд в одном tick — только если не ломает timing.

---

## Приоритет 3 — большой эффект, большая работа

### WebGL / GPU compute для растеризации

- [ ] VRAM как `Uint16Array` → texture upload или SSBO.
- [ ] Эмуляция GP0 на GPU (triangles, rects, lines) — отдельный большой проект.
- [ ] Гибрид: CPU эмуляция + GPU только `renderDisplay`.

### Web Worker

- [ ] GPU raster + `renderDisplay` в worker, postMessage `ImageBitmap` / `SharedArrayBuffer`.
- [ ] Синхронизация с main thread для input/CDROM — сложная, но снимает jank.

### WASM

- [ ] Порт `#triangle` + `#texel` + `blend` в Rust/C → wasm.
- [ ] JS остаётся для GP0 command parsing и остальных устройств.

### AssemblyScript / CheerpX

- [ ] Альтернатива WASM с меньшим FFI overhead.

---

## Приоритет 4 — инфраструктура замеров

- [ ] **GPU micro-benchmark** в Jest: N textured gouraud triangles, assert time < threshold (flaky — лучше относительный).
- [ ] **In-game HUD**: GPU ms / render ms / GC count (performance.memory если доступно).
- [ ] **Chrome Performance** профиль на Crash Bandicoot: доля `triangle`, `texel`, `renderDisplay`, `Minor GC`.
- [ ] **Regression checklist**: BIOS boot → игра → 60s gameplay → `% скорости` не ниже baseline.

---

## Чеклист перед любой GPU-правкой

1. `npm test` — 107+ тестов зелёные.
2. Ctrl+F5, BIOS + одна 3D-игра.
3. Нет «только BIOS» / CDROM timeout / чёрный экран.
4. Изображение не перевёрнуто (WebGL V-coord).
5. Текстуры корректны (`u & 0xff`, `v & 0xff` при сэмплинге).

---

## Рекомендуемый порядок работ

```
1. Замеры (DevTools) → подтвердить % времени в triangle vs renderDisplay  [сделано: trace 2026-07-02]
2. LUT renderDisplay + WebGL blit          [сделано]
3. Integer barycentric + inline plot/texel   [сделано]
4. Incremental UV с & 0xff                   [только после эталонных тестов]
5. WASM triangle raster                      [если JS-потолок достигнут]
```

---

## Чего не делать без explicit approval

- Span rasterization с другим алгоритмом заливки
- Изменения block cache кроме `checkTty` / `irqPending`
- Compiler memory inline без тестов на IRQ/DMA
- Оба context (2D + WebGL) на одном `<canvas>`
- «Оптимизации» без A/B замера на реальной игре

---

*Создано: 2026-07-02. Актуально для ветки `master` после отката экспериментов с pooling/rasterizer.*

---

## Статус 2026-07-02 (вечер): валидация и фикс WIP

- **Golden-тесты растеризатора** (`tests/gpu/golden.test.js`): 17 сценариев, FNV-хэш VRAM, эталон снят с git HEAD. Ловят любую смену покрытия/блендинга/текстурирования.
- **Integer barycentric ОТКАТ**: `invAreaFp=(65536/area)|0` обнулялся при area>65536, а `l1` сдвигался до умножения — текстурные треугольники рисовали 0 пикселей, гуро деградировал во flat (голдены: 6/17 fail). Возвращены float-выражения эталона внутри split-path-структуры — побитовая точность + структурный выигрыш сохранён.
- **Замер**: 31.3 → 22.5 мс/сцену (~25% быстрее эталона, картинка идентична).
- **PAGE_SHIFT 12→10**: компиляции на буте игры 31584 → 12599 (−60%). Записи в код-страницы с тем же значением больше не инвалидируют (перекопирование оверлеев).
- **compile() в геймплее — НЕ патология**: 0 инвалидаций; это прогрев свежезагруженного кода уровня (окно 1: 1241, окно 2: 258 и падает). 6.9–7.7 мс/кадр, 2.1–2.4x real-time.
- WebGL blit и event pool из WIP валидированы (125 тестов, игра до геймплея со звуком, браузер 100% скорости).

## Статус 2026-07-03: швы и GPU/GTE-оптимизации

- **Горизонтальные разрывы текстур (Crash) НАЙДЕНЫ И ПОЧИНЕНЫ**: в top-left fill rule был перевёрнут знак для горизонтальных рёбер (`B < 0` вместо `B > 0`) — верхние рёбра исключались нижним треугольником, а нижнюю строку верхнего съедал кламп bbox `maxY-1`. 1px-щель на каждой горизонтальной границе полигонов. Голдены не изменились (в сценариях не было точно-горизонтальных рёбер).
- **Новые тесты смежности** `tests/gpu/seams.test.js`: сетка квадов / веер / кривая полоса — ноль дыр. Прогонять при любой правке fill rule.
- **GTE `#mac` fast path**: wrap только при переполнении (2 modulo экономии на аккумуляцию) — 3287 → 2911 нс/группу RTPT+NCLIP+AVSZ3+NCDS (−11%), битово идентично.
- **#drawRect**: построчный hoisting (tv/trow), инкрементальный целочисленный u, split tex/flat — голдены битово те же.
- 129 тестов зелёные; Nekketsu до WORLD 1 без визуальных регрессий.

## Статус: приоритет 2 закрыт — сужение bbox по строкам

- **`rowSpan` (gpu.js)**: точное целочисленное пересечение трёх полуплоскостей рёбер с диапазоном строки — по строке считается `[xLo, xHi]`, цикл по x идёт только внутри. Пропущенные пиксели — ровно те, что проваливали `(w0|w1|w2) >= 0`; покрытие не меняется, внутренний guard оставлен. Голдены (17) и швы — битово те же.
- **Замер raster bench**: 22.55 → 18.53 мс/сцену (−18%).
- **Замер Tekken 3 в бою (headless, 600 кадров)**: avg 9.00 → 7.60 мс (−16%), p90 10.42 → 8.83, p99 11.67 → 10.48 — появился запас до браузерного бюджета 12 мс; VRAM-хэш после прогона идентичен.
- **MDEC out-буфер**: `Array.push` → растущий `Int32Array` с `#reserve` (0 аллокаций на макроблок) — меньше GC-пауз в FMV.
- **Incremental UV вдоль строки — НЕ делать в float**: инкрементальное накопление float ломает битовую идентичность с эталоном (голдены упадут); целочисленный w уже инкрементальный. Остался только приоритет-3 (WASM/worker/WebGL raster) — браться, если упрёмся в потолок JS.
