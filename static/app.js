/**
 * NewsAnalyzer — Frontend Logic
 * 統合分析フロー: 各記事要約(逐次) → 全記事討論ラジオ + TTS音声再生
 */

// ── DOM 参照 ──────────────────────────────────────────────────────
const feedDomestic      = document.getElementById('feedDomestic');
const feedEconomy       = document.getElementById('feedEconomy');
const feedEntertainment = document.getElementById('feedEntertainment');
const feedWorld         = document.getElementById('feedWorld');
const feedHardware      = document.getElementById('feedHardware');
const feedSoftware      = document.getElementById('feedSoftware');
const feedOverseasBiz   = document.getElementById('feedOverseasBiz');
const feedOverseasCulture = document.getElementById('feedOverseasCulture');
const feedOverseasTech  = document.getElementById('feedOverseasTech');
const articleCount      = document.getElementById('articleCount');
const articleCountBadge = document.getElementById('articleCountBadge');
const analyzeBtn        = document.getElementById('analyzeBtn');
const progressWrap      = document.getElementById('progressWrap');
const progressFill      = document.getElementById('progressFill');
const progressText      = document.getElementById('progressText');
const emptyState        = document.getElementById('emptyState');
const loadingState      = document.getElementById('loadingState');
const loadingText       = document.getElementById('loadingText');
const resultsContainer  = document.getElementById('resultsContainer');
const scheduleNext      = document.getElementById('scheduleNext');
const runNowBtn         = document.getElementById('runNowBtn');
const cachePreview      = document.getElementById('cachePreview');
const cacheTime         = document.getElementById('cacheTime');
const cacheLabelBadge   = document.getElementById('cacheLabelBadge');
const loadCacheBtn      = document.getElementById('loadCacheBtn');
const apiStatusDot      = document.getElementById('apiStatusDot');
const apiStatusText     = document.getElementById('apiStatusText');
const apiModelRow       = document.getElementById('apiModelRow');
const apiModelValue     = document.getElementById('apiModelValue');
const hamburger         = document.getElementById('hamburger');
const sidebar           = document.getElementById('sidebar');
const sidebarOverlay    = document.getElementById('sidebarOverlay');
const sidebarClose      = document.getElementById('sidebarClose');

// ── 状態 ──────────────────────────────────────────────────────────
let currentFeed = 'domestic';
let isRunning   = false;
let cachedData  = null;
let currentResults = [];

const STEP_PROGRESS = { 1: 10, 2: 35, 3: 65, 4: 88, done: 100 };

// ── ハンバーガーメニュー（モバイル）──────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('active');
  hamburger.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
  hamburger.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}
hamburger?.addEventListener('click', openSidebar);
sidebarClose?.addEventListener('click', closeSidebar);
sidebarOverlay?.addEventListener('click', closeSidebar);

// ── フィード切替 ──────────────────────────────────────────────────
function setFeed(feed) {
  currentFeed = feed;
  feedDomestic.classList.toggle('active', feed === 'domestic');
  feedEconomy.classList.toggle('active', feed === 'economy');
  feedEntertainment.classList.toggle('active', feed === 'entertainment');
  feedWorld.classList.toggle('active', feed === 'world');
  feedHardware.classList.toggle('active', feed === 'hardware');
  feedSoftware.classList.toggle('active', feed === 'software');
  feedOverseasBiz.classList.toggle('active', feed === 'overseas_biz');
  feedOverseasCulture.classList.toggle('active', feed === 'overseas_culture');
  feedOverseasTech.classList.toggle('active', feed === 'overseas_tech');
}
feedDomestic.addEventListener('click', () => setFeed('domestic'));
feedEconomy.addEventListener('click',  () => setFeed('economy'));
feedEntertainment.addEventListener('click', () => setFeed('entertainment'));
feedWorld.addEventListener('click', () => setFeed('world'));
feedHardware.addEventListener('click', () => setFeed('hardware'));
feedSoftware.addEventListener('click', () => setFeed('software'));
feedOverseasBiz.addEventListener('click', () => setFeed('overseas_biz'));
feedOverseasCulture.addEventListener('click', () => setFeed('overseas_culture'));
feedOverseasTech.addEventListener('click', () => setFeed('overseas_tech'));

// ── スライダー ────────────────────────────────────────────────────
articleCount.addEventListener('input', () => {
  articleCountBadge.textContent = articleCount.value;
});

// ── UI ヘルパー ───────────────────────────────────────────────────
function showEmpty()   { emptyState.hidden = false; loadingState.hidden = true;  resultsContainer.hidden = true;  }
function showLoading(m){ emptyState.hidden = true;  loadingState.hidden = false; loadingText.textContent = m; resultsContainer.hidden = true; }
function showResults() { emptyState.hidden = true;  loadingState.hidden = true;  resultsContainer.hidden = false; }

function setProgress(step, msg) {
  const pct = STEP_PROGRESS[step] ?? 50;
  progressFill.style.width = pct + '%';
  progressText.textContent = msg;
  loadingText.textContent  = msg;
}

function setRunning(running) {
  isRunning = running;
  analyzeBtn.disabled = running;
  runNowBtn.disabled  = running;
  progressWrap.hidden = !running;
  if (running) {
    progressFill.style.width = '5%';
    progressText.textContent = '準備中...';
  }
}

// ── エスケープ・フォーマット ──────────────────────────────────────
function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatText(t = '') {
  return escapeHtml(t).replace(/\n/g,'<br>').replace(/【(.+?)】/g,'<strong>【$1】</strong>');
}

// ── エラー表示 ────────────────────────────────────────────────────
function cleanErrorMsg(raw = '') {
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429'))
    return 'APIの利用上限に達しました。しばらく待ってから再度お試しください。';
  if (raw.includes('UNAVAILABLE') || raw.includes('503'))
    return 'AIサーバーが一時的に混雑しています。少し待ってから再試行してください。';
  if (raw.includes('credits') || raw.includes('prepayment'))
    return 'APIのクレジットが不足しています。AI Studioでクレジットを確認してください。';
  if (raw.includes('API_KEY') || raw.includes('401') || raw.includes('403'))
    return 'APIキーが無効です。設定を確認してください。';
  if (raw.includes('JSON') || raw.includes('抽出失敗'))
    return 'AI応答の解析に失敗しました。再度お試しください。';
  const plain = raw.replace(/\{[\s\S]*\}/, '').trim();
  return (plain.length > 0 && plain.length < 120)
    ? plain
    : '一時的なエラーが発生しました。再度「分析開始」を押してください。';
}

function renderError(msg) {
  const friendly = cleanErrorMsg(msg);
  resultsContainer.innerHTML = `
    <div class="error-banner" role="alert">
      <div class="error-icon">⚠️</div>
      <div>
        <div class="error-title">エラーが発生しました</div>
        <div class="error-msg">${escapeHtml(friendly)}</div>
        <button onclick="document.getElementById('analyzeBtn').click()" style="margin-top:10px;padding:6px 16px;background:var(--accent-1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.85rem;">再試行</button>
      </div>
    </div>`;
  showResults();
  setRunning(false);
}

// ── タブ切替 ──────────────────────────────────────────────────────
function switchTab(tabEl, panelId) {
  const card = tabEl.closest('.article-card');
  card.querySelectorAll('.card-tab').forEach(t => t.classList.remove('active'));
  card.querySelectorAll('.card-panel').forEach(p => p.classList.remove('active'));
  tabEl.classList.add('active');
  document.getElementById(panelId)?.classList.add('active');
}

// ── 記事プレビュー（スクレイピング完了直後）─────────────────────
function renderArticlePreview(articles) {
  const now = new Date().toLocaleString('ja-JP',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
  resultsContainer.innerHTML = `
    <div class="results-header">
      <div class="results-title">📡 記事を取得しました — AI分析中...</div>
      <div class="results-meta">${articles.length} 件 ｜ ${now}</div>
    </div>
    <div class="results-grid" id="articlesGrid">
      ${articles.map((a, i) => `
        <div class="article-card" id="card-${i}" style="animation-delay:${i*60}ms">
          <div class="card-header">
            <div class="card-num">${i + 1}</div>
            <div class="card-title">${escapeHtml(a.title)}</div>
            <a class="card-link" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">🔗</a>
          </div>
          <div class="card-body">
            <div class="card-panel active">
              <div class="analyzing-placeholder">
                <div class="loading-spinner" style="width:24px;height:24px;border-width:2px;"></div>
                <span>分析中...</span>
              </div>
            </div>
          </div>
        </div>`).join('')}
    </div>
    <div id="radioSection"></div>`;
  showResults();
}

// ── 記事カードを結果で更新 ────────────────────────────────────────
function updateArticleCard(data) {
  const card = document.getElementById(`card-${data.index}`);
  if (!card) return;
  const i = data.index;
  card.querySelector('.card-body').innerHTML = `
    <div class="card-tabs">
      <button class="card-tab active" onclick="switchTab(this,'summary-${i}')" id="tab-summary-${i}">
        📄 要約
      </button>
      ${data.analysis ? `
      <button class="card-tab" onclick="switchTab(this,'analysis-${i}')" id="tab-analysis-${i}">
        🔍 考察・推論
      </button>` : ''}
    </div>
    <div class="card-panel active" id="summary-${i}">
      ${formatText(data.summary)}
      <div style="margin-top: 14px; font-size: 0.85rem;">
        <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" style="color: var(--accent-1); text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">
          📰 引用元の記事を読む
        </a>
      </div>
    </div>
    ${data.analysis ? `<div class="card-panel" id="analysis-${i}">${formatText(data.analysis)}</div>` : ''}`;
  // 完了アニメーション
  card.classList.add('card-done');
}

// ═══════════════════════════════════════════════════════
// ── TTS ラジオプレイヤー ─────────────────────────────────
// ═══════════════════════════════════════════════════════
class RadioPlayer {
  constructor() {
    this.synth     = window.speechSynthesis;
    this.lines     = [];
    this.idx       = 0;
    this.playing   = false;
    this.paused    = false;
    this.onTick    = null;  // (index, speaker) → void
    this.onFinish  = null;
  }

  setLines(lines) {
    this.stop();
    this.lines = lines;
    this.idx   = 0;
  }

  play() {
    if (this.paused) {
      this.synth.resume();
      this.paused  = false;
      this.playing = true;
      return;
    }
    this.playing = true;
    this._next();
  }

  pause() {
    if (!this.playing) return;
    this.synth.pause();
    this.playing = false;
    this.paused  = true;
  }

  stop() {
    this.synth.cancel();
    this.playing = false;
    this.paused  = false;
    this.idx     = 0;
  }

  seek(index) {
    this.synth.cancel();
    this.idx = Math.max(0, Math.min(index, this.lines.length - 1));
    if (this.playing) this._next();
  }

  _next() {
    if (!this.playing || this.idx >= this.lines.length) {
      this.playing = false;
      this.paused  = false;
      this.onFinish?.();
      return;
    }
    const line = this.lines[this.idx];
    this.onTick?.(this.idx, line.speaker);

    const utt = new SpeechSynthesisUtterance(line.text);
    utt.lang  = 'ja-JP';
    utt.rate  = 0.92;
    // 話者で声の高さを変える
    utt.pitch = line.speaker === '田中' ? 0.85 : 1.15;

    // ── 高音質ボイス（Edge Natural / Google）を優先して探す ──
    const voices = this.synth.getVoices();
    const jaVoices = voices.filter(v => v.lang === 'ja-JP' || v.lang.startsWith('ja'));
    
    // 優先度: Natural (Edge) > Google > Microsoft > その他
    let bestVoice = jaVoices.find(v => v.name.includes('Natural') || v.name.includes('Online'))
                 || jaVoices.find(v => v.name.includes('Google'))
                 || jaVoices.find(v => v.name.includes('Microsoft'))
                 || jaVoices[0];

    if (bestVoice) utt.voice = bestVoice;

    utt.onend = () => { this.idx++; this._next(); };
    utt.onerror = (e) => {
      console.warn('TTS error:', e.error);
      this.idx++;
      this._next();
    };

    this.synth.speak(utt);
  }
}

const radioPlayer = new RadioPlayer();

// ── ラジオ台本レンダリング ────────────────────────────────────────
function renderRadioResult(script) {
  const section = document.getElementById('radioSection');
  if (!section) return;

  const speakerMap = {
    '田中': { initial: '田', cls: 'speaker-tanaka' },
    '鈴木': { initial: '鈴', cls: 'speaker-suzuki' },
  };

  function lineHtml(line, idx) {
    const s = speakerMap[line.speaker] ?? { initial: (line.speaker||'?').charAt(0), cls: 'speaker-other' };
    return `
      <div class="radio-line ${s.cls}" id="rl-${idx}" data-line="${idx}">
        <div class="speaker-avatar">${s.initial}</div>
        <div class="radio-bubble">
          <div class="speaker-name-label">${escapeHtml(line.speaker)}</div>
          <div class="bubble-text">${escapeHtml(line.text)}</div>
        </div>
      </div>`;
  }

  const flashLines      = script.flash      || [];
  const discussionLines = script.discussion || [];
  const allLines        = [...flashLines, ...discussionLines];

  // プレイヤーにセット
  radioPlayer.setLines(allLines);
  radioPlayer.onTick = (i) => highlightLine(i);
  radioPlayer.onFinish = () => {
    document.getElementById('playBtn')?.classList.remove('playing');
    document.getElementById('playBtn').textContent = '▶ 再生';
    clearHighlight();
  };

  const now = new Date().toLocaleString('ja-JP',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});

  section.innerHTML = `
    <div class="radio-container">
      <div class="radio-header">
        <div class="radio-on-air"><div class="radio-on-air-dot"></div>ON AIR</div>
        <div class="radio-title">${escapeHtml(script.title || 'ニュースデイリー')}</div>
        <div class="radio-date">${escapeHtml(script.date_label || now)}</div>
      </div>

      <!-- 音声コントロール -->
      <div class="audio-controls">
        <button class="audio-btn play-btn" id="playBtn" aria-label="再生">▶ 再生</button>
        <button class="audio-btn" id="pauseBtn" aria-label="一時停止">⏸ 停止</button>
        <button class="audio-btn" id="stopBtn"  aria-label="最初から">⏹ リセット</button>
        <div class="audio-info" id="audioInfo">0 / ${allLines.length} 行</div>
      </div>

      ${flashLines.length ? `
      <div class="radio-section" style="animation-delay:100ms">
        <div class="radio-section-header">
          <span>📣</span>
          <span class="radio-section-title">ニュースフラッシュ</span>
          <span class="radio-section-badge badge-flash">FLASH</span>
        </div>
        <div class="radio-lines">
          ${flashLines.map((l, i) => lineHtml(l, i)).join('')}
        </div>
      </div>` : ''}

      ${discussionLines.length ? `
      <div class="radio-section" style="animation-delay:200ms">
        <div class="radio-section-header">
          <span>🎙️</span>
          <span class="radio-section-title">討論コーナー</span>
          <span class="radio-section-badge badge-discuss">LIVE</span>
        </div>
        <div class="radio-lines">
          ${discussionLines.map((l, i) => lineHtml(l, i + flashLines.length)).join('')}
        </div>
      </div>` : ''}
    </div>`;

  // 音声コントロール イベント
  const playBtn  = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn  = document.getElementById('stopBtn');

  playBtn.addEventListener('click', () => {
    if (radioPlayer.playing) {
      radioPlayer.pause();
      playBtn.textContent = '▶ 再生';
      playBtn.classList.remove('playing');
    } else {
      radioPlayer.play();
      playBtn.textContent = '⏸ 一時停止';
      playBtn.classList.add('playing');
    }
  });
  pauseBtn.addEventListener('click', () => {
    radioPlayer.pause();
    playBtn.textContent = '▶ 再生';
    playBtn.classList.remove('playing');
  });
  stopBtn.addEventListener('click', () => {
    radioPlayer.stop();
    playBtn.textContent = '▶ 再生';
    playBtn.classList.remove('playing');
    clearHighlight();
    document.getElementById('audioInfo').textContent = `0 / ${allLines.length} 行`;
  });

  // 各行クリックで個別再生
  section.querySelectorAll('.radio-line').forEach(el => {
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.line);
      radioPlayer.playing = true;
      radioPlayer.seek(i);
      playBtn.textContent = '⏸ 一時停止';
      playBtn.classList.add('playing');
    });
  });

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function highlightLine(i) {
  clearHighlight();
  const el = document.getElementById(`rl-${i}`);
  if (el) {
    el.classList.add('speaking');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const total = radioPlayer.lines.length;
  const info  = document.getElementById('audioInfo');
  if (info) info.textContent = `${i + 1} / ${total} 行`;
}

function clearHighlight() {
  document.querySelectorAll('.radio-line.speaking').forEach(el => el.classList.remove('speaking'));
}

// ── SSEイベントハンドラ ───────────────────────────────────────────
function handleEvent(event) {
  switch (event.type) {
    case 'progress':
      setProgress(event.step, event.message);
      break;

    case 'articles':
      renderArticlePreview(event.articles);
      break;

    case 'article_result':
      currentResults.push(event);
      updateArticleCard(event);
      break;

    case 'radio_result':
      // Backend no longer sends this, but kept for compatibility
      break;

    case 'error':
      renderError(event.message);
      break;

    case 'done':
      // クライアント側でラジオ台本を自動生成
      const script = {
        title: "NewsAnalyzer デイリー",
        date_label: new Date().toLocaleString('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        flash: [
          { speaker: '田中', text: 'NewsAnalyzerです。本日のニュースを要約してお伝えします。' }
        ],
        discussion: [
          { speaker: '鈴木', text: '続いて、それぞれのニュースについて考察していきましょう。' }
        ]
      };
      
      // 元の記事順（インデックス順）にソート
      currentResults.sort((a, b) => a.index - b.index);
      
      currentResults.forEach((r, i) => {
        script.flash.push({ speaker: '田中', text: `ニュースその${i+1}。${r.title}のニュースです。${r.summary}` });
        if (r.analysis) {
          script.discussion.push({ speaker: '鈴木', text: `${r.title}についての考察です。${r.analysis}` });
        }
      });

      renderRadioResult(script);
      setProgress('done', '✅ 分析完了！');
      
      setRunning(false);
      progressFill.style.width = '100%';
      progressText.textContent = '✅ 完了';
      break;
  }
}

// ── メイン：分析実行 ──────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
  if (isRunning) return;
  setRunning(true);
  showLoading('分析を準備しています...');
  resultsContainer.innerHTML = '';
  currentResults = [];
  closeSidebar();  // モバイルはサイドバーを閉じる

  const modeValue = document.querySelector('input[name="analysisMode"]:checked')?.value || 'full';
  const payload = {
    feed:          currentFeed,
    article_count: parseInt(articleCount.value, 10),
    mode:          modeValue,
  };

  try {
    const response = await fetch('/api/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try { handleEvent(JSON.parse(raw)); } catch {}
      }
    }
  } catch (err) {
    renderError(err.message || '不明なエラー');
  } finally {
    setRunning(false);
  }
});

// ── API状態 ──────────────────────────────────────────────────────
async function loadApiStatus() {
  try {
    const data = await fetch('/api/status').then(r => r.json());
    if (data.api_key_configured) {
      apiStatusDot.className   = 'api-status-dot ok';
      apiStatusText.textContent = `✅ 設定済 (${data.key_hint})`;
    } else {
      apiStatusDot.className   = 'api-status-dot ng';
      apiStatusText.textContent = '⚠️ 未設定 (.env を確認)';
    }
    if (apiModelRow && apiModelValue && data.model) {
      apiModelValue.textContent = data.model;
      apiModelRow.hidden = false;
    }
  } catch (_) { apiStatusText.textContent = '接続エラー'; }
}

// ── スケジュール情報 ──────────────────────────────────────────────
async function loadScheduleInfo() {
  try {
    const data = await fetch('/api/schedule').then(r => r.json());
    if (scheduleNext) scheduleNext.textContent = `次回: ${data.next_run}`;
  } catch (_) {}
}

// ── キャッシュプレビュー ──────────────────────────────────────────
async function loadCachePreview() {
  try {
    const data = await fetch('/api/cache').then(r => r.json());
    if (data.error) return;
    cachedData = data;
    const dt = new Date(data.last_updated);
    const fmt = dt.toLocaleString('ja-JP',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
    if (cacheTime)       cacheTime.textContent = `${fmt} 更新`;
    if (cacheLabelBadge) cacheLabelBadge.textContent = data.label || '自動取得';
    if (cachePreview)    cachePreview.hidden = false;
  } catch (_) {}
}

loadCacheBtn?.addEventListener('click', () => {
  if (!cachedData?.articles) return;
  renderArticlePreview(cachedData.articles);
  cachedData.articles.forEach((a, i) => updateArticleCard({
    index: i, title: a.title, url: a.url,
    summary: a.summary, analysis: a.analysis || '',
  }));
});

// ── 今すぐ取得 ────────────────────────────────────────────────────
runNowBtn?.addEventListener('click', async () => {
  runNowBtn.disabled = true;
  runNowBtn.textContent = '⏳ 取得中...';
  try {
    await fetch('/api/run-now', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ feed: currentFeed }),
    });
    runNowBtn.textContent = '✅ 開始しました';
    setTimeout(async () => {
      await loadCachePreview();
      runNowBtn.textContent = '⚡ 今すぐ取得';
      runNowBtn.disabled = false;
    }, 35000);
  } catch (_) {
    runNowBtn.textContent = '⚡ 今すぐ取得';
    runNowBtn.disabled = false;
  }
});

// ── 初期化 ───────────────────────────────────────────────────────
// iOS では voiceschanged 後でないと日本語ボイスが取れない
window.speechSynthesis?.addEventListener('voiceschanged', () => {
  window.speechSynthesis.getVoices();
});

(async function init() {
  await Promise.all([loadApiStatus(), loadScheduleInfo(), loadCachePreview()]);
})();
