# Photo Search

Local semantic search over your own photos and screenshots. Point it at folders, and it makes them searchable by what is *in* them — type `table`, `dark code editor`, or `masa` and get the matching images back.

Runs entirely on your machine. No cloud, no account, no telemetry. Images never leave the computer they are on.

- **Semantic image search** — SigLIP 2 embeddings computed on your GPU
- **Text inside screenshots** — an OCR pass makes printed words searchable, fused with visual similarity
- **English and Turkish** — multilingual model and `tur+eng` OCR by default
- **Find visually similar** — from any photo, or by dropping an image onto the window
- **Filters, collections, saved searches, duplicate detection**

## Status: early, and not yet packaged

> **There are no binary releases.** This is a v0.1 you run from source, and it needs `uv`, Node and Rust on your machine.
>
> Semantic search over your own folders works today, so does text search inside screenshots, and watched folders stay up to date on their own — drop an image in and it is in the grid a couple of seconds later. **Collections, saved searches and duplicate detection do not work yet** — the UI for them is built and running on placeholder data.
>
> OCR uses Tesseract, which must be installed (`pacman -S tesseract tesseract-data-eng`). **Turkish also needs `tesseract-data-tur`**; without it the engine falls back to English and says so in the log.
>
> `PLAN.md` has the ordered next steps; `ARCHITECTURE.md` has the design.

## Run it

```bash
npm install
cd sidecar && uv sync && cd ..    # torch + CUDA wheels, ~3 GB
npm run doctor                    # check the machine has what it needs
npm run tauri dev                 # desktop app, your own photos
```

`npm run doctor` is the first thing to run when something looks wrong. Missing Tesseract, missing Turkish language data, torch quietly on the CPU, a config naming an engine that is not installed, no watched folders — all of those show up in the app as the same empty grid and none of them announce themselves. It prints each one with the command that fixes it, loads no model, spawns no server, and changes nothing.

The desktop shell starts the Python sidecar, picks up its port and token, and talks to it over loopback. Add a folder in Settings and indexing begins — roughly 10 images/second on an RTX 4070 laptop GPU, thumbnails included. Screenshots are then read by OCR at about 1.3/second on the CPU, in parallel. Searches answer in a few milliseconds.

```bash
npm run dev            # just the UI in a browser at :1420
```

In a browser there is no sidecar handshake, so the app runs against a fixture library of 420 generated photos. Every screen works — search, filters, grid density, selection, lightbox, settings, the model-switch flow — which is what makes UI work fast.

The sidecar also runs on its own, which is the quickest way to debug indexing or ranking. It prints its port and a per-run token on stdout, then serves:

```bash
cd sidecar
uv run python -m picsearch.server --port 8756
# {"port": 8756, "token": "…"}

curl -H "X-PicSearch-Token: $TOKEN" -X POST -d '{"path":"~/Pictures"}' localhost:8756/folders
curl -H "X-PicSearch-Token: $TOKEN" 'localhost:8756/search?q=table&limit=20'
```

Every request carries the token, the desktop app's included. There is no flag that turns that off.

## Requirements

- Linux (Windows/macOS should work but are untested)
- An NVIDIA GPU is strongly recommended — CPU inference is roughly 20× slower
- `uv`, Node 22+, Rust stable
- ~3 GB of disk for model weights on first run

## How it works

Three processes on one machine: a Tauri window (Rust) hosting a React interface, talking over loopback HTTP to a Python sidecar that owns the model, the OCR engine, and a SQLite index. The sidecar binds an ephemeral port and mints a per-run token; nothing else on the machine can read your index.

Storage follows the XDG spec — index and thumbnails in `~/.local/share/pic-search/`, config in `~/.config/pic-search/`, model weights in the shared `~/.cache/huggingface/`.

## Contributing

Read `CLAUDE.md` first. Two things routinely surprise people:

- **The brace style is deliberate** (`if(cond){` / `}else{`). There is no Prettier and there must not be — it cannot express this and will silently rewrite every file.
- **Embeddings are keyed by `(image_id, model_id)`.** Switching models does not delete the old vectors, which is what makes switching back instant.
- **Visual and text results are merged by rank, not by score.** Cosine sits around 0.2–0.35 and BM25 around 0–20; the `score` field is Reciprocal Rank Fusion and reads about 0.03.

## License

MIT
