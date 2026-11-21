import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config, embed, ingest, os} from './lib.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml'};

// The model must start its reply with this word when the passages hold no answer.
const NOT_FOUND = 'NOT_FOUND';

const systemPrompt = [
  'You answer questions for employees of Larkspur, using only the numbered passages you are given.',
  'Rules:',
  '- Use only facts from the passages. Never add outside knowledge.',
  '- Keep it short: two to four plain sentences.',
  '- After each fact, cite the passage it came from like [1] or [2].',
  `- If the passages do not contain the answer, reply with exactly ${NOT_FOUND} and nothing else.`,
].join('\n');

const json = (res, status, body) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let raw = '';
  for await (const part of req) raw += part;
  return raw ? JSON.parse(raw) : {};
};

/**
 * @description Opens a server-sent event stream and returns a function that sends one event.
 * @param {http.ServerResponse} res Response to stream on.
 * @returns {(event: object) => void} Sender.
 */
const openStream = (res) => {
  res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
};

const status = async () => {
  const [docs, chunks, tags] = await Promise.all([
    os('GET', `/${config.docsIndex}/_count`).catch(() => ({})),
    os('GET', `/${config.chunksIndex}/_count`).catch(() => ({})),
    fetch(config.ollama + '/api/tags').then((r) => r.json()).catch(() => ({models: []})),
  ]);
  const names = tags.models.map((model) => model.name);
  const has = (name) => names.some((n) => n === name || n === `${name}:latest`);
  return {
    docs: docs.count ?? 0,
    chunks: chunks.count ?? 0,
    embedModel: config.embedModel,
    chatModel: config.chatModel,
    embedReady: has(config.embedModel),
    chatReady: has(config.chatModel),
    opensearchReady: docs.count !== undefined,
  };
};

/**
 * @description The old wiki search: every typed word must appear in the page.
 * @param {string} q Search text.
 * @param {string} [source] Limits the search to one system, as each old tool had its own search.
 * @returns {Promise<object>} Hits with highlighted snippets and the time taken.
 */
const keywordSearch = async (q, source) => {
  const started = Date.now();
  const words = {multi_match: {query: q, fields: ['title^2', 'body'], operator: 'and'}};
  const result = await os('POST', `/${config.docsIndex}/_search`, {
    size: 10,
    query: source ? {bool: {must: words, filter: {term: {source}}}} : words,
    highlight: {fields: {body: {fragment_size: 160, number_of_fragments: 1}}, pre_tags: ['<mark>'], post_tags: ['</mark>']},
  });
  return {
    ms: Date.now() - started,
    hits: result.hits.hits.map((hit) => ({
      id: hit._id,
      title: hit._source.title,
      source: hit._source.source,
      updated: hit._source.updated,
      owner: hit._source.owner,
      snippet: hit.highlight?.body?.[0] ?? hit._source.body.slice(0, 160),
    })),
  };
};

/**
 * @description Answers one question: embed it, find the nearest passages, let the model write the answer.
 * @param {string} question The employee's question.
 * @param {(event: object) => void} send Sends one progress event to the browser.
 * @returns {Promise<void>}
 */
const ask = async (question, send) => {
  let t = Date.now();
  const [vector] = await embed([`search_query: ${question}`]);
  send({step: 'embed', ms: Date.now() - t, model: config.embedModel, dimension: vector.length, vector: vector.map((v) => Number(v.toFixed(3)))});

  t = Date.now();
  const found = await os('POST', `/${config.chunksIndex}/_search`, {
    size: config.topK,
    _source: {excludes: ['vector']},
    query: {knn: {vector: {vector, k: config.topK}}},
  });
  const passages = found.hits.hits.map((hit, n) => ({n: n + 1, id: hit._id, score: Number(hit._score.toFixed(3)), ...hit._source}));
  send({step: 'search', ms: Date.now() - t, took: found.took, index: config.chunksIndex, passages});

  const context = passages.map((p) => `[${p.n}] ${p.title} (${p.source}, updated ${p.updated})\n${p.text}`).join('\n\n');
  const prompt = `Passages:\n\n${context}\n\nQuestion: ${question}`;
  send({step: 'prompt', characters: prompt.length, passages: passages.length});

  t = Date.now();
  const response = await fetch(config.ollama + '/api/chat', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model: config.chatModel,
      stream: true,
      think: false,
      keep_alive: '30m',
      options: {temperature: 0.1, num_ctx: 4096},
      messages: [{role: 'system', content: systemPrompt}, {role: 'user', content: prompt}],
    }),
  });
  if (!response.ok) throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);

  let answer = '';
  let stats = {};
  let pending = '';
  const decoder = new TextDecoder();
  for await (const part of response.body) {
    pending += decoder.decode(part, {stream: true});
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const data = JSON.parse(line);
      const piece = data.message?.content ?? '';
      answer += piece;
      // Hold back text while it could still be the "not found" marker.
      if (piece && !NOT_FOUND.startsWith(answer.trim().slice(0, NOT_FOUND.length))) send({step: 'token', text: piece});
      if (data.done) stats = data;
    }
  }
  const found404 = answer.trim().startsWith(NOT_FOUND);
  if (found404) {
    // One record per distinct question, so asking twice does not list the gap twice.
    const id = createHash('sha1').update(question.toLowerCase()).digest('hex');
    await os('PUT', `/${config.feedbackIndex}/_doc/gap-${id}?refresh=true`, {question, kind: 'gap', at: new Date().toISOString()});
  }
  send({
    step: 'done',
    ms: Date.now() - t,
    model: config.chatModel,
    notFound: found404,
    answer: found404 ? '' : answer.trim(),
    tokens: stats.eval_count ?? 0,
    tokensPerSecond: stats.eval_duration ? Number((stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1)) : 0,
  });
};

const insights = async () => {
  const result = await os('POST', `/${config.feedbackIndex}/_search`, {
    size: 50,
    sort: [{at: 'desc'}],
    aggs: {kinds: {terms: {field: 'kind'}}},
  });
  const counts = Object.fromEntries((result.aggregations?.kinds.buckets ?? []).map((b) => [b.key, b.doc_count]));
  const rows = (result.hits?.hits ?? []).map((hit) => hit._source);
  return {
    helpful: counts.helpful ?? 0,
    unhelpful: counts.unhelpful ?? 0,
    gaps: rows.filter((row) => row.kind === 'gap'),
    unhelpfulQuestions: rows.filter((row) => row.kind === 'unhelpful'),
  };
};

const routes = {
  'GET /api/status': async (req, res) => json(res, 200, await status()),
  'GET /api/keyword': async (req, res, url) => json(res, 200, await keywordSearch(url.searchParams.get('q') || '', url.searchParams.get('source'))),
  'GET /api/insights': async (req, res) => json(res, 200, await insights()),
  'POST /api/feedback': async (req, res) => {
    const {question, helpful} = await readBody(req);
    await os('POST', `/${config.feedbackIndex}/_doc?refresh=true`, {question, kind: helpful ? 'helpful' : 'unhelpful', at: new Date().toISOString()});
    json(res, 200, {ok: true});
  },
  'POST /api/ask': async (req, res) => {
    const {question} = await readBody(req);
    const send = openStream(res);
    await ask(String(question || '').trim(), send).catch((error) => send({step: 'error', message: error.message}));
    res.end();
  },
  'POST /api/ingest': async (req, res) => {
    const send = openStream(res);
    await ingest(send).catch((error) => send({step: 'error', message: error.message}));
    res.end();
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return await route(req, res, url);
      const name = url.pathname === '/' ? 'index.html' : url.pathname === '/wiki' ? 'wiki.html' : url.pathname.slice(1);
      const file = path.join(publicDir, path.normalize(name));
      if (!file.startsWith(publicDir)) return json(res, 403, {error: 'forbidden'});
      const body = await readFile(file);
      res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'});
      res.end(body);
    } catch (error) {
      if (error.code === 'ENOENT') return json(res, 404, {error: 'not found'});
      if (!res.headersSent) json(res, 500, {error: error.message});
      else res.end();
    }
  })
  .listen(config.port, '127.0.0.1', () => console.log(`Larkspur knowledge demo: http://localhost:${config.port}`));
