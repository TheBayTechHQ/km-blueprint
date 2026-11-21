# Knowledge management with an intelligent layer: the blueprint

A small, complete example that runs on one laptop. It answers questions from your own documents, shows its sources, and says so when it does not know.

- **Ollama** runs the two models: `nomic-embed-text` (text to numbers) and `qwen3:8b` (writes the answer).
- **OpenSearch** stores the passages and finds the nearest ones by meaning (k-NN).
- **Node.js** is one small server with no packages to install.
- **HTML, CSS and JavaScript** make the screens. No framework.

Nothing leaves your machine. There is no cloud account and no API key.

## What you need

| Thing | Version used here | Notes |
| --- | --- | --- |
| Docker | 29 | Runs OpenSearch |
| Ollama | 0.40 | Runs the models |
| Node.js | 22 | Version 18 or newer has the built-in `fetch` this uses |
| Memory | 16 GB or more | `qwen3:8b` is a 5.2 GB download |

## Run it

1. Get the models (one time):

   ```bash
   ollama pull nomic-embed-text
   ```

   ```bash
   ollama pull qwen3:8b
   ```

2. Start OpenSearch (it listens on port 9209, on this machine only):

   ```bash
   docker compose up -d
   ```

3. Build the index from the `knowledge` folder:

   ```bash
   node ingest.mjs
   ```

4. Start the app:

   ```bash
   node server.mjs
   ```

5. Open http://localhost:4310 for the new app, and http://localhost:4310/wiki for the old keyword search.

## The five steps, and where each one lives

| Step | What happens | Tool | Code |
| --- | --- | --- | --- |
| 1. Collect | Every `.md` file in `knowledge/` is read, with its title, source, owner, date and status | Node.js | `readDocument` in `lib.mjs` |
| 2. Prepare | Archived pages are skipped. Each document is split into passages, one per paragraph, and every passage keeps the labels | Node.js | `toChunks` and `ingest` in `lib.mjs` |
| 3. Understand | Each passage becomes 768 numbers | Ollama, `nomic-embed-text`, `POST /api/embed` | `embed` in `lib.mjs` |
| 3. Store | Passage, labels and vector are saved in the `km_chunks` index. The vector field is a `knn_vector` (HNSW, cosine similarity) | OpenSearch | `createIndexes` in `lib.mjs` |
| 4. Answer | The question is embedded, OpenSearch returns the 4 nearest passages, and the model writes an answer from only those passages, with `[1]` style citations | Ollama + OpenSearch | `ask` in `server.mjs` |
| 5. Improve | Thumbs up or down and unanswered questions are saved in `km_feedback` and shown on the Insights tab | OpenSearch | `insights` in `server.mjs` |

## Files

```
docker-compose.yml   OpenSearch, single node, local only
lib.mjs              settings, OpenSearch and Ollama calls, the ingest pipeline
ingest.mjs           runs the pipeline from the command line
server.mjs           the web server and the API
knowledge/           13 sample documents for a made-up company, Larkspur
public/index.html    the new app: Ask, Index, Insights
public/app.js        the new app's behaviour
public/styles.css    the new app's look
public/wiki.html     the old intranet search, for comparison
```

## The API

| Call | What it does |
| --- | --- |
| `GET /api/status` | Counts, model names, and whether OpenSearch and Ollama answer |
| `GET /api/keyword?q=...&source=Wiki` | The old search: every word must appear in the page |
| `POST /api/ask` with `{"question": "..."}` | Streams the steps and the answer as server-sent events |
| `POST /api/ingest` | Rebuilds the index and streams progress |
| `POST /api/feedback` with `{"question": "...", "helpful": true}` | Saves a rating |
| `GET /api/insights` | Rating counts and the list of gaps |

## Use your own documents

Put Markdown files in `knowledge/`. Each one starts with a small header:

```
---
title: Time off rules
source: Handbook
updated: 2026-09-02
owner: People team
status: current
---
The text, in paragraphs. Each paragraph becomes one passage.
```

Set `status: archived` on a page that should stay out of the answers. Then run `node ingest.mjs` again, or press "Rebuild index" in the app.

## Settings

All of these are optional environment variables read in `lib.mjs`.

| Variable | Default |
| --- | --- |
| `PORT` | `4310` |
| `OPENSEARCH_URL` | `http://127.0.0.1:9209` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` |
| `EMBED_MODEL` | `nomic-embed-text` |
| `CHAT_MODEL` | `qwen3:8b` |
| `KNOWLEDGE_DIR` | the `knowledge` folder |

If you change the embedding model, rebuild the index: the vector length is read from the model.

## What was measured

On an Apple M1 Pro laptop with 32 GB of memory, with both models already loaded:

- Building the index (13 documents, 28 passages): about 2 seconds.
- Turning a question into numbers: about 0.1 seconds.
- The k-NN search in OpenSearch: about 0.03 seconds.
- Writing an answer: 1 to 3 seconds, at about 23 tokens per second.

The first question after a restart is slower, because Ollama loads the model into memory.

## Limits of this example

This is a teaching example, not a production system.

- **No permissions.** Everyone can get an answer from every document. A real system must filter passages by what the person asking is allowed to see.
- **No sign-in and no security on OpenSearch.** The security plugin is switched off and the port is bound to this machine only. Do not expose it to a network.
- **Simple splitting.** One passage per paragraph works for short pages. Long or messy documents need a better splitter.
- **Vector search only.** Mixing keyword and vector search (hybrid search) usually finds exact names and codes better.
- **A small model can be wrong.** The prompt tells it to use only the passages and to say when the answer is missing, and it did so in the tests here, but always show the sources so people can check.
