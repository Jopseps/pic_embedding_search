# Photo Search

Local semantic search over your own photos and screenshots. Point it at folders, and it makes them searchable by what is *in* them — type `table`, `dark code editor`, or `masa` and get the matching images back.

Runs entirely on your machine. No cloud, no account, no telemetry. Images never leave the computer they are on.

- **Semantic image search** — SigLIP 2 embeddings computed on your GPU
- **Text inside screenshots** — an OCR pass makes printed words searchable, fused with visual similarity
- **English and Turkish** — multilingual model and `tur+eng` OCR by default
- **Find visually similar** — from any photo, or by dropping an image onto the window
- **Filters, collections, saved searches, duplicate detection**

## Status: early, and not yet packaged

> **There are no binary releases.** This is a v0.1 you run from source.
>
> The desktop app and the Python sidecar both work, but **they are not wired together yet** — the Tauri shell does not spawn the sidecar, so the app still shows a fixture library. Run the sidecar yourself and it will index and search your real folders over HTTP today. OCR, the folder watcher, collections and duplicate detection are not written yet.
>
> `PLAN.md` has the ordered next steps; `ARCHITECTURE.md` has the design.

## What works today

```bash
npm install
npm run tauri dev      # desktop app, fixture library
npm run dev            # or just the UI in a browser at :1420
```

The whole interface is live against the fixture library — search, filters, grid density, selection, lightbox, settings, and the model-switch re-index flow.

The sidecar runs on its own and does the real work. It prints its port and a per-run token on stdout, then serves:

```bash
cd sidecar && uv sync
uv run python -m picsearch.server --port 8756
# {"port": 8756, "token": "…"}

curl -H "X-PicSearch-Token: $TOKEN" -X POST -d '{"path":"~/Pictures"}' localhost:8756/folders
curl -H "X-PicSearch-Token: $TOKEN" 'localhost:8756/search?q=table&limit=20'
```

Indexing runs at roughly 10 images/second on an RTX 4070 laptop GPU including thumbnails; queries answer in a few milliseconds. Every request needs the token — there is no way to turn that off.

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

## License

MIT
