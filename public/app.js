const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * @description Posts to a streaming endpoint and calls back for each server-sent event.
 * @param {string} url Endpoint.
 * @param {object} body JSON body.
 * @param {(event: object) => void} onEvent Called once per event.
 * @returns {Promise<void>} Resolves when the stream ends.
 */
const stream = async (url, body, onEvent) => {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    pending += decoder.decode(value, {stream: true});
    const parts = pending.split('\n\n');
    pending = parts.pop();
    parts.filter((part) => part.startsWith('data: ')).forEach((part) => onEvent(JSON.parse(part.slice(6))));
  }
};

// ---------- Views ----------

const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
const show = (view) => {
  tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  ['ask', 'index', 'insights'].forEach((name) => { $(`view-${name}`).hidden = name !== view; });
  if (view === 'insights') loadInsights();
  if (view === 'index') loadIndexTotals();
};
tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.view)));

const loadStatus = async () => {
  const s = await fetch('/api/status').then((r) => r.json());
  $('embed-model').textContent = s.embedModel;
  $('chat-model').textContent = s.chatModel;
  $('health').innerHTML = [
    `<span class="pill ${s.opensearchReady ? '' : 'down'}">OpenSearch</span>`,
    `<span class="pill ${s.embedReady && s.chatReady ? '' : 'down'}">Ollama</span>`,
    `<span class="pill plain">${s.chunks} passages</span>`,
  ].join('');
  return s;
};

// ---------- Ask ----------

const stepIds = ['embed', 'search', 'prompt', 'done'];
let lastQuestion = '';
let lastPassages = [];

const setStep = (name, state, time) => {
  const node = $(`step-${name}`);
  node.classList.remove('active', 'finished');
  if (state) node.classList.add(state);
  node.querySelector('.time').textContent = time ?? '';
};

/**
 * @description Draws the embedding as a strip of coloured cells, one per number.
 * @param {number[]} vector The embedding.
 * @returns {void}
 */
const drawVector = (vector) => {
  const canvas = $('vector');
  const ctx = canvas.getContext('2d');
  const columns = 96;
  const rows = Math.ceil(vector.length / columns);
  canvas.width = columns;
  canvas.height = rows;
  const peak = Math.max(...vector.map(Math.abs)) || 1;
  vector.forEach((value, n) => {
    const strength = Math.min(1, Math.abs(value) / peak);
    const [r, g, b] = value >= 0 ? [124, 240, 194] : [255, 200, 87];
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.08 + strength * 0.92})`;
    ctx.fillRect(n % columns, Math.floor(n / columns), 1, 1);
  });
};

const renderAnswer = (text, streaming) => {
  const html = escapeHtml(text).replace(/\s*\[(\d+)\]/g, '<span class="cite">$1</span>');
  $('answer-text').innerHTML = html + (streaming ? '<span class="caret"></span>' : '');
};

const renderSources = (passages, answer) => {
  const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
  $('source-list').innerHTML = passages
    .map((p) => `<li class="${used.has(p.n) ? 'used' : ''}"><i>${p.n}</i><div><b>${escapeHtml(p.title)}</b><q>${escapeHtml(p.text)}</q><small>${escapeHtml(p.source)} &middot; ${escapeHtml(p.owner)} &middot; updated ${p.updated}</small></div></li>`)
    .join('');
  $('sources').hidden = false;
};

const onAskEvent = (event, state) => {
  if (event.step === 'embed') {
    setStep('embed', 'finished', seconds(event.ms));
    drawVector(event.vector);
    $('vector-numbers').textContent = `[${event.vector.slice(0, 6).join(', ')}, ...]  ${event.dimension} numbers`;
    setStep('search', 'active');
  } else if (event.step === 'search') {
    setStep('search', 'finished', seconds(event.ms));
    lastPassages = event.passages;
    $('matches').innerHTML = event.passages
      .map((p) => `<li><span>${p.n}. ${escapeHtml(p.title)}</span><div class="track"><div style="width: ${Math.round(p.score * 100)}%"></div></div><code>${p.score.toFixed(2)}</code></li>`)
      .join('');
    setStep('prompt', 'active');
  } else if (event.step === 'prompt') {
    setStep('prompt', 'finished');
    $('prompt-info').textContent = `${event.passages} passages + question = ${event.characters} characters`;
    setStep('done', 'active');
  } else if (event.step === 'token') {
    state.text += event.text;
    renderAnswer(state.text, true);
  } else if (event.step === 'done') {
    setStep('done', 'finished', seconds(event.ms));
    $('speed').textContent = `${event.tokens} tokens at ${event.tokensPerSecond} tokens per second`;
    if (event.notFound) {
      $('answer').classList.add('gap');
      $('answer-tag').textContent = 'No answer found';
      renderAnswer('I could not find this in the knowledge base, so I will not guess. The question is saved as a gap for the page owners.', false);
      $('answer-meta').textContent = '';
    } else {
      renderAnswer(event.answer, false);
      renderSources(lastPassages, event.answer);
      $('answer-meta').textContent = `from ${new Set(lastPassages.map((p) => p.title)).size} documents, in ${seconds(Date.now() - state.started)}`;
      $('answer-footer').hidden = false;
    }
  } else if (event.step === 'error') {
    $('answer').classList.add('gap');
    $('answer-tag').textContent = 'Something went wrong';
    renderAnswer(event.message, false);
  }
};

const ask = async (question) => {
  if (!question) return;
  lastQuestion = question;
  $('ask-button').disabled = true;
  $('answer').hidden = false;
  $('answer').classList.remove('gap');
  $('answer-tag').textContent = 'Answer';
  $('answer-meta').textContent = '';
  $('answer-footer').hidden = true;
  $('thanks').hidden = true;
  $('answer-footer').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', 'false'));
  $('sources').hidden = true;
  $('matches').innerHTML = '';
  ['vector-numbers', 'prompt-info', 'speed'].forEach((id) => { $(id).textContent = ''; });
  $('vector').getContext('2d').clearRect(0, 0, $('vector').width, $('vector').height);
  stepIds.forEach((name) => setStep(name));
  setStep('embed', 'active');
  renderAnswer('', true);

  const state = {text: '', started: Date.now()};
  try {
    await stream('/api/ask', {question}, (event) => onAskEvent(event, state));
  } catch (error) {
    onAskEvent({step: 'error', message: error.message}, state);
  }
  $('ask-button').disabled = false;
};

$('ask-form').addEventListener('submit', (event) => {
  event.preventDefault();
  ask($('question').value.trim());
});
$('chips').addEventListener('click', (event) => {
  if (event.target.tagName !== 'BUTTON') return;
  $('question').value = event.target.textContent;
  ask(event.target.textContent);
});
$('answer-footer').addEventListener('click', async (event) => {
  if (event.target.tagName !== 'BUTTON') return;
  const helpful = event.target.dataset.helpful === 'true';
  $('answer-footer').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button === event.target)));
  await fetch('/api/feedback', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({question: lastQuestion, helpful})});
  $('thanks').hidden = false;
});

// ---------- Index ----------

const setStage = (name, value, state) => {
  const node = $(`stage-${name}`);
  node.classList.remove('active', 'finished');
  if (state) node.classList.add(state);
  if (value !== undefined) node.querySelector('b').textContent = value;
};

const loadIndexTotals = async () => {
  if ($('rebuild').disabled) return;
  const s = await loadStatus();
  setStage('collect', s.docs, 'finished');
  setStage('prepare', s.chunks, 'finished');
  setStage('embed', s.chunks, 'finished');
  setStage('store', s.chunks, 'finished');
  $('progress-bar').style.width = '100%';
};

$('rebuild').addEventListener('click', async () => {
  $('rebuild').disabled = true;
  $('log').innerHTML = '';
  $('progress-bar').style.width = '0';
  ['collect', 'prepare', 'embed', 'store'].forEach((name) => setStage(name, '-'));
  setStage('collect', '-', 'active');
  await stream('/api/ingest', {}, (event) => {
    if (event.step === 'collect') {
      setStage('collect', event.files, 'finished');
      setStage('prepare', '-', 'active');
    } else if (event.step === 'prepare') {
      setStage('prepare', event.chunks, 'finished');
      setStage('embed', 0, 'active');
    } else if (event.step === 'embed') {
      setStage('embed', event.done, 'active');
      $('progress-bar').style.width = `${Math.round((event.done / event.total) * 100)}%`;
      $('log').insertAdjacentHTML('beforeend', `<li><span>${escapeHtml(event.title)}</span><em>${escapeHtml(event.source)}</em><code>${event.chunks} x ${event.dimension}</code></li>`);
    } else if (event.step === 'store') {
      setStage('embed', event.chunks, 'finished');
      setStage('store', event.chunks, 'finished');
      $('progress-bar').style.width = '100%';
    } else if (event.step === 'error') {
      $('log').insertAdjacentHTML('beforeend', `<li><span>${escapeHtml(event.message)}</span></li>`);
    }
  });
  $('rebuild').disabled = false;
  loadStatus();
});

// ---------- Insights ----------

const loadInsights = async () => {
  const data = await fetch('/api/insights').then((r) => r.json());
  $('count-helpful').textContent = data.helpful;
  $('count-unhelpful').textContent = data.unhelpful;
  $('count-gaps').textContent = data.gaps.length;
  $('gaps').innerHTML = data.gaps.length
    ? data.gaps.map((gap) => `<li><span>${escapeHtml(gap.question)}</span><small>asked ${gap.at.slice(0, 10)} &middot; no page covers this</small></li>`).join('')
    : '<li class="empty">No gaps yet. Questions the layer cannot answer show up here.</li>';
};

loadStatus();
