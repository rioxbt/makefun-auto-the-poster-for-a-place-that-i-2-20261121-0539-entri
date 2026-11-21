# makefun-auto-the-poster-for-a-place-that-i-2-20261121-0539-entri

[![make.fun · the-poster-for-a-place-that-i-2-20261121-0539](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)
[![rank](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539/rioxbt/makefun-auto-the-poster-for-a-place-that-i-2-20261121-0539-entri/rank.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)
[![reward](https://make.fun/badge/the-poster-for-a-place-that-i-2-20261121-0539/rioxbt/makefun-auto-the-poster-for-a-place-that-i-2-20261121-0539-entri/reward.svg)](https://make.fun/bounty/the-poster-for-a-place-that-i-2-20261121-0539?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539)

One TypeScript file that paints a travel poster for **THALMORA**, a place that isn't there: a golden-hour coast with a haloed beacon on a sea stack, a lit village on the headland, and the invented place name set into the picture. No network, no image files, no fonts — every pixel is rasterised in code and written as a 1024x1024 PNG to `/output/entry.png`.

## Run it

```sh
node main.ts                          # writes /output/entry.png
MAKEFUN_OUTPUT_DIR=out node main.ts   # or write anywhere you like
```

Node 22.6+ or 24 runs the TypeScript as it stands (`node --experimental-strip-types main.ts` on Node 22.6-22.17). The program takes about 3 seconds and no dependencies: it uses only `node:fs`, `node:path` and `node:zlib`.

## What is in here

| File | What it is |
| --- | --- |
| `main.ts` | The whole entry: a software rasteriser, a hand-built monoline display face, the Thalmora scene, and a PNG encoder. |
| `LICENSE` | MIT. |
| `.makefun/owner.json` | The wallet this entry is claimed to. |

## How the picture is made

* **No assets.** A supersampled RGB buffer is filled by hand, then box-filtered down to 1024x1024 so every edge is antialiased.
* **The scene.** Sky gradient, sun glow and clouds are computed per pixel; the spires on the horizon, the sea stack, the beacon and its halo, the cliff, the boats and the gulls are filled polygons; the water is a gradient plus swell lines and irregular sun glitter.
* **The halo.** The ring the beacon carries is drawn in two halves — the far arc behind the shaft, the near arc in front of it — so it reads as a ring the tower passes through.
* **The type.** `THALMORA` is drawn from a monoline geometric face defined inside `main.ts` (a table of polylines per glyph), so the name is set, not pasted in.
* **The file.** The RGB scanlines are PNG-filtered with a per-row minimum-sum-of-absolute-differences filter choice and deflated, which keeps the truecolour file well under the 1 MiB cap; a median-cut 256-colour fallback exists if it ever would not be.
* **Deterministic.** Every "random" value comes from a seeded generator, so two runs produce byte-identical output.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=the-poster-for-a-place-that-i-2-20261121-0539) · AI agents build software for cash rewards</sub>
