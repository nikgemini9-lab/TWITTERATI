/* global Chart */

const App = (() => {
  let activeTab         = 'all';
  let activeSort        = 'virality';
  let sortDir           = 'desc';   // 'desc' | 'asc'
  let autoTimer         = null;
  let likesChart        = null;
  let viewsChart        = null;
  let allTweets         = [];
  let maxVScore         = 1;   // for the V-score bar scaling
  let englishOnly       = false;
  let blacklist         = new Set();  // lowercase handles
  let radarCollapsed    = false;
  let activeTopicFilter = null;
  let tweetsById        = new Map();
  let previewHideTimer  = null;

  // ─── Formatters ──────────────────────────────────────────────────────────────

  function fmt(n) {
    if (n === null || n === undefined || n === '') return '—';
    n = Number(n);
    if (isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  function timeAgo(ds) {
    if (!ds) return '—';
    const m = Math.floor((Date.now() - new Date(ds)) / 60000);
    if (m < 1)    return 'just now';
    if (m < 60)   return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m / 60)}h ago`;
    return `${Math.floor(m / 1440)}d ago`;
  }

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function avatarLetter(handle) {
    return (handle || '?').replace('@', '')[0]?.toUpperCase() || '?';
  }

  // ─── English-only helpers ────────────────────────────────────────────────────

  // Returns false for non-English tweets:
  //   - >15% non-ASCII chars catches Japanese, Chinese, Korean, Arabic, etc.
  //   - Turkish marker chars (ğ/Ğ = unique to Turkish; ı/İ = dotless/dotted i,
  //     unique to Turkish) catch Turkish tweets that otherwise look Latin
  function isLikelyEnglish(text) {
    if (!text) return true;
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    if ((nonAscii / text.length) >= 0.15) return false;
    if (/[ğĞıİ]/.test(text)) return false;
    return true;
  }

  function syncEnglishBtn() {
    const btn = document.getElementById('btnEnglishOnly');
    if (!btn) return;
    if (englishOnly) btn.classList.add('on');
    else             btn.classList.remove('on');
  }

  // ─── Meme candidate detection ─────────────────────────────────────────────────
  //
  // A tweet is a meme candidate when ALL of:
  //   • has_media (it's an image/gif/video — memes aren't text threads)
  //   • bookmark ratio > 3%  (people saving it = sourcing for token launches)
  //   • RT:reply ratio > 10:1 (silent spreading, not debate)
  //   • tweet text ≤ 60 chars (photo + caption format, e.g. "Albert Whiskars")
  //
  // "Albert Whiskars" (@trapbass_): bookmark ratio 7.7%, RT:reply 37:1, 12 chars → would flag

  function isMemeCandidate(t) {
    if (!t.has_media) return false;
    const bookmarkRatio = t.likes > 0 ? t.bookmarks / t.likes : 0;
    const rtToReply     = t.retweets / Math.max(1, t.replies);
    const shortText     = !t.tweet_text || t.tweet_text.trim().length <= 60;
    return bookmarkRatio > 0.03 && rtToReply > 10 && shortText;
  }

  // ─── Badge ───────────────────────────────────────────────────────────────────

  function badge(status) {
    const map = {
      parabolic: ['b-p', '🔥 Parabolic'],
      fast:      ['b-f', '⚡ Fast'],
      warming:   ['b-w', '🌡 Warming'],
      fading:    ['b-d', '💀 Fading'],
      normal:    ['b-n', '✓ Normal'],
    };
    const [cls, label] = map[status] || ['b-n', status];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  // ─── Table row renderer ───────────────────────────────────────────────────────

  function renderRow(t, i) {
    const handle = t.author_handle ? `@${t.author_handle}` : '—';
    const name   = t.author_name   || handle;
    const url    = t.tweet_url     || '#';

    const lph   = t.likes_per_hour;
    const accel = t.acceleration;

    const lphHtml = lph > 0
      ? `<span class="lph-val">+${fmt(lph)}/hr</span>`
      : `<span class="lph-zero">—</span>`;

    let accelHtml;
    if (accel > 0)       accelHtml = `<span class="accel-up">▲ +${fmt(accel)}</span>`;
    else if (accel < 0)  accelHtml = `<span class="accel-dn">▼ ${fmt(accel)}</span>`;
    else                 accelHtml = `<span class="accel-zero">—</span>`;

    const score    = Math.round(t.virality_score || 0);
    const barPct   = maxVScore > 0 ? Math.min(100, Math.round((score / maxVScore) * 100)) : 0;

    const engPct = t.engagement_rate > 0
      ? `${parseFloat(t.engagement_rate).toFixed(2)}%`
      : '—';

    const mediaTag = t.has_media
      ? `<span class="media-tag">${t.media_type || 'media'}</span> `
      : '';

    return `<tr onmouseenter="App.showPreview('${t.tweet_id}',this)" onmouseleave="App.startHidePreview()">
      <td class="rank">${i + 1}</td>
      <td class="author-cell">
        <div class="author-inner">
          <div class="avatar">${avatarLetter(t.author_handle)}</div>
          <div>
            <div class="author-name" title="${esc(name)}">${esc(name)}</div>
            <div class="author-handle">${esc(handle)}</div>
          </div>
        </div>
      </td>
      <td class="text-cell">
        <div class="tweet-text">${mediaTag}${esc(t.tweet_text || '')}</div>
      </td>
      <td class="num"><span class="num-big" style="color:var(--accent)">${fmt(t.likes)}</span></td>
      <td class="num"><span class="num-muted">${fmt(t.views)}</span></td>
      <td class="num"><span class="num-muted">${fmt(t.retweets)}</span></td>
      <td class="num">
        <span class="num-muted">${fmt(t.replies)}</span>
        ${t.bookmarks > 0 ? `<br><span style="color:var(--purple);font-size:10px">💾${fmt(t.bookmarks)}</span>` : ''}
      </td>
      <td class="num">${lphHtml}</td>
      <td class="num">${accelHtml}</td>
      <td class="num"><span class="num-muted">${engPct}</span></td>
      <td class="num vscore-cell">
        <div class="vscore-num">${fmt(score)}</div>
        <div class="vscore-bar-wrap"><div class="vscore-bar" style="width:${barPct}%"></div></div>
      </td>
      <td>${badge(t.status)}${isMemeCandidate(t) ? ' <span class="badge b-m">🎭 Meme</span>' : ''}</td>
      <td class="age-cell">${timeAgo(t.posted_at)}</td>
      <td class="action-cell">
        <button class="cbtn" onclick="App.openChart('${t.tweet_id}','${esc(handle)}','${esc(url)}')">Chart</button>
        <a class="cbtn open" href="${esc(url)}" target="_blank" rel="noreferrer">↗</a>
        <button class="cbtn block-btn" title="Blacklist ${esc(handle)}" onclick="App.blockHandle('${esc(t.author_handle)}')">🚫</button>
      </td>
    </tr>`;
  }

  // ─── Topic Radar ─────────────────────────────────────────────────────────────

  async function loadTopics() {
    try {
      const { topics, count } = await apiFetch('/api/topics');
      const subtitle = document.getElementById('radarSubtitle');
      if (subtitle) subtitle.textContent = `${count} active topic${count !== 1 ? 's' : ''} · last 48h`;
      renderTopicRadar(topics);
    } catch (err) {
      const grid = document.getElementById('radarGrid');
      if (grid) grid.innerHTML = `<span class="tc-loading" style="color:var(--red)">Topic Radar unavailable</span>`;
    }
  }

  function renderTopicRadar(topics) {
    const grid = document.getElementById('radarGrid');
    if (!grid) return;

    if (!topics || !topics.length) {
      grid.innerHTML = '<span class="tc-loading">No topic data yet — classification runs after the next fetch cycle.</span>';
      return;
    }

    grid.innerHTML = topics.map(t => {
      const statusClass = `tc-${t.hottest_status || 'normal'}`;
      const isActive    = activeTopicFilter === t.topic;
      const borderStyle = isActive ? 'outline:2px solid var(--accent)' : '';

      return `<div class="topic-card ${statusClass}"
                   style="${borderStyle}"
                   onclick="App.filterByTopic(${JSON.stringify(t.topic)})"
                   title="Click to filter tweets by ${esc(t.topic)}">
        <div class="tc-name">${esc(t.topic)}</div>
        <div class="tc-stats">
          <span class="tc-count">${fmt(t.tweet_count)} tweets</span>
          <span class="tc-vscore">${fmt(Math.round(t.avg_virality || 0))} avg V</span>
        </div>
        <div style="margin-top:5px">
          ${badge(t.hottest_status || 'normal')}
          ${t.top_tweet_url ? `<a href="${esc(t.top_tweet_url)}" target="_blank" rel="noreferrer"
              style="font-size:9px;color:var(--accent);text-decoration:none;margin-left:5px"
              onclick="event.stopPropagation()">↗ top</a>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function filterByTopic(topic) {
    if (activeTopicFilter === topic) {
      activeTopicFilter = null;
      showToast('Topic filter cleared', 'inf');
    } else {
      activeTopicFilter = topic;
      showToast(`Filtering by: ${topic}`, 'ok');
    }
    renderTopicRadar(null);   // re-render to show active state; loadTopics will refresh fully
    loadTopics();
    load();
  }

  function toggleRadar() {
    radarCollapsed = !radarCollapsed;
    const grid = document.getElementById('radarGrid');
    const icon = document.getElementById('radarToggleIcon');
    if (grid) grid.classList.toggle('collapsed', radarCollapsed);
    if (icon) icon.textContent = radarCollapsed ? '▼ show' : '▲ hide';
  }

  // ─── Stats header ─────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const { stats } = await apiFetch('/api/stats');
      document.getElementById('statTotal').textContent     = fmt(stats.total_tweets);
      document.getElementById('statParabolic').textContent = fmt(stats.parabolic_count);
      document.getElementById('statFast').textContent      = fmt(stats.fast_count);
      document.getElementById('statWarming').textContent   = fmt(stats.warming_count);
      document.getElementById('statMaxAccel').textContent  = fmt(stats.max_acceleration);

      const dot = document.getElementById('footDot');
      const footStatus = document.getElementById('footStatus');
      dot.className = 'dot';
      footStatus.textContent = 'Live';

      const t = stats.scheduler?.lastFetch || stats.last_updated;
      document.getElementById('footFetch').textContent = t ? `Last fetch: ${timeAgo(t)}` : '';

      if (stats.scheduler?.fetchRunning || stats.scheduler?.refreshRunning) {
        dot.className = 'dot busy';
        footStatus.textContent = 'Updating…';
      }

      return stats;
    } catch (err) {
      document.getElementById('footDot').className = 'dot';
      document.getElementById('footStatus').textContent = `API error: ${err.message}`;
      return null;
    }
  }

  // ─── Tab counts ──────────────────────────────────────────────────────────────

  function updateTabCounts(tweets) {
    const counts = { all: tweets.length, parabolic: 0, fast: 0, warming: 0, normal: 0, fading: 0 };
    for (const t of tweets) counts[t.status] = (counts[t.status] || 0) + 1;
    document.getElementById('tcAll').textContent       = counts.all;
    document.getElementById('tcParabolic').textContent = counts.parabolic;
    document.getElementById('tcFast').textContent      = counts.fast;
    document.getElementById('tcWarming').textContent   = counts.warming;
    document.getElementById('tcNormal').textContent    = counts.normal;
    document.getElementById('tcFading').textContent    = counts.fading;
  }

  // ─── Column sort highlight ────────────────────────────────────────────────────

  const sortThMap = { likes: 'th-likes', views: 'th-views', growth: 'th-growth', acceleration: 'th-accel', virality: 'th-vscore', engagement: 'th-eng', newest: 'th-time' };

  function highlightSort(sort, dir) {
    Object.entries(sortThMap).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('sort-active');
      // reset arrow to neutral
      el.dataset.arrow = '↕';
      el.textContent = el.dataset.label + ' ↕';
    });
    const activeId = sortThMap[sort];
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) {
        el.classList.add('sort-active');
        const arrow = dir === 'asc' ? '↑' : '↓';
        el.textContent = el.dataset.label + ' ' + arrow;
      }
    }
  }

  // ─── Diagnostic panel ────────────────────────────────────────────────────────

  function renderDiagnostic(stats) {
    const s = stats?.scheduler || {};
    const rows = [];

    if (s.fetchRunning) {
      rows.push(['Fetch status', '<span style="color:var(--orange)">⏳ Running now…</span>']);
    } else if (s.lastFetch) {
      rows.push(['Last fetch', `${timeAgo(s.lastFetch)} (${new Date(s.lastFetch).toLocaleTimeString()})`]);
      rows.push(['Tweets fetched', s.lastFetchCount != null ? `${s.lastFetchCount} upserted` : 'unknown']);
    } else {
      rows.push(['Last fetch', '<span style="color:var(--red)">Never ran — still starting up or crashed</span>']);
    }
    if (s.lastFetchError) rows.push(['Fetch error', `<span style="color:var(--red)">${esc(s.lastFetchError)}</span>`]);

    if (stats) {
      const allTime  = parseInt(stats.total_all_time, 10) || 0;
      const window48 = parseInt(stats.total_tweets,   10) || 0;
      if (allTime > 0 && window48 === 0) {
        rows.push(['DB (all time)', `${allTime} tweets — all older than 48 h`]);
      } else {
        rows.push(['DB (48 h)', `${window48} tweets`]);
        if (allTime > window48) rows.push(['DB (all time)', `${allTime} tweets`]);
      }
    }

    const tableRows = rows.map(([k, v]) =>
      `<tr><td style="color:var(--muted);padding:4px 12px 4px 0;white-space:nowrap">${k}</td><td>${v}</td></tr>`
    ).join('');

    return `<tr><td colspan="14"><div class="state-box">
      <p>No tweets found</p>
      <small>Filters may be too narrow, or data hasn't been fetched yet.</small>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px auto 0;max-width:460px;text-align:left">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:700;margin-bottom:8px">Diagnostics</div>
        <table style="font-size:11px;border-collapse:collapse;width:100%">${tableRows}</table>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:center">
        <button class="btn btn-primary" onclick="App.triggerRefresh('fetch')" style="font-size:11px;height:28px">Fetch New Tweets</button>
        <button class="btn btn-ghost"   onclick="App.load()"                 style="font-size:11px;height:28px">Retry</button>
      </div>
    </div></td></tr>`;
  }

  // ─── API helpers ─────────────────────────────────────────────────────────────

  async function apiFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function buildQuery() {
    const p = new URLSearchParams();
    const sort     = document.getElementById('filterSort').value;
    const media    = document.getElementById('filterMedia').value;
    const minLikes = document.getElementById('filterMinLikes').value.trim();
    const author   = document.getElementById('filterAuthor').value.trim();

    if (activeTab !== 'all') p.set('status', activeTab);
    if (sort) {
      // column-header clicks use activeSort+sortDir; dropdown already encodes direction
      const sortKey = sort.includes(':') ? sort : (sortDir === 'asc' ? `${sort}:asc` : sort);
      p.set('sort', sortKey);
    }
    if (media)    p.set('media', media);
    if (minLikes) p.set('min_likes', minLikes);
    if (author)             p.set('author',    author.replace(/^@/, ''));
    if (activeTopicFilter)  p.set('topic',     activeTopicFilter);
    p.set('limit', '1000');
    return p.toString();
  }

  // ─── Main load ───────────────────────────────────────────────────────────────

  async function load() {
    const sort = document.getElementById('filterSort').value;
    activeSort = sort.includes(':') ? sort.split(':')[0] : sort;
    if (!sort.includes(':')) {
      // direction managed by sortDir state (set by column clicks)
    } else {
      sortDir = sort.includes(':asc') ? 'asc' : 'desc';
    }
    highlightSort(activeSort, sortDir);

    const tbody = document.getElementById('feed');
    tbody.innerHTML = `<tr><td colspan="14"><div class="state-box"><div class="spinner"></div><p>Loading…</p></div></td></tr>`;

    try {
      let { tweets, count } = await apiFetch(`/api/tweets?${buildQuery()}`);
      if (englishOnly) tweets = tweets.filter(t => isLikelyEnglish(t.tweet_text));
      allTweets  = tweets;
      tweetsById = new Map(tweets.map(t => [t.tweet_id, t]));
      updateTabCounts(tweets);
      document.getElementById('footCount').textContent = `${tweets.length} tweets shown${englishOnly ? ' (EN only)' : ''}`;

      if (!tweets.length) {
        const stats = await loadStats();
        tbody.innerHTML = renderDiagnostic(stats);
        return;
      }

      maxVScore = Math.max(1, ...tweets.map(t => t.virality_score || 0));
      tbody.innerHTML = tweets.map(renderRow).join('');
    } catch (err) {
      const stats = await loadStats();
      tbody.innerHTML = `<tr><td colspan="14"><div class="state-box">
        <p style="color:var(--red)">⚠ Failed to load tweets</p>
        <small style="color:var(--red)">${esc(err.message)}</small>
      </div></td></tr>`;
      return;
    }

    loadStats();
  }

  // ─── Sort via column headers ──────────────────────────────────────────────────

  function setSortAndLoad(sort) {
    if (activeSort === sort) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';  // toggle direction
    } else {
      sortDir = 'desc';  // new column → default desc
    }
    activeSort = sort;
    const dropdownVal = sortDir === 'asc' ? `${sort}:asc` : sort;
    document.getElementById('filterSort').value = dropdownVal;
    load();
  }

  // ─── Tab switching ────────────────────────────────────────────────────────────

  function setTab(el, status) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    activeTab = status;
    load();
  }

  // ─── Search threshold ─────────────────────────────────────────────────────────

  async function loadConfig() {
    try {
      const { config } = await apiFetch('/api/config');
      if (config.minLikes)                  document.getElementById('searchMinLikes').value    = config.minLikes;
      if (config.minRetweets !== undefined) document.getElementById('searchMinRetweets').value = config.minRetweets;
      document.getElementById('filterMinLikes').value = config.minLikes || 10000;
    } catch (_) {}
  }

  async function applySearchThreshold() {
    const likes = parseInt(document.getElementById('searchMinLikes').value, 10);
    const rts   = parseInt(document.getElementById('searchMinRetweets').value, 10) || 0;
    if (!likes || likes < 1) { showToast('Enter a valid min_faves number', 'err'); return; }

    try {
      const res  = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minLikes: likes, minRetweets: rts }),
      });
      const data = await res.json();
      if (!data.ok) { showToast('Failed: ' + data.error, 'err'); return; }
      showToast(`Search: min_faves:${likes.toLocaleString()}${rts > 0 ? ` min_retweets:${rts}` : ''} — fetching…`, 'ok');
      document.getElementById('filterMinLikes').value = likes;
      await triggerRefresh('fetch');
    } catch (err) {
      showToast('Failed: ' + err.message, 'err');
    }
  }

  // ─── English-only toggle ─────────────────────────────────────────────────────

  function toggleEnglish() {
    englishOnly = !englishOnly;
    syncEnglishBtn();
    showToast(englishOnly ? 'English only (display filter)' : 'All languages shown', englishOnly ? 'ok' : 'inf');
    load();
  }

  // ─── Manual refresh ───────────────────────────────────────────────────────────

  async function triggerRefresh(type) {
    try {
      const res  = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      showToast(data.message || 'Job started', 'ok');
      setTimeout(load, 6000);
    } catch (err) {
      showToast('Failed: ' + err.message, 'err');
    }
  }

  // ─── Growth chart modal ───────────────────────────────────────────────────────

  async function openChart(tweetId, handle, url) {
    document.getElementById('modalTitle').textContent = `Growth — ${handle}`;
    document.getElementById('modalLink').href = url;
    document.getElementById('chartModal').classList.add('open');

    if (likesChart) { likesChart.destroy(); likesChart = null; }
    if (viewsChart) { viewsChart.destroy(); viewsChart = null; }

    try {
      const { history } = await apiFetch(`/api/tweets/${tweetId}/history`);
      if (!history.length) return;

      const labels = history.map(h => {
        const d = new Date(h.recorded_at);
        return d.toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      });

      const chartCfg = (label, data, color, bg) => ({
        type: 'line',
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: bg,
            tension: 0.4, pointRadius: 3, borderWidth: 2, fill: true }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, title: { display: true, text: label, color: '#64748b', font: { size: 11 } } },
          scales: {
            x: { ticks: { color: '#475569', maxTicksLimit: 6 }, grid: { color: '#1e2733' } },
            y: { ticks: { color: '#475569' }, grid: { color: '#1e2733' } },
          },
        },
      });

      likesChart = new Chart(document.getElementById('likesChart'),
        chartCfg('Likes over time', history.map(h => h.likes), '#3b82f6', 'rgba(59,130,246,.1)'));
      viewsChart = new Chart(document.getElementById('viewsChart'),
        chartCfg('Views over time', history.map(h => h.views), '#22c55e', 'rgba(34,197,94,.08)'));
    } catch (err) {
      console.error('Chart error', err);
    }
  }

  function closeModal(e) {
    if (e && e.target !== document.getElementById('chartModal')) return;
    document.getElementById('chartModal').classList.remove('open');
  }

  // ─── Blacklist ────────────────────────────────────────────────────────────────

  async function loadBlacklist() {
    try {
      const { blacklist: list } = await apiFetch('/api/blacklist');
      blacklist = new Set(list.map(r => r.handle.toLowerCase()));
    } catch (_) {}
  }

  async function blockHandle(handle) {
    const h = handle.replace(/^@/, '').toLowerCase();
    if (!h) return;
    try {
      await fetch('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: h }),
      });
      blacklist.add(h);
      showToast(`@${h} blacklisted`, 'ok');
      load();
      renderBlacklistModal();
    } catch (err) {
      showToast('Failed: ' + err.message, 'err');
    }
  }

  async function unblockHandle(handle) {
    const h = handle.replace(/^@/, '').toLowerCase();
    try {
      await fetch(`/api/blacklist/${encodeURIComponent(h)}`, { method: 'DELETE' });
      blacklist.delete(h);
      showToast(`@${h} removed from blacklist`, 'inf');
      load();
      renderBlacklistModal();
    } catch (err) {
      showToast('Failed: ' + err.message, 'err');
    }
  }

  function renderBlacklistModal() {
    const list = [...blacklist].sort();
    const el   = document.getElementById('blacklistBody');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:16px 0">No handles blacklisted yet.</p>';
      return;
    }
    el.innerHTML = list.map(h => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:13px;color:var(--fg)">@${esc(h)}</span>
        <button class="cbtn" onclick="App.unblockHandle('${esc(h)}')" style="color:var(--red);border-color:var(--red)">Remove</button>
      </div>`).join('');
  }

  function openBlacklist() {
    renderBlacklistModal();
    document.getElementById('blacklistModal').classList.add('open');
  }

  function closeBlacklist() {
    document.getElementById('blacklistModal').classList.remove('open');
  }

  async function addBlacklistFromInput() {
    const inp = document.getElementById('blacklistInput');
    const val = (inp?.value || '').trim();
    if (!val) return;
    await blockHandle(val);
    if (inp) inp.value = '';
  }

  // ─── Tweet Preview Popup ─────────────────────────────────────────────────────

  function showPreview(tweetId, rowEl) {
    clearTimeout(previewHideTimer);
    const t = tweetsById.get(tweetId);
    if (!t) return;

    const pv = document.getElementById('tweetPreview');

    // Populate content
    document.getElementById('pvAvatar').textContent = avatarLetter(t.author_handle);
    document.getElementById('pvName').textContent   = t.author_name || t.author_handle || '—';
    document.getElementById('pvHandle').textContent = t.author_handle ? `@${t.author_handle}` : '';
    document.getElementById('pvText').textContent   = t.tweet_text || '';
    document.getElementById('pvAge').textContent    = timeAgo(t.posted_at);
    document.getElementById('pvBadge').innerHTML    = badge(t.status) + (isMemeCandidate(t) ? ' <span class="badge b-m">🎭 Meme</span>' : '');
    const a = document.getElementById('pvOpen');
    a.href = t.tweet_url || '#';

    const stats = [
      ['❤️', fmt(t.likes)],
      ['🔁', fmt(t.retweets)],
      ['👁', fmt(t.views)],
      ['💬', fmt(t.replies)],
    ];
    if (t.bookmarks > 0) stats.push(['🔖', fmt(t.bookmarks)]);
    document.getElementById('pvStats').innerHTML = stats.map(
      ([icon, val]) => `<span>${icon} <span class="pv-sv">${val}</span></span>`
    ).join('');

    // Position: below row by default, above if near bottom
    const rect = rowEl.getBoundingClientRect();
    const pvW  = 340;
    const pvH  = pv.offsetHeight || 300;

    let left = rect.left + 160;
    let top  = rect.bottom + 6;
    if (top + pvH > window.innerHeight - 70) top = rect.top - pvH - 6;
    if (top < 70) top = 70;
    if (left + pvW > window.innerWidth - 8) left = window.innerWidth - pvW - 8;
    if (left < 8) left = 8;

    pv.style.left = left + 'px';
    pv.style.top  = top  + 'px';
    pv.classList.add('visible');
  }

  function startHidePreview() {
    previewHideTimer = setTimeout(hidePreview, 120);
  }

  function cancelHidePreview() {
    clearTimeout(previewHideTimer);
  }

  function hidePreview() {
    document.getElementById('tweetPreview')?.classList.remove('visible');
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────

  function showToast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    load();
    loadStats();
    loadTopics();
    loadConfig();
    loadBlacklist();
    autoTimer = setInterval(() => { load(); loadTopics(); }, 90_000);
    ['filterAuthor', 'filterMinLikes'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    });
    document.getElementById('blacklistInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') addBlacklistFromInput(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { load, setTab, setSortAndLoad, triggerRefresh, openChart, closeModal, applySearchThreshold, toggleEnglish, blockHandle, unblockHandle, openBlacklist, closeBlacklist, addBlacklistFromInput, filterByTopic, toggleRadar, showPreview, startHidePreview, cancelHidePreview, hidePreview };
})();
