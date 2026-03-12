/* global Chart */

const App = (() => {
  // ─── State ───────────────────────────────────────────────────────────────────
  let autoRefreshInterval = null;
  let likesChart = null;
  let viewsChart = null;

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function statusBadge(status) {
    const map = {
      parabolic: ['badge-parabolic', '🔥 Parabolic'],
      fast:      ['badge-fast',      '⚡ Fast'],
      normal:    ['badge-normal',    '✓ Normal'],
    };
    const [cls, label] = map[status] || map.normal;
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function showToast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  // ─── API calls ────────────────────────────────────────────────────────────────

  async function apiFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ─── Stats ────────────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const { stats } = await apiFetch('/api/stats');
      document.getElementById('statTotal').textContent     = fmt(stats.total_tweets);
      document.getElementById('statParabolic').textContent = fmt(stats.parabolic_count);
      document.getElementById('statFast').textContent      = fmt(stats.fast_count);
      document.getElementById('statMaxLikes').textContent  = fmt(stats.max_likes);
      document.getElementById('statMaxViews').textContent  = fmt(stats.max_views);

      const t = stats.scheduler?.lastFetch || stats.last_updated;
      document.getElementById('lastUpdated').textContent = t
        ? `Last updated: ${timeAgo(t)}`
        : 'Not yet updated';
    } catch (err) {
      console.error('loadStats error', err);
    }
  }

  // ─── Tweet table ──────────────────────────────────────────────────────────────

  function buildQuery() {
    const params = new URLSearchParams();
    const status   = document.getElementById('filterStatus').value;
    const sort     = document.getElementById('filterSort').value;
    const media    = document.getElementById('filterMedia').value;
    const minLikes = document.getElementById('filterMinLikes').value.trim();
    const author   = document.getElementById('filterAuthor').value.trim();

    if (status)   params.set('status',    status);
    if (sort)     params.set('sort',      sort);
    if (media)    params.set('has_media', media);
    if (minLikes) params.set('min_likes', minLikes);
    if (author)   params.set('author',    author.replace(/^@/, ''));
    params.set('limit', '200');

    return params.toString();
  }

  async function load() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '<tr><td colspan="12"><div class="empty-state"><div class="spinner"></div>Loading…</div></td></tr>';

    try {
      const qs = buildQuery();
      const { tweets } = await apiFetch(`/api/tweets?${qs}`);

      if (!tweets.length) {
        tbody.innerHTML = '<tr><td colspan="12"><div class="empty-state">No tweets found matching your filters.</div></td></tr>';
        return;
      }

      tbody.innerHTML = tweets.map((t, i) => {
        const handle = t.author_handle ? `@${t.author_handle}` : '—';
        const url    = t.tweet_url || '#';
        const text   = t.tweet_text
          ? t.tweet_text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
          : '';
        const mediaBadge = t.has_media
          ? `<span class="media-badge">${t.media_type || 'media'}</span> `
          : '';

        const lph = t.likes_per_hour ? `+${fmt(t.likes_per_hour)}/hr` : '—';
        const vph = t.views_per_hour ? `+${fmt(t.views_per_hour)}/hr` : '—';

        return `
          <tr>
            <td class="num muted" style="color:var(--muted)">${i + 1}</td>
            <td class="tweet-cell">
              <div class="tweet-author">${handle}</div>
              <div class="tweet-text">${mediaBadge}${text}</div>
              <a class="tweet-link" href="${url}" target="_blank" rel="noreferrer">Open on X ↗</a>
            </td>
            <td>${statusBadge(t.status)}</td>
            <td class="num">${fmt(t.likes)}</td>
            <td class="num">${fmt(t.retweets)}</td>
            <td class="num">${fmt(t.replies)}</td>
            <td class="num">${fmt(t.views)}</td>
            <td class="num growth">${lph}</td>
            <td class="num growth">${vph}</td>
            <td class="num">${fmt(Math.round(t.virality_score))}</td>
            <td style="color:var(--muted);font-size:12px;white-space:nowrap">${timeAgo(t.posted_at)}</td>
            <td>
              <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px"
                      onclick="App.openChart('${t.tweet_id}','${handle}','${url}')">
                Chart
              </button>
            </td>
          </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state" style="color:var(--red)">Error: ${err.message}</div></td></tr>`;
    }

    await loadStats();
  }

  function reset() {
    document.getElementById('filterStatus').value   = 'all';
    document.getElementById('filterSort').value     = 'likes';
    document.getElementById('filterMedia').value    = '';
    document.getElementById('filterMinLikes').value = '15000';
    document.getElementById('filterAuthor').value   = '';
    load();
  }

  // ─── Manual refresh trigger ───────────────────────────────────────────────────

  async function triggerRefresh(type) {
    try {
      const res = await fetch('/api/refresh', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type }),
      });
      const data = await res.json();
      showToast(data.message || 'Job started', 'success');
      // Reload data after a short delay to catch early results
      setTimeout(load, 5000);
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    }
  }

  // ─── Growth chart modal ───────────────────────────────────────────────────────

  async function openChart(tweetId, handle, url) {
    document.getElementById('modalTitle').textContent = `Growth — ${handle}`;
    document.getElementById('modalLink').href = url;
    document.getElementById('chartModal').classList.add('open');

    // Destroy previous chart instances
    if (likesChart) { likesChart.destroy(); likesChart = null; }
    if (viewsChart) { viewsChart.destroy(); viewsChart = null; }

    try {
      const { history } = await apiFetch(`/api/tweets/${tweetId}/history`);

      const labels = history.map(h => {
        const d = new Date(h.recorded_at);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      });
      const likes = history.map(h => h.likes);
      const views = history.map(h => h.views);

      const chartDefaults = {
        tension: 0.4,
        pointRadius: 3,
        borderWidth: 2,
        fill: true,
      };

      likesChart = new Chart(document.getElementById('likesChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            ...chartDefaults,
            label: 'Likes',
            data: likes,
            borderColor: '#1d9bf0',
            backgroundColor: 'rgba(29,155,240,.1)',
          }],
        },
        options: chartOptions('Likes over time'),
      });

      viewsChart = new Chart(document.getElementById('viewsChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            ...chartDefaults,
            label: 'Views',
            data: views,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,.08)',
          }],
        },
        options: chartOptions('Views over time'),
      });
    } catch (err) {
      console.error('Chart error', err);
    }
  }

  function chartOptions(title) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: title,
          color: '#777',
          font: { size: 12 },
        },
      },
      scales: {
        x: { ticks: { color: '#555', maxTicksLimit: 8 }, grid: { color: '#1e1e1e' } },
        y: { ticks: { color: '#555' }, grid: { color: '#1e1e1e' } },
      },
    };
  }

  function closeModal(e) {
    // If called from backdrop click, only close when clicking the backdrop itself
    if (e && e.target !== document.getElementById('chartModal')) return;
    document.getElementById('chartModal').classList.remove('open');
  }

  // ─── Auto-refresh every 90 seconds ───────────────────────────────────────────

  function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(load, 90_000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    load();
    loadStats();
    startAutoRefresh();

    // Apply on Enter in text/number fields
    ['filterAuthor', 'filterMinLikes'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') load();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { load, reset, triggerRefresh, openChart, closeModal };
})();
