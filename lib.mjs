import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 4310),
  opensearch: process.env.OPENSEARCH_URL || 'http://127.0.0.1:9209',
  ollama: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
  chatModel: process.env.CHAT_MODEL || 'qwen3:8b',
  knowledgeDir: process.env.KNOWLEDGE_DIR || path.join(here, 'knowledge'),
  // Whole documents, searched by keyword only: the "old wiki".
  docsIndex: 'km_docs',
  // Passages with vectors: what the intelligent layer searches.
  chunksIndex: 'km_chunks',
  // Thumbs up/down and unanswered questions.
  feedbackIndex: 'km_feedback',
  // Passages handed to the language model for one question.
  topK: 4,
};

/**
 * @description Calls OpenSearch and returns the parsed JSON body.
 * @param {string} method HTTP method.
 * @param {string} route Path starting with a slash.
 * @param {object|string} [body] JSON body, or a ready NDJSON string for _bulk.
 * @returns {Promise<object>} Parsed response.
 */
export const os = async (method, route, body) => {
  const isBulk = typeof body === 'string';
  const response = await fetch(config.opensearch + route, {
    method,
    headers: {'content-type': isBulk ? 'application/x-ndjson' : 'application/json'},
    body: body === undefined ? undefined : isBulk ? body : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenSearch ${method} ${route}: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  }
  return json;
};

/**
 * @description Turns texts into vectors with the embedding model in Ollama.
 * @param {string[]} texts Texts to embed.
 * @returns {Promise<number[][]>} One vector per text.
 */
export const embed = async (texts) => {
  const response = await fetch(config.ollama + '/api/embed', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: config.embedModel, input: texts, keep_alive: '30m'}),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).embeddings;
};

/**
 * @description Reads one knowledge file: a small header block, then the text.
 * @param {string} file File name inside the knowledge folder.
 * @returns {Promise<object>} Document with id, header fields and body.
 */
const readDocument = async (file) => {
  const raw = await readFile(path.join(config.knowledgeDir, file), 'utf8');
  const [, header, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) || [null, '', raw];
  const fields = Object.fromEntries(
    header.split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  return {id: file.replace(/\.md$/, ''), file, ...fields, body: body.trim()};
};

/**
 * @description Splits a document into passages, one per paragraph.
 * @param {object} doc Document from readDocument.
 * @returns {object[]} Passages that keep the document's title, source and date.
 */
const toChunks = (doc) =>
  doc.body.split(/\n\s*\n/).map((text, n) => ({
    id: `${doc.id}-${n + 1}`,
    doc_id: doc.id,
    title: doc.title,
    source: doc.source,
    updated: doc.updated,
    owner: doc.owner,
    text: text.trim(),
  }));

/**
 * @description Creates the three indexes from scratch.
 * @param {number} dimension Length of the embedding vectors.
 * @returns {Promise<void>}
 */
const createIndexes = async (dimension) => {
  const text = {type: 'text'};
  const keyword = {type: 'keyword'};
  await os('DELETE', `/${config.docsIndex},${config.chunksIndex}?ignore_unavailable=true`);
  await os('PUT', `/${config.docsIndex}`, {
    mappings: {properties: {title: text, body: text, source: keyword, updated: {type: 'date'}, owner: keyword, status: keyword}},
  });
  await os('PUT', `/${config.chunksIndex}`, {
    settings: {index: {knn: true}},
    mappings: {
      properties: {
        doc_id: keyword,
        title: text,
        text,
        source: keyword,
        updated: {type: 'date'},
        owner: keyword,
        vector: {
          type: 'knn_vector',
          dimension,
          method: {name: 'hnsw', engine: 'lucene', space_type: 'cosinesimil'},
        },
      },
    },
  });
  const feedback = await os('GET', `/${config.feedbackIndex}`);
  if (feedback.error) {
    await os('PUT', `/${config.feedbackIndex}`, {
      mappings: {properties: {question: text, kind: keyword, at: {type: 'date'}}},
    });
  }
};

/**
 * @description Runs the whole pipeline: collect, prepare, embed, store.
 * @param {(event: object) => void} [report] Called with progress events.
 * @returns {Promise<object>} Totals for documents, passages and time.
 */
export const ingest = async (report = () => {}) => {
  const started = Date.now();
  const files = (await readdir(config.knowledgeDir)).filter((name) => name.endsWith('.md')).sort();
  const docs = await Promise.all(files.map(readDocument));
  report({step: 'collect', files: docs.length, sources: [...new Set(docs.map((doc) => doc.source))]});

  // Archived pages stay in the old wiki but never reach the intelligent layer.
  const current = docs.filter((doc) => doc.status !== 'archived');
  const chunks = current.flatMap(toChunks);
  report({step: 'prepare', kept: current.length, skipped: docs.length - current.length, chunks: chunks.length});

  const probe = await embed(['search_document: probe']);
  await createIndexes(probe[0].length);

  let done = 0;
  for (const doc of current) {
    const mine = chunks.filter((chunk) => chunk.doc_id === doc.id);
    const vectors = await embed(mine.map((chunk) => `search_document: ${chunk.title}\n${chunk.text}`));
    mine.forEach((chunk, n) => { chunk.vector = vectors[n]; });
    done += mine.length;
    report({step: 'embed', title: doc.title, source: doc.source, chunks: mine.length, done, total: chunks.length, dimension: probe[0].length});
  }

  const lines = [];
  docs.forEach(({id, file, ...doc}) => lines.push(JSON.stringify({index: {_index: config.docsIndex, _id: id}}), JSON.stringify(doc)));
  chunks.forEach(({id, ...chunk}) => lines.push(JSON.stringify({index: {_index: config.chunksIndex, _id: id}}), JSON.stringify(chunk)));
  const bulk = await os('POST', '/_bulk?refresh=true', lines.join('\n') + '\n');
  if (bulk.errors) {
    throw new Error('Bulk indexing reported errors: ' + JSON.stringify(bulk.items.find((item) => item.index.error)).slice(0, 300));
  }
  const totals = {step: 'store', docs: docs.length, chunks: chunks.length, dimension: probe[0].length, ms: Date.now() - started};
  report(totals);
  return totals;
};
