/* global Chart */

const App = (() => {
  let activeTab    = 'all';
  let autoTimer    = null;
  let likesChart   = null;
  let viewsChart   = null;
  let allTweets    = [];   // cache for tab counts

  // ─── Formatters ────────────────────────────────────────────────────────────

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
    return (handle || '?').replace('@', '')[0] || '?';
  }

  // ─── Badge helpers ──────────────────────────────────────────────────────────

  function badgeClass(status) {
    return { parabolic: 'b-p', fast: 'b-f', warming: 'b-w', fading: 'b-d', normal: 'b-n' }[status] || 'b-n';
  }
  function badgeLabel(status) {
    return { parabolic: '🔥 Parabolic', fast: '⚡ Fast', warming: '🌡️ Warming', fading: '💀 Fading', normal: '✓ Normal' }[status] || status;
  }

  // ─── Card renderer ──────────────────────────────────────────────────────────

  function renderCard(t, i) {
    const handle  = t.author_handle ? `@${t.author_handle}` : '—';
    const name    = t.author_name   || handle;
    const url     = t.tweet_url     || '#';
    const lph     = t.likes_per_hour > 0 ? `+${fmt(t.likes_per_hour)}/hr` : null;
    const vph     = t.views_per_hour > 0 ? `+${fmt(t.views_per_hour)}/hr` : null;
    const accel   = t.acceleration;
    const accelStr = accel > 0 ? `▲ +${fmt(accel)}/hr²` : accel < 0 ? `▼ ${fmt(accel)}/hr²` : null;
    const accelColor = accel > 0 ? 'color:var(--green)' : 'color:var(--gray)';

    const mediaTag = t.has_media
      ? `<span class="media-tag">${t.media_type || 'media'}</span><br>`
      : '';

    const growthChips = `
      <div class="growth-chips">
        ${lph ? `<span class="gc">▲ ${lph} likes</span>` : ''}
        ${vph ? `<span class="gc v">▲ ${vph} views</span>` : ''}
        ${accelStr ? `<span class="gc" style="${accelColor};font-size:11px">${accelStr}</span>` : ''}
      </div>`;

    return `
      <div class="card ${t.status}" data-id="${t.tweet_id}">
        <div class="card-top">
          <div class="card-author">
            <div class="avatar">${avatarLetter(t.author_handle)}</div>
            <div>
              <div class="author-name">${esc(name)}</div>
              <div class="author-handle">${esc(handle)}</div>
            </div>
          </div>
          <span class="badge ${badgeClass(t.status)}">${badgeLabel(t.status)}</span>
        </div>

        <div class="card-text">${mediaTag}${esc(t.tweet_text || '')}</div>

        <div class="metrics">
          <div class="m hi"><div class="mv">${fmt(t.likes)}</div><div class="ml">Likes</div></div>
          <div class="m">   <div class="mv">${fmt(t.retweets)}</div><div class="ml">RTs</div></div>
          <div class="m">   <div class="mv">${fmt(t.replies)}</div><div class="ml">Replies</div></div>
          <div class="m">   <div class="mv">${fmt(t.views)}</div><div class="ml">Views</div></div>
        </div>

        <div class="growth-row">
          ${growthChips}
          <span>${timeAgo(t.posted_at)}</span>
        </div>

        <div class="card-foot">
          <div class="vscore">Score: <span>${fmt(Math.round(t.virality_score || 0))}</span></div>
          <div class="card-btns">
            <button class="cbtn" onclick="App.openChart('${t.tweet_id}','${esc(handle)}','${esc(url)}')">Chart</button>
            <a class="cbtn open" href="${esc(url)}" target="_blank" rel="noreferrer">Open ↗</a>
          </div>
        </div>
      </div>`;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

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
    } catch (_) {
      document.getElementById('footDot').className = 'dot';
      document.getElementById('footStatus').textContent = 'Offline';
    }
  }

  // ─── Tab counts ─────────────────────────────────────────────────────────────

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

  // ─── Main load ──────────────────────────────────────────────────────────────

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
    if (sort)     p.set('sort',      sort);
    if (media)    p.set('has_media', media);
    if (minLikes) p.set('min_likes', minLikes);
    if (author)   p.set('author',    author.replace(/^@/, ''));
    p.set('limit', '200');
    return p.toString();
  }

  async function load() {
    const feed = document.getElementById('feed');
    feed.innerHTML = '<div class="state-box"><div class="spinner"></div><p>Loading…</p></div>';

    try {
      const { tweets, count } = await apiFetch(`/api/tweets?${buildQuery()}`);
      allTweets = tweets;
      updateTabCounts(tweets);

      document.getElementById('footCount').textContent = `${count} tweets shown`;

      if (!tweets.length) {
        feed.innerHTML = `<div class="state-box">
          <p>No tweets found</p>
          <small>Try broadening your filters or click "Fetch New" to pull fresh data.</small>
        </div>`;
        return;
      }

      feed.innerHTML = tweets.map(renderCard).join('');
    } catch (err) {
      feed.innerHTML = `<div class="state-box">
        <p style="color:var(--red)">Failed to load tweets</p>
        <small>${err.message}</small>
      </div>`;
    }

    loadStats();
  }

  // ─── Tab switching ──────────────────────────────────────────────────────────

  function setTab(el, status) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    activeTab = status;
    load();
  }

  // ─── Manual refresh ─────────────────────────────────────────────────────────

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

  // ─── Growth chart modal ──────────────────────────────────────────────────────

  async function openChart(tweetId, handle, url) {
    document.getElementById('modalTitle').textContent = `Growth — ${handle}`;
    document.getElementById('modalLink').href = url;
    document.getElementById('chartModal').classList.add('open');

    if (likesChart) { likesChart.destroy(); likesChart = null; }
    if (viewsChart) { viewsChart.destroy(); viewsChart = null; }

    try {
      const { history } = await apiFetch(`/api/tweets/${tweetId}/history`);

      if (!history.length) {
        return;
      }

      const labels = history.map(h => {
        const d = new Date(h.recorded_at);
        return d.toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      });

      const chartCfg = (label, data, color, bg) => ({
        type: 'line',
        data: {
          labels,
          datasets: [{ label, data, borderColor: color, backgroundColor: bg,
            tension: 0.4, pointRadius: 3, borderWidth: 2, fill: true }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: label, color: '#64748b', font: { size: 12 } },
          },
          scales: {
            x: { ticks: { color: '#475569', maxTicksLimit: 6 }, grid: { color: '#1e2733' } },
            y: { ticks: { color: '#475569' }, grid: { color: '#1e2733' } },
          },
        },
      });

      likesChart = new Chart(
        document.getElementById('likesChart'),
        chartCfg('Likes over time', history.map(h => h.likes), '#3b82f6', 'rgba(59,130,246,.1)')
      );
      viewsChart = new Chart(
        document.getElementById('viewsChart'),
        chartCfg('Views over time', history.map(h => h.views), '#22c55e', 'rgba(34,197,94,.08)')
      );
    } catch (err) {
      console.error('Chart error', err);
    }
  }

  function closeModal(e) {
    if (e && e.target !== document.getElementById('chartModal')) return;
    document.getElementById('chartModal').classList.remove('open');
  }

  // ─── Toast ──────────────────────────────────────────────────────────────────

  function showToast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  function init() {
    load();
    loadStats();
    autoTimer = setInterval(load, 90_000);

    ['filterAuthor', 'filterMinLikes'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { load, setTab, triggerRefresh, openChart, closeModal };
})();
