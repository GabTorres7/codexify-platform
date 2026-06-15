/* ================================================
   Codexify AI - Main Application
   ================================================ */

(function () {
    'use strict';

    // ── API ──────────────────────────────────────────────────
    const API = 'https://codexify-1bud.onrender.com/api/v1';
    let TOKEN = '';
    let ORG_ID = '';

    function syncTokens() {
        TOKEN = localStorage.getItem('cg_token') || localStorage.getItem('cx_token') || '';
        ORG_ID = localStorage.getItem('cg_org_id') || '';
    }
    syncTokens();

    function hdrs() {
        syncTokens();
        return { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) };
    }
    async function api(method, path, body, timeout) {
        syncTokens();
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), timeout || 30000);
        try {
            let r = await fetch(API + path, { method, headers: hdrs(), signal: ctrl.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (r.status === 204) return null;

            if (r.status === 401 && window.CodexfyRefreshToken) {
                const refreshed = await window.CodexfyRefreshToken();
                if (refreshed) {
                    syncTokens();
                    r = await fetch(API + path, { method, headers: hdrs(), signal: ctrl.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
                    if (r.status === 204) return null;
                } else {
                    if (window.CodexfyForceLogout) window.CodexfyForceLogout();
                    throw { message: 'Sessão expirada. Faça login novamente.' };
                }
            }

            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw d;
            return d;
        } catch (e) {
            if (e.name === 'AbortError') throw { message: 'Servidor demorou para responder. Tente novamente.' };
            throw e;
        } finally { clearTimeout(tm); }
    }
    async function ensureAuth() {
        syncTokens();
        if (TOKEN && ORG_ID) return true;
        // Try to decode org_id from existing token
        if (TOKEN && !ORG_ID) {
            try {
                const payload = JSON.parse(atob(TOKEN.split('.')[1]));
                if (payload.org_id) { ORG_ID = payload.org_id; localStorage.setItem('cg_org_id', ORG_ID); return true; }
            } catch(_){}
        }
        return false;
    }

    // ── Current user role ───────────────────────────────────
    // Default to admin so existing users see everything.
    // The /me endpoint will downgrade to 'member' if needed.
    let currentUserRole = 'admin';
    let currentUserId = '';
    let roleLoaded = false;

    async function loadMyRole() {
        try {
            const authed = await ensureAuth();
            if (!authed || !ORG_ID) return;
            const me = await api('GET', `/orgs/${ORG_ID}/me`);
            currentUserRole = me.role || 'admin';
            currentUserId = me.id || '';
        } catch (_) {
            currentUserRole = 'admin';
        }
        roleLoaded = true;
        applyRoleRestrictions();
    }

    function isAdmin() { return currentUserRole === 'admin'; }

    function applyRoleRestrictions() {
        // Hide admin-only nav items for regular members
        const adminPages = ['team', 'settings', 'billing', 'rules'];
        document.querySelectorAll('.nav-item').forEach(item => {
            const page = item.dataset.page;
            if (adminPages.includes(page)) {
                item.style.display = isAdmin() ? '' : 'none';
            }
        });
        // Re-render current page to apply button restrictions
        if (roleLoaded) renderPage();
    }

    // Load role on startup
    (async () => { await loadMyRole(); })();

    // ── Cached data ─────────────────────────────────────────
    let cachedRepos = [];
    let cachedMRs = [];
    let useMockData = false;

    function getMockMRs() {
        if (typeof MERGE_REQUESTS !== 'undefined') return MERGE_REQUESTS;
        return [];
    }

    async function loadAllMRs() {
        const authed = await ensureAuth();
        if (authed && ORG_ID) {
            try {
                const repos = await api('GET', `/orgs/${ORG_ID}/repos`);
                cachedRepos = repos || [];
                const results = await Promise.allSettled(
                    cachedRepos.map(repo =>
                        api('GET', `/orgs/${ORG_ID}/repos/${repo.id}/mrs?limit=100`).then(resp => {
                            const items = resp.items || resp || [];
                            items.forEach(mr => { mr._repo_id = repo.id; mr._repo_name = repo.full_name; });
                            return items;
                        })
                    )
                );
                const allMrs = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
                if (allMrs.length) { cachedMRs = allMrs; useMockData = false; return allMrs; }
            } catch (_) {}
        }
        useMockData = true;
        cachedMRs = getMockMRs();
        return cachedMRs;
    }

    function normalizeMR(mr) {
        const authorName = mr.author_name || mr.author_username || (mr.author && mr.author.name) || 'Desconhecido';
        const initials = (mr.author && mr.author.initials) || authorName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        const color = (mr.author && mr.author.color) || '#818cf8';
        return {
            id: mr.id,
            title: mr.title,
            branch: mr.branch || mr.source_branch || '',
            targetBranch: mr.target_branch || mr.targetBranch || 'main',
            author: { name: authorName, initials, color },
            status: mr.status || 'pending',
            aiScore: mr.ai_score != null ? mr.ai_score : (mr.aiScore != null ? mr.aiScore : null),
            createdAt: mr.created_at || mr.createdAt || new Date().toISOString(),
            filesChanged: mr.files_changed || mr.filesChanged || 0,
            additions: mr.additions || 0,
            deletions: mr.deletions || 0,
            comments: mr.comments || 0,
            description: mr.description || '',
            platformUrl: mr.platform_url || mr.platformUrl || '',
            files: mr.files || [],
            diff: mr.diff || [],
            issues: mr.issues || [],
            analysisCategories: mr.analysis_categories || mr.analysisCategories || null,
            rules: mr.rules || [],
            _repo_id: mr._repo_id,
            _repo_name: mr._repo_name,
        };
    }

    // ── State ────────────────────────────────────────────────
    let currentPage = 'dashboard';
    let currentMR = null;
    let currentTab = 'overview';

    // ── DOM ──────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const pageContent = $('pageContent');
    const modalOverlay = $('modalOverlay');
    const modalBody = $('modalBody');
    const modalTitle = $('modalTitle');
    const modalSubtitle = $('modalSubtitle');
    const sidebar = $('sidebar');
    const searchInput = $('searchInput');
    const actionOverlay = $('actionModalOverlay');
    const actionBody = $('actionModalBody');
    const actionTitle = $('actionModalTitle');

    // ── Navigation ───────────────────────────────────────────
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page === currentPage) return;
            currentPage = page;
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            renderPage();
            sidebar.classList.remove('open');
        });
    });

    $('menuToggle').addEventListener('click', () => sidebar.classList.toggle('open'));
    $('modalClose').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
    $('actionModalClose').addEventListener('click', closeActionModal);
    actionOverlay.addEventListener('click', e => { if (e.target === actionOverlay) closeActionModal(); });

    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            currentTab = tab.dataset.tab;
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderTabContent();
        });
    });

    searchInput.addEventListener('input', e => {
        if (currentPage === 'dashboard' || currentPage === 'merge-requests') renderPage(e.target.value.toLowerCase());
    });

    // ── Helpers ──────────────────────────────────────────────
    function openActionModal(title, html) {
        actionTitle.textContent = title;
        actionBody.innerHTML = html;
        actionOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
    let closeActionModal = () => { actionOverlay.classList.remove('active'); document.body.style.overflow = ''; };

    let _onModalClose = null;
    function closeModal() {
        modalOverlay.classList.remove('active'); document.body.style.overflow = ''; currentMR = null;
        if (_onModalClose) { const cb = _onModalClose; _onModalClose = null; cb(); }
    }

    function confirmAction(title, message) {
        return new Promise(resolve => {
            let settled = false;
            const baseClose = closeActionModal;
            closeActionModal = () => {
                baseClose();
                closeActionModal = baseClose;
                if (!settled) { settled = true; resolve(false); }
            };
            openActionModal(title, `
                <div style="padding:8px 0">
                    <p style="color:var(--text-secondary);font-size:0.95rem;line-height:1.6;margin-bottom:24px">${message}</p>
                    <div class="form-actions">
                        <button class="btn btn-secondary" id="confirmCancel">Cancelar</button>
                        <button class="btn" id="confirmOk" style="background:var(--accent-danger);color:#fff;border:none">Confirmar</button>
                    </div>
                </div>
            `);
            $('confirmCancel').addEventListener('click', () => closeActionModal());
            $('confirmOk').addEventListener('click', () => { settled = true; closeActionModal(); resolve(true); });
        });
    }

    function toast(msg, type) {
        const t = document.createElement('div');
        t.className = 'toast toast-' + (type || 'success');
        t.innerHTML = `<span>${msg}</span><div class="toast-progress"></div>`;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
    }

    function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

    // Lucide icon helper
    function icon(name, size) {
        const s = size || 18;
        return `<i data-lucide="${name}" style="width:${s}px;height:${s}px;display:inline-block;vertical-align:middle"></i>`;
    }
    let _iconTimer = null;
    function refreshIcons() { if (!window.lucide) return; clearTimeout(_iconTimer); _iconTimer = setTimeout(() => lucide.createIcons(), 100); }

    function formRow(label, desc, inputHtml) {
        return `<div class="form-row"><div class="form-row-info"><h4>${label}</h4>${desc ? '<p>' + desc + '</p>' : ''}</div><div class="form-row-input">${inputHtml}</div></div>`;
    }

    function showLoading() {
        return `<div class="skeleton-container">
            <div class="skeleton-card"><div class="skeleton-line w60"></div><div class="skeleton-line w80"></div><div class="skeleton-line w40"></div></div>
            <div class="skeleton-card"><div class="skeleton-line w80"></div><div class="skeleton-line w60"></div></div>
        </div>`;
    }

    // ── Router ───────────────────────────────────────────────
    function renderPage(q) {
        const r = {
            dashboard: () => renderDashboard(q),
            'merge-requests': () => renderMergeRequests(q),
            repositories: renderReposPage,
            team: renderTeamPage,
            rules: renderRulesPage,
            settings: renderSettingsPage,
            logs: renderLogsPage,
            upload: renderUploadPage,
            analytics: renderAnalyticsPage,
            billing: renderBillingPage,
        };
        pageContent.style.animation = 'none';
        pageContent.offsetHeight;
        pageContent.style.animation = 'fadeIn 0.15s ease';
        (r[currentPage] || r.dashboard)();
        refreshIcons();
    }

    // ================================================================
    //  DASHBOARD
    // ================================================================
    let dashMRs = [];
    let dashPage = 1;
    const DASH_PER_PAGE = 10;

    async function renderDashboard(q) {
        const today = new Date().toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

        pageContent.innerHTML = `
            <div class="page-header-row">
                <div>
                    <h1 class="page-title">Dashboard</h1>
                    <p class="page-subtitle">Visão geral das análises de merge requests — Codexify AI</p>
                </div>
                <div class="page-actions" style="display:flex;gap:8px;align-items:center">
                    <div style="position:relative;display:flex;align-items:center">
                        <span style="position:absolute;left:10px;color:var(--text-tertiary);pointer-events:none">${icon('search', 15)}</span>
                        <input class="input" id="dashSearch" type="text" placeholder="Buscar..." value="${q ? esc(q) : ''}" style="padding-left:34px;width:180px;height:36px;font-size:0.85rem">
                    </div>
                    <button class="btn btn-secondary" id="dashFilterToggle" style="position:relative">${icon('sliders-horizontal', 16)} Filtros</button>
                    <button class="btn btn-secondary" id="exportCsvBtn">${icon('download', 16)} CSV</button>
                </div>
            </div>

            <!-- Filtros dropdown -->
            <div class="dash-filter-panel" id="dashFilterPanel">
                <!-- Presets -->
                <div class="filter-presets">
                    <button class="filter-preset-btn active" data-preset="7d">${icon('zap', 13)} 7 dias</button>
                    <button class="filter-preset-btn" data-preset="30d">${icon('calendar', 13)} 30 dias</button>
                    <button class="filter-preset-btn" data-preset="critical">${icon('alert-triangle', 13)} Críticos</button>
                    <button class="filter-preset-btn" data-preset="approved">${icon('check-circle', 13)} Aprovados</button>
                </div>
                <!-- Row 1: Datas -->
                <div class="filter-row">
                    <div class="filter-input-wrap">
                        <span class="filter-input-icon">${icon('calendar', 14)}</span>
                        <input class="input filter-input" id="dashDateFrom" type="date" value="${weekAgo}">
                        <span class="filter-input-hint">De</span>
                    </div>
                    <div class="filter-input-wrap">
                        <span class="filter-input-icon">${icon('calendar', 14)}</span>
                        <input class="input filter-input" id="dashDateTo" type="date" value="${today}">
                        <span class="filter-input-hint">Até</span>
                    </div>
                </div>
                <!-- Row 2: Dropdowns -->
                <div class="filter-row">
                    <div class="filter-input-wrap">
                        <span class="filter-input-icon">${icon('activity', 14)}</span>
                        <select class="input filter-input" id="dashFilterStatus">
                            <option value="all">Status: Todos</option>
                            <option value="approved">Aprovado</option>
                            <option value="pending">Pendente</option>
                            <option value="issues">Issues</option>
                            <option value="analyzing">Analisando</option>
                            <option value="merged">Merged</option>
                        </select>
                    </div>
                    <div class="filter-input-wrap">
                        <span class="filter-input-icon">${icon('star', 14)}</span>
                        <select class="input filter-input" id="dashFilterScore">
                            <option value="all">Score: Todos</option>
                            <option value="high">65+ Verde</option>
                            <option value="medium">50-64 Amarelo</option>
                            <option value="low">0-49 Vermelho</option>
                        </select>
                    </div>
                    <div class="filter-input-wrap">
                        <span class="filter-input-icon">${icon('user', 14)}</span>
                        <select class="input filter-input" id="dashFilterAuthor">
                            <option value="all">Autor: Todos</option>
                        </select>
                    </div>
                </div>
                <!-- Actions -->
                <div class="filter-actions">
                    <button class="btn btn-ghost btn-sm" id="dashClearFilter">${icon('x', 14)} Limpar</button>
                    <button class="btn btn-primary btn-sm" id="dashApplyFilter">${icon('check', 14)} Aplicar Filtros</button>
                </div>
            </div>
            <!-- Chips de filtros ativos -->
            <div id="dashFilterChips" class="filter-chips"></div>

            <!-- Metrics -->
            <div class="metrics-grid" id="metricsGrid" style="margin-top:16px">
                ${metricCard('purple', icon('clock', 20), '...', 'MRs Pendentes', '', 0)}
                ${metricCard('green', icon('check-circle', 20), '...', 'Aprovados / Merged', '', 0.1)}
                ${metricCard('red', icon('alert-triangle', 20), '...', 'Com Problemas', '', 0.2)}
                ${metricCard('yellow', icon('star', 20), '...', 'Score Médio IA', '', 0.3)}
            </div>

            <!-- Quick Actions (acima dos gráficos) -->
            <div class="qa-row stagger-in" style="animation-delay:0.05s">
                <button class="qa-card" id="qaBtnAddRepo">
                    <div class="qa-card-icon" style="background:rgba(129,140,248,0.1);color:#818cf8">${icon('folder-git-2', 20)}</div>
                    <span>Adicionar Repo</span>
                </button>
                <button class="qa-card" id="qaBtnInvite">
                    <div class="qa-card-icon" style="background:rgba(52,211,153,0.1);color:var(--accent-success)">${icon('user-plus', 20)}</div>
                    <span>Convidar Membro</span>
                </button>
                <button class="qa-card" id="qaBtnBulk">
                    <div class="qa-card-icon" style="background:rgba(251,191,36,0.1);color:var(--accent-warning)">${icon('sparkles', 20)}</div>
                    <span>Análise Rápida</span>
                </button>
                <button class="qa-card" id="qaBtnExport">
                    <div class="qa-card-icon" style="background:rgba(248,113,113,0.1);color:var(--accent-danger)">${icon('download', 20)}</div>
                    <span>Exportar CSV</span>
                </button>
            </div>

            <!-- Atividade + Score + Atividade Recente -->
            <div class="dash-bottom-grid">
                <div class="card stagger-in" style="animation-delay:0.1s">
                    <div class="card-header">
                        <span class="card-title">${icon('bar-chart-2', 16)} Atividade</span>
                        <span class="card-badge" id="chartPeriodLabel">Últimos 7 dias</span>
                    </div>
                    <div class="card-body" style="padding:16px">
                        <div class="chart-container" id="chartContainer">Carregando...</div>
                        <div id="scoreDistChart" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color)">Carregando...</div>
                    </div>
                </div>
                <div class="card stagger-in" style="animation-delay:0.12s">
                    <div class="card-header"><span class="card-title">${icon('activity', 16)} Atividade Recente</span></div>
                    <div class="card-body" style="padding:0;max-height:320px;overflow-y:auto"><div class="activity-list" id="activityList">Carregando...</div></div>
                </div>
            </div>

            <!-- MR Table -->
            <div class="card stagger-in" style="animation-delay:0.15s">
                <div class="card-header"><span class="card-title">${icon('git-pull-request', 16)} Merge Requests</span><span class="card-badge" id="mrCountBadge">...</span></div>
                <div class="mr-table-container" id="mrTableContainer">Carregando...</div>
                <div id="dashPagination"></div>
            </div>`;

        $('qaBtnAddRepo').addEventListener('click', openAddRepoModal);
        $('qaBtnInvite').addEventListener('click', openInviteMemberModal);
        $('qaBtnBulk').addEventListener('click', () => { document.querySelector('[data-page="merge-requests"]').click(); setTimeout(openBulkAddModal, 300); });
        $('qaBtnExport').addEventListener('click', () => { const mrs = cachedMRs.map(normalizeMR); AnalysisEngine.exportCSV(mrs); toast('CSV exportado!'); });
        $('exportCsvBtn').addEventListener('click', () => { const mrs = cachedMRs.map(normalizeMR); AnalysisEngine.exportCSV(mrs); toast('CSV exportado!'); });

        // Filter toggle
        $('dashFilterToggle').addEventListener('click', () => {
            $('dashFilterPanel').classList.toggle('open');
        });
        $('dashSearch').addEventListener('input', () => { dashPage = 1; renderDashMRs(); });
        $('dashApplyFilter').addEventListener('click', () => { dashFiltersChanged = true; dashPage = 1; renderDashMRs(); $('dashFilterPanel').classList.remove('open'); renderDashChips(); });
        $('dashClearFilter').addEventListener('click', () => {
            $('dashDateFrom').value = weekAgo; $('dashDateTo').value = today;
            $('dashFilterStatus').value = 'all'; $('dashFilterScore').value = 'all'; $('dashFilterAuthor').value = 'all';
            dashFiltersChanged = false; dashPage = 1; renderDashMRs(); renderDashChips(); reloadApiChart();
            document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
        });
        // Presets
        document.querySelectorAll('.filter-preset-btn').forEach(btn => btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const p = btn.dataset.preset;
            const now = new Date(), fmt = d => d.toISOString().slice(0,10);
            if (p === '7d') { $('dashDateFrom').value = fmt(new Date(now - 7*86400000)); $('dashDateTo').value = fmt(now); $('dashFilterStatus').value = 'all'; $('dashFilterScore').value = 'all'; }
            else if (p === '30d') { $('dashDateFrom').value = fmt(new Date(now - 30*86400000)); $('dashDateTo').value = fmt(now); $('dashFilterStatus').value = 'all'; $('dashFilterScore').value = 'all'; }
            else if (p === 'critical') { $('dashFilterScore').value = 'low'; $('dashFilterStatus').value = 'all'; }
            else if (p === 'approved') { $('dashFilterStatus').value = 'approved'; $('dashFilterScore').value = 'all'; }
            dashFiltersChanged = true; dashPage = 1; renderDashMRs(); renderDashChips();
        }));

        await ensureAuth();

        // Parallel fetch: metrics + chart + activity + MRs — tudo de uma vez
        const [metricsRes, chartRes, activityRes, mrsRes] = await Promise.allSettled([
            api('GET', `/orgs/${ORG_ID}/dashboard/metrics`),
            api('GET', `/orgs/${ORG_ID}/dashboard/chart`),
            api('GET', `/orgs/${ORG_ID}/dashboard/activity?limit=10`),
            loadAllMRs(),
        ]);

        // Metrics
        if (metricsRes.status === 'fulfilled') {
            const metrics = metricsRes.value;
            $('metricsGrid').innerHTML = `
                ${metricCard('purple', icon('clock', 20), metrics.pending + (metrics.analyzing || 0), 'MRs Pendentes', '', 0)}
                ${metricCard('green', icon('check-circle', 20), metrics.approved + (metrics.merged || 0), 'Aprovados / Merged', '', 0.05)}
                ${metricCard('red', icon('alert-triangle', 20), metrics.issues, 'Com Problemas', '', 0.1)}
                ${metricCard('yellow', icon('star', 20), metrics.avg_score + '<span style="font-size:1rem;color:var(--text-tertiary)">/100</span>', 'Score Médio IA', '', 0.15)}
            `;
        } else if (typeof MERGE_REQUESTS !== 'undefined') {
            const metrics = AnalysisEngine.getMetrics(MERGE_REQUESTS);
            $('metricsGrid').innerHTML = `
                ${metricCard('purple', icon('clock', 20), metrics.pending, 'MRs Pendentes', '', 0)}
                ${metricCard('green', icon('check-circle', 20), metrics.approved, 'Aprovados / Merged', '', 0.05)}
                ${metricCard('red', icon('alert-triangle', 20), metrics.withIssues, 'Com Problemas', '', 0.1)}
                ${metricCard('yellow', icon('star', 20), metrics.avgScore + '<span style="font-size:1rem;color:var(--text-tertiary)">/100</span>', 'Score Médio IA', '', 0.15)}
            `;
        }

        // Chart
        if (chartRes.status === 'fulfilled' && chartRes.value && chartRes.value.length) {
            const chartData = chartRes.value;
            const max = Math.max(...chartData.map(d => d.opened || d.value || 1));
            const dayPt = {Mon:'Seg',Tue:'Ter',Wed:'Qua',Thu:'Qui',Fri:'Sex',Sat:'Sáb',Sun:'Dom'};
            const dayFull = {Mon:'Segunda',Tue:'Terça',Wed:'Quarta',Thu:'Quinta',Fri:'Sexta',Sat:'Sábado',Sun:'Domingo'};
            $('chartContainer').innerHTML = chartData.map(d => { const lbl = d.day || d.label; const val = d.opened || d.value || 0; return `<div class="chart-bar-group"><div class="chart-bar" style="height:${(val/Math.max(max,1))*150}px"></div><div class="chart-bar-tooltip"><span class="tt-day">${dayFull[lbl] || lbl}</span><br>${val} MR${val !== 1 ? 's' : ''}</div><span class="chart-label">${dayPt[lbl] || lbl}</span></div>`; }).join('');
        }

        // Activity
        if (activityRes.status === 'fulfilled') {
            const activity = activityRes.value;
            if (activity && activity.length) {
                $('activityList').innerHTML = activity.map(a => {
                    const typeClass = a.event_type === 'analysis_completed' ? 'success' : a.event_type === 'mr_rejected' ? 'danger' : 'info';
                    const time = AnalysisEngine.timeAgo(a.created_at);
                    return `<div class="activity-item"><div class="activity-dot ${typeClass}"></div><div class="activity-info"><div class="activity-text">${esc(a.description)}</div><div class="activity-time">${time}</div></div></div>`;
                }).join('');
            } else {
                $('activityList').innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">Nenhuma atividade recente</div>';
            }
        } else if (typeof RECENT_ACTIVITY !== 'undefined') {
            $('activityList').innerHTML = RECENT_ACTIVITY.map(a => `<div class="activity-item"><div class="activity-dot ${a.type}"></div><div class="activity-info"><div class="activity-text">${a.text}</div><div class="activity-time">${a.time}</div></div></div>`).join('');
        }

        // MR Table with filters (já carregado em paralelo)
        if (mrsRes.status === 'fulfilled' && mrsRes.value && mrsRes.value.length) {
            dashMRs = mrsRes.value.map(normalizeMR);
        } else {
            dashMRs = typeof MERGE_REQUESTS !== 'undefined' ? MERGE_REQUESTS : [];
        }

        // Populate author filter
        const dashAuthors = [...new Set(dashMRs.map(m => m.author.name))].sort();
        const dashAuthorSel = $('dashFilterAuthor');
        dashAuthors.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; dashAuthorSel.appendChild(o); });

        dashPage = 1;
        renderDashMRs();

        refreshIcons();
    }

    function renderDashChips() {
        const chips = [];
        const s = $('dashFilterStatus'); if (s && s.value !== 'all') chips.push({ label: 'Status: ' + s.options[s.selectedIndex].text, clear: () => { s.value = 'all'; } });
        const sc = $('dashFilterScore'); if (sc && sc.value !== 'all') chips.push({ label: 'Score: ' + sc.options[sc.selectedIndex].text, clear: () => { sc.value = 'all'; } });
        const au = $('dashFilterAuthor'); if (au && au.value !== 'all') chips.push({ label: 'Autor: ' + au.value, clear: () => { au.value = 'all'; } });
        const el = $('dashFilterChips');
        if (!el) return;
        if (!chips.length) { el.innerHTML = ''; return; }
        el.innerHTML = chips.map((c, i) => `<span class="filter-chip">${esc(c.label)} <button data-chip="${i}">${icon('x', 12)}</button></span>`).join('');
        el.querySelectorAll('[data-chip]').forEach(btn => btn.addEventListener('click', () => {
            chips[+btn.dataset.chip].clear();
            dashPage = 1; renderDashMRs(); renderDashChips();
        }));
    }

    function renderDashMRs() {
        const q = ($('dashSearch') ? $('dashSearch').value : '').toLowerCase();
        const dateFrom = $('dashDateFrom') ? $('dashDateFrom').value : '';
        const dateTo = $('dashDateTo') ? $('dashDateTo').value : '';
        const status = $('dashFilterStatus') ? $('dashFilterStatus').value : 'all';
        const score = $('dashFilterScore') ? $('dashFilterScore').value : 'all';
        const author = $('dashFilterAuthor') ? $('dashFilterAuthor').value : 'all';

        let filtered = dashMRs;
        if (q) filtered = filtered.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q));
        if (dateFrom) filtered = filtered.filter(m => m.createdAt && m.createdAt.slice(0, 10) >= dateFrom);
        if (dateTo) filtered = filtered.filter(m => m.createdAt && m.createdAt.slice(0, 10) <= dateTo);
        if (status !== 'all') filtered = filtered.filter(m => m.status === status);
        if (score === 'high') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore >= 65);
        else if (score === 'medium') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore >= 50 && m.aiScore < 65);
        else if (score === 'low') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore < 50);
        if (author !== 'all') filtered = filtered.filter(m => m.author.name === author);

        const totalPages = Math.max(1, Math.ceil(filtered.length / DASH_PER_PAGE));
        if (dashPage > totalPages) dashPage = totalPages;
        const start = (dashPage - 1) * DASH_PER_PAGE;
        const pageMRs = filtered.slice(start, start + DASH_PER_PAGE);

        // Update metrics from filtered data
        const pending = filtered.filter(m => m.status === 'pending' || m.status === 'analyzing').length;
        const approved = filtered.filter(m => m.status === 'approved' || m.status === 'merged').length;
        const withIssues = filtered.filter(m => m.status === 'issues').length;
        const scored = filtered.filter(m => m.aiScore !== null && m.aiScore !== undefined);
        const avgScore = scored.length ? Math.round(scored.reduce((s, m) => s + m.aiScore, 0) / scored.length) : 0;

        $('metricsGrid').innerHTML = `
            ${metricCard('purple', icon('clock', 20), pending, 'MRs Pendentes', '', 0, 'pending')}
            ${metricCard('green', icon('check-circle', 20), approved, 'Aprovados / Merged', '', 0, 'approved')}
            ${metricCard('red', icon('alert-triangle', 20), withIssues, 'Com Problemas', '', 0, 'issues')}
            ${metricCard('yellow', icon('star', 20), avgScore, 'Score Médio IA', '', 0)}
        `;
        animateCounters();
        bindMetricClicks();

        // Score dist uses filtered data, chart uses ALL MRs with date range for display
        updateScoreDist(filtered);
        updateActivityChart(dashMRs, dateFrom, dateTo);

        $('mrCountBadge').textContent = filtered.length + ' resultado' + (filtered.length !== 1 ? 's' : '');
        $('mrTableContainer').innerHTML = renderMRTable(pageMRs);
        attachTableListeners();

        $('dashPagination').innerHTML = totalPages > 1 ? `<div class="repo-pagination">
            <button class="btn btn-secondary btn-sm" id="dashPrev" ${dashPage <= 1 ? 'disabled' : ''}>${icon('chevron-left', 14)} Anterior</button>
            <span style="color:var(--text-secondary);font-size:0.88rem">Página <strong>${dashPage}</strong> de <strong>${totalPages}</strong></span>
            <button class="btn btn-secondary btn-sm" id="dashNext" ${dashPage >= totalPages ? 'disabled' : ''}>Próxima ${icon('chevron-right', 14)}</button>
        </div>` : '';

        if ($('dashPrev')) $('dashPrev').addEventListener('click', () => { dashPage--; renderDashMRs(); });
        if ($('dashNext')) $('dashNext').addEventListener('click', () => { dashPage++; renderDashMRs(); });
        refreshIcons();
    }

    let dashFiltersChanged = false;

    async function reloadApiChart() {
        try {
            const chartData = await api('GET', `/orgs/${ORG_ID}/dashboard/chart`);
            if (chartData && chartData.length && $('chartContainer')) {
                const max = Math.max(...chartData.map(d => d.opened || d.value || 1));
                const dayPt = {Mon:'Seg',Tue:'Ter',Wed:'Qua',Thu:'Qui',Fri:'Sex',Sat:'Sáb',Sun:'Dom'};
                const dayFull = {Mon:'Segunda',Tue:'Terça',Wed:'Quarta',Thu:'Quinta',Fri:'Sexta',Sat:'Sábado',Sun:'Domingo'};
                $('chartContainer').innerHTML = chartData.map(d => { const lbl = d.day || d.label; const val = d.opened || d.value || 0; return `<div class="chart-bar-group"><div class="chart-bar" style="height:${(val/Math.max(max,1))*150}px"></div><div class="chart-bar-tooltip"><span class="tt-day">${dayFull[lbl] || lbl}</span><br>${val} MR${val !== 1 ? 's' : ''}</div><span class="chart-label">${dayPt[lbl] || lbl}</span></div>`; }).join('');
                if ($('chartPeriodLabel')) $('chartPeriodLabel').textContent = 'Últimos 7 dias';
            }
        } catch(_) {}
    }

    function updateActivityChart(allMrs, dateFrom, dateTo) {
        const dayPt = {0:'Dom',1:'Seg',2:'Ter',3:'Qua',4:'Qui',5:'Sex',6:'Sáb'};
        const dayFull = {0:'Domingo',1:'Segunda',2:'Terça',3:'Quarta',4:'Quinta',5:'Sexta',6:'Sábado'};

        // Count MRs per day (from ALL MRs, not filtered)
        const dayCounts = {};
        allMrs.forEach(m => {
            if (!m.createdAt) return;
            const d = m.createdAt.slice(0, 10);
            dayCounts[d] = (dayCounts[d] || 0) + 1;
        });

        // If user set date filters, use those. Otherwise auto-detect from data.
        let from, to;
        if (dateFrom && dateTo) {
            from = new Date(dateFrom);
            to = new Date(dateTo);
        } else {
            // Auto-detect: find min and max dates from MRs
            const dates = allMrs.filter(m => m.createdAt).map(m => m.createdAt.slice(0, 10)).sort();
            if (dates.length) {
                from = new Date(dates[0]);
                to = new Date(dates[dates.length - 1]);
                // Extend to today if last MR is older
                const now = new Date();
                if (to < now) to = now;
            } else {
                from = new Date(Date.now() - 7 * 86400000);
                to = new Date();
            }
        }

        // Build day range
        const days = [];
        for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
            const key = d.toISOString().slice(0, 10);
            days.push({ key, day: d.getDay(), count: dayCounts[key] || 0 });
        }

        // Show last 14 max
        const showDays = days.length > 14 ? days.slice(-14) : days;
        const max = Math.max(...showDays.map(d => d.count), 1);

        // Period label
        const diffDays = Math.round((to - from) / 86400000);
        if ($('chartPeriodLabel')) {
            if (diffDays <= 7) $('chartPeriodLabel').textContent = 'Últimos 7 dias';
            else if (diffDays <= 30) $('chartPeriodLabel').textContent = 'Últimos ' + diffDays + ' dias';
            else $('chartPeriodLabel').textContent = showDays[0].key.slice(5).replace('-','/') + ' — ' + showDays[showDays.length-1].key.slice(5).replace('-','/');
        }

        if ($('chartContainer')) {
            if (!showDays.some(d => d.count > 0)) {
                $('chartContainer').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-tertiary);font-size:0.9rem">Nenhuma atividade no período</div>';
                return;
            }
            $('chartContainer').innerHTML = showDays.map(d => {
                const h = (d.count / max) * 140;
                const barH = d.count > 0 ? Math.max(h, 24) : 4;
                const lbl = showDays.length <= 7 ? dayPt[d.day] : d.key.slice(5).replace('-', '/');
                return `<div class="chart-bar-group"><div class="chart-bar" style="height:${barH}px" data-value="${d.count}"></div><div class="chart-bar-tooltip"><span class="tt-day">${dayFull[d.day] || d.key}</span><br>${d.count} MR${d.count !== 1 ? 's' : ''}</div><span class="chart-label">${lbl}</span></div>`;
            }).join('');
        }
    }

    function updateScoreDist(filtered) {
        const green = filtered.filter(m => m.aiScore !== null && m.aiScore >= 65).length;
        const yellow = filtered.filter(m => m.aiScore !== null && m.aiScore >= 50 && m.aiScore < 65).length;
        const red = filtered.filter(m => m.aiScore !== null && m.aiScore < 50).length;
        const noScore = filtered.filter(m => m.aiScore === null || m.aiScore === undefined).length;
        const total = green + yellow + red + noScore || 1;

        if ($('scoreDistChart')) {
            $('scoreDistChart').innerHTML = `
                <div class="score-dist">
                    <div class="score-dist-bar">
                        <div style="width:${(green/total)*100}%;background:var(--accent-success)" title="${green} aprovados"></div>
                        <div style="width:${(yellow/total)*100}%;background:var(--accent-warning)" title="${yellow} regulares"></div>
                        <div style="width:${(red/total)*100}%;background:var(--accent-danger)" title="${red} críticos"></div>
                        <div style="width:${(noScore/total)*100}%;background:var(--bg-tertiary)" title="${noScore} sem score"></div>
                    </div>
                    <div class="score-dist-legend">
                        <span><span class="dot" style="background:var(--accent-success)"></span> ${green} Bom (65+)</span>
                        <span><span class="dot" style="background:var(--accent-warning)"></span> ${yellow} Regular (50-64)</span>
                        <span><span class="dot" style="background:var(--accent-danger)"></span> ${red} Crítico (&lt;50)</span>
                        ${noScore ? `<span><span class="dot" style="background:var(--text-tertiary)"></span> ${noScore} Analisando</span>` : ''}
                    </div>
                </div>`;
        }
    }

    function metricCard(color, iconHtml, value, label, trend, delay, filterAction) {
        const clickAttr = filterAction ? `data-metric-filter="${filterAction}" style="animation-delay:${delay}s;cursor:pointer"` : `style="animation-delay:${delay}s"`;
        return `<div class="metric-card stagger-in" ${clickAttr}><div class="metric-card-header"><div class="metric-icon ${color}">${iconHtml}</div>${trend ? `<span class="metric-trend up">${trend}</span>` : ''}</div><div class="metric-value" data-count-to="${typeof value === 'number' ? value : ''}">${value}</div><div class="metric-label">${label}</div></div>`;
    }

    function animateCounters() {
        document.querySelectorAll('[data-count-to]').forEach(el => {
            const target = parseInt(el.dataset.countTo);
            if (isNaN(target) || target === 0) return;
            const duration = 400;
            const start = performance.now();
            el.textContent = '0';
            function step(now) {
                const pct = Math.min((now - start) / duration, 1);
                const ease = 1 - Math.pow(1 - pct, 3);
                el.textContent = Math.round(target * ease);
                if (pct < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
        });
    }

    function bindMetricClicks() {
        document.querySelectorAll('[data-metric-filter]').forEach(card => {
            card.addEventListener('click', () => {
                const action = card.dataset.metricFilter;
                $('dashFilterPanel').classList.add('open');
                if (action === 'pending') $('dashFilterStatus').value = 'pending';
                else if (action === 'approved') $('dashFilterStatus').value = 'approved';
                else if (action === 'issues') $('dashFilterStatus').value = 'issues';
                dashPage = 1; renderDashMRs(); renderDashChips();
            });
        });
    }

    // ================================================================
    //  REPOSITORIES PAGE
    // ================================================================
    const EXAMPLE_REPOS = [
        { platform: 'github', full_name: 'facebook/react', desc: 'Biblioteca UI do Facebook — PRs frequentes com alto volume', lang: 'JavaScript', stars: '230k' },
        { platform: 'github', full_name: 'tiangolo/fastapi', desc: 'Framework web Python — PRs com boa qualidade de código', lang: 'Python', stars: '80k' },
        { platform: 'github', full_name: 'microsoft/vscode', desc: 'Editor de código da Microsoft — PRs complexos e variados', lang: 'TypeScript', stars: '168k' },
        { platform: 'github', full_name: 'pallets/flask', desc: 'Micro-framework Python — PRs menores, bom para testar', lang: 'Python', stars: '68k' },
        { platform: 'github', full_name: 'expressjs/express', desc: 'Framework Node.js minimalista — PRs concisos', lang: 'JavaScript', stars: '66k' },
        { platform: 'github', full_name: 'django/django', desc: 'Framework web Python completo — PRs com regras de negocio', lang: 'Python', stars: '82k' },
    ];

    function renderExampleRepos() {
        return EXAMPLE_REPOS.map(r => `
            <div class="example-repo-card">
                <div class="example-repo-top">
                    <div class="repo-platform-badge github"><i data-lucide="github" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></i> GitHub</div>
                    <span style="font-size:0.78rem;color:var(--text-tertiary)">${icon('star', 14)} ${r.stars}</span>
                </div>
                <div class="example-repo-name">${esc(r.full_name)}</div>
                <div class="example-repo-desc">${esc(r.desc)}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:10px">
                    <span style="font-size:0.78rem;padding:2px 8px;background:var(--bg-tertiary);border-radius:4px;color:var(--text-secondary)">${r.lang}</span>
                    <button class="btn btn-secondary btn-sm" data-example-repo="${r.full_name}" data-example-platform="${r.platform}">+ Adicionar</button>
                </div>
            </div>
        `).join('');
    }

    function attachExampleRepoListeners() {
        document.querySelectorAll('[data-example-repo]').forEach(btn => {
            btn.addEventListener('click', () => {
                const fullName = btn.dataset.exampleRepo;
                const platform = btn.dataset.examplePlatform;
                const exGt = getGlobalToken();
                openActionModal('Adicionar ' + fullName, `
                    <div class="form-card">
                        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border-color)">
                            <div style="font-size:2rem">${icon('github', 28)}</div>
                            <div>
                                <div style="font-weight:700;font-size:1.1rem;color:var(--text-primary)">${esc(fullName)}</div>
                                <div style="color:var(--text-tertiary);font-size:0.85rem">Repositório publico — ${platform}</div>
                            </div>
                        </div>
                        ${exGt ? `<div style="margin-bottom:16px;padding:10px 14px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;font-size:0.82rem;color:var(--accent-success);display:flex;gap:8px;align-items:center">${icon('check-circle', 14)} Usando token global das Configurações</div>` : `<p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:16px">
                            Para analisar PRs deste repo, voce precisa de um <strong>GitHub Personal Access Token</strong>.<br>
                            <a href="https://github.com/settings/tokens/new?scopes=public_repo&description=Codexfy" target="_blank" style="color:var(--accent-primary);font-weight:600">Criar token no GitHub →</a>
                        </p>
                        ${formRow('Access Token', 'Cole o token aqui', '<input class="input" id="exToken" type="password" placeholder="ghp_xxxxxxxxxxxx">')}`}
                        <div class="form-actions">
                            <button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button>
                            <button class="btn btn-primary" id="exSubmit">Adicionar e Sincronizar</button>
                        </div>
                        <div id="exResult"></div>
                    </div>`);
                $('exSubmit').addEventListener('click', async () => {
                    const btn2 = $('exSubmit'); btn2.disabled = true; btn2.textContent = 'Adicionando...';
                    try {
                        await ensureAuth();
                        const exTkn = $('exToken') ? $('exToken').value : getGlobalToken();
                        await api('POST', `/orgs/${ORG_ID}/repos`, { platform, full_name: fullName, access_token: exTkn });
                        toast(fullName + ' adicionado!');
                        closeActionModal();
                        if (currentPage === 'repositories') loadRepos();
                    } catch (e) {
                        $('exResult').innerHTML = `<div class="form-error">✗ ${e.message || e.detail || JSON.stringify(e)}</div>`;
                        btn2.disabled = false; btn2.textContent = 'Adicionar e Sincronizar';
                    }
                });
            });
        });
    }

    function renderReposPage() {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div><h1 class="page-title">Repositórios</h1><p class="page-subtitle">Gerencie os repositórios monitorados pela IA</p></div>
                ${isAdmin() ? `<div class="page-actions">
                    <button class="btn btn-secondary" id="btnBulkRepos">${icon('layers')} Adicionar Vários</button>
                    <button class="btn btn-primary" id="btnAddRepo">+ Adicionar Repositório</button>
                </div>` : ''}
            </div>

            <!-- How to add -->
            <div class="info-banner stagger-in" style="animation-delay:0.1s">
                <div class="info-icon">${icon('lightbulb', 20)}</div>
                <div>
                    <strong>Como adicionar repositórios?</strong>
                    <p>Clique em <em>"+ Adicionar Repositório"</em> para adicionar um por um, ou <em>"Adicionar Vários"</em> para cadastrar múltiplos repos com um único token (ideal para empresas). Crie um <strong>Personal Access Token</strong> no GitHub com permissão <code>public_repo</code>.</p>
                </div>
            </div>

            <!-- Example repos for testing -->
            <div class="card stagger-in" style="animation-delay:0.2s;margin-top:16px">
                <div class="card-header">
                    <span class="card-title">${icon('flask-conical')} Repositórios de Exemplo</span>
                    <span class="card-badge">Teste rapido</span>
                </div>
                <div class="card-body" style="padding:16px">
                    <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:16px">
                        Quer testar a análise de MR sem configurar um repo? Use um desses repositórios publicos populares. Basta criar um <strong>Personal Access Token</strong> no GitHub (<a href="https://github.com/settings/tokens/new" target="_blank" style="color:var(--accent-primary)">criar token</a>) com permissão <code>public_repo</code> e colar abaixo.
                    </p>
                    <div class="example-repos-grid" id="exampleReposGrid">
                        ${renderExampleRepos()}
                    </div>
                </div>
            </div>

            <div id="reposListContainer" style="margin-top:16px">
                ${showLoading()}
            </div>`;

        if ($('btnAddRepo')) $('btnAddRepo').addEventListener('click', openAddRepoModal);
        if ($('btnBulkRepos')) $('btnBulkRepos').addEventListener('click', openBulkReposModal);
        attachExampleRepoListeners();
        loadRepos();
    }

    let allRepos = [];
    let repoPage = 1;
    const REPOS_PER_PAGE = 12;

    async function loadRepos() {
        const c = $('reposListContainer');
        try {
            await ensureAuth();
            allRepos = await api('GET', `/orgs/${ORG_ID}/repos`);
            if (!allRepos.length) {
                c.innerHTML = `<div class="empty-state-card"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><h3>Nenhum repositório cadastrado</h3><p>Comece adicionando seus repositórios GitHub ou GitLab</p><button class="btn btn-primary" onclick="document.getElementById('btnAddRepo').click()" style="margin-top:16px">+ Adicionar Primeiro Repositório</button></div>`;
                return;
            }
            repoPage = 1;
            renderReposList();
        } catch (e) { c.innerHTML = `<div class="empty-state-card"><h3>Erro ao carregar</h3><p>${e.message || e.detail || 'Verifique a API'}</p></div>`; }
    }

    function renderReposList() {
        const c = $('reposListContainer');
        const searchVal = ($('repoSearch') ? $('repoSearch').value : '').toLowerCase();
        const filterPlat = $('repoFilterPlatform') ? $('repoFilterPlatform').value : 'all';

        let filtered = allRepos;
        if (searchVal) filtered = filtered.filter(r => r.full_name.toLowerCase().includes(searchVal) || (r.default_branch || '').toLowerCase().includes(searchVal));
        if (filterPlat !== 'all') filtered = filtered.filter(r => r.platform === filterPlat);

        const totalPages = Math.max(1, Math.ceil(filtered.length / REPOS_PER_PAGE));
        if (repoPage > totalPages) repoPage = totalPages;
        const start = (repoPage - 1) * REPOS_PER_PAGE;
        const pageRepos = filtered.slice(start, start + REPOS_PER_PAGE);

        c.innerHTML = `<div class="card">
            <div class="card-header" style="flex-wrap:wrap;gap:12px">
                <span class="card-title">Repositórios Cadastrados</span>
                <span class="card-badge">${filtered.length}</span>
                <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;align-items:center">
                    <div style="position:relative;display:flex;align-items:center">
                        <span style="position:absolute;left:10px;color:var(--text-tertiary);pointer-events:none">${icon('search', 15)}</span>
                        <input class="input" id="repoSearch" type="text" placeholder="Buscar repositório..." value="${esc(searchVal)}" style="padding-left:34px;width:220px;height:36px;font-size:0.85rem">
                    </div>
                    <select class="input" id="repoFilterPlatform" style="height:36px;font-size:0.85rem;width:auto">
                        <option value="all">Todas</option>
                        <option value="github" ${filterPlat === 'github' ? 'selected' : ''}>GitHub</option>
                        <option value="gitlab" ${filterPlat === 'gitlab' ? 'selected' : ''}>GitLab</option>
                    </select>
                </div>
            </div>
            <div class="repos-grid">${pageRepos.map(r => `
                <div class="repo-card">
                    <div class="repo-card-top">
                        <div class="repo-platform-badge ${r.platform}">${r.platform === 'github' ? icon("github") + ' GitHub' : icon("gitlab") + ' GitLab'}</div>
                        ${isAdmin() ? `<div class="repo-actions">
                            <button class="btn-icon" title="Sincronizar" data-sync="${r.id}"><i data-lucide="refresh-cw" style="width:16px;height:16px"></i></button>
                            <button class="btn-icon btn-danger" title="Remover" data-del="${r.id}"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button>
                        </div>` : ''}
                    </div>
                    <div class="repo-card-name">${esc(r.full_name)}</div>
                    <div class="repo-card-branch">Branch: ${r.default_branch}</div>
                    <div class="repo-card-footer" style="flex-direction:column;gap:8px">
                        <div style="display:flex;justify-content:space-between;width:100%">
                            <span style="color:${r.auto_analyze ? 'var(--accent-success)' : 'var(--text-tertiary)'}">${r.auto_analyze ? icon('check-circle', 14) + ' Auto-Análise' : icon('circle', 14) + ' Manual'}</span>
                            <span>Score min: ${r.min_score}</span>
                        </div>
                        ${r.avg_score != null ? `<div style="display:flex;align-items:center;gap:8px;width:100%"><div style="flex:1;background:var(--bg-tertiary);border-radius:4px;height:6px;overflow:hidden"><div style="background:${r.avg_score >= 65 ? 'var(--accent-success)' : r.avg_score >= 50 ? 'var(--accent-warning)' : 'var(--accent-danger)'};height:100%;width:${r.avg_score}%;border-radius:4px"></div></div><span style="font-size:0.75rem;font-weight:700;color:${r.avg_score >= 65 ? 'var(--accent-success)' : r.avg_score >= 50 ? 'var(--accent-warning)' : 'var(--accent-danger)'}">${r.avg_score}/100</span></div>` : ''}
                        ${isAdmin() ? `<button class="btn btn-sm" style="width:100%;background:rgba(129,140,248,0.12);color:var(--accent-primary);border:1px solid rgba(129,140,248,0.25);padding:7px;border-radius:8px;font-size:0.76rem;font-weight:600;cursor:pointer;transition:all 0.2s;letter-spacing:0.3px" onmouseover="this.style.background='rgba(129,140,248,0.22)'" onmouseout="this.style.background='rgba(129,140,248,0.12)'" data-analyze-repo="${r.id}">Analisar Repositorio</button>` : ''}
                    </div>
                </div>
            `).join('')}</div>
            ${totalPages > 1 ? `<div class="repo-pagination">
                <button class="btn btn-secondary btn-sm" id="repoPrev" ${repoPage <= 1 ? 'disabled' : ''}>${icon('chevron-left', 14)} Anterior</button>
                <span style="color:var(--text-secondary);font-size:0.88rem">Página <strong>${repoPage}</strong> de <strong>${totalPages}</strong></span>
                <button class="btn btn-secondary btn-sm" id="repoNext" ${repoPage >= totalPages ? 'disabled' : ''}>Próxima ${icon('chevron-right', 14)}</button>
            </div>` : ''}
        </div>`;

        if ($('repoSearch')) $('repoSearch').addEventListener('input', () => { repoPage = 1; renderReposList(); });
        if ($('repoFilterPlatform')) $('repoFilterPlatform').addEventListener('change', () => { repoPage = 1; renderReposList(); });
        if ($('repoPrev')) $('repoPrev').addEventListener('click', () => { repoPage--; renderReposList(); });
        if ($('repoNext')) $('repoNext').addEventListener('click', () => { repoPage++; renderReposList(); });

        c.querySelectorAll('[data-sync]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true; try { await api('POST', `/orgs/${ORG_ID}/repos/${b.dataset.sync}/sync`); toast('Sync iniciada!'); } catch (e) { toast(e.message || 'Erro', 'error'); } b.disabled = false;
        }));
        c.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
            const ok = await confirmAction('Remover Repositório', 'Tem certeza que deseja remover este repositório e todos os seus dados? Essa ação não pode ser desfeita.');
            if (!ok) return;
            try { await api('DELETE', `/orgs/${ORG_ID}/repos/${b.dataset.del}`); toast('Removido!'); loadRepos(); } catch (e) { toast(e.message || 'Erro', 'error'); }
        }));
        c.querySelectorAll('[data-analyze-repo]').forEach(b => b.addEventListener('click', async () => {
            const repoId = b.dataset.analyzeRepo;
            b.disabled = true; b.textContent = 'Analisando...';
            try {
                const res = await api('POST', `/orgs/${ORG_ID}/repos/${repoId}/analyze`);
                const mrId = res.mr_id;
                toast('Análise iniciada! Aguarde...');
                if (mrId) {
                    let tries = 0;
                    const poll = setInterval(async () => {
                        tries++;
                        try {
                            const mr = await api('GET', `/orgs/${ORG_ID}/repos/${repoId}/mrs/${mrId}`);
                            if (mr.status === 'approved' || mr.status === 'issues' || tries >= 30) {
                                clearInterval(poll);
                                b.disabled = false; b.textContent = 'Analisar Repositorio';
                                openMRDetail(mrId, repoId);
                                _onModalClose = () => { if (currentPage === 'repositories') loadRepos(); };
                            }
                        } catch (_) {
                            if (tries >= 30) { clearInterval(poll); b.disabled = false; b.textContent = 'Analisar Repositorio'; }
                        }
                    }, 3000);
                } else { b.disabled = false; b.textContent = 'Analisar Repositorio'; }
            } catch (e) { toast(e.message || 'Erro ao analisar', 'error'); b.disabled = false; b.textContent = 'Analisar Repositorio'; }
        }));
        refreshIcons();
    }

    function openAddRepoModal() {
        const gt = getGlobalToken();
        openActionModal('Adicionar Repositório', `
            <div class="form-card">
                ${gt ? `<div style="margin-bottom:12px;padding:10px 14px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;font-size:0.82rem;color:var(--accent-success);display:flex;gap:8px;align-items:center">${icon('check-circle', 14)} Usando token global das Configurações</div>` : ''}
                ${formRow('Plataforma', '', `<select class="input" id="fPlatform"><option value="github" ${getGlobalPlatform() === 'github' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${getGlobalPlatform() === 'gitlab' ? 'selected' : ''}>GitLab</option></select>`)}
                ${formRow('Repositório', 'Formato: owner/repo', '<input class="input" id="fFullName" placeholder="empresa/backend-api">')}
                ${gt ? '' : formRow('Access Token', 'Token com permissão de leitura', '<input class="input" id="fToken" type="password" placeholder="ghp_... ou glpat-...">')}
                ${formRow('Branch Principal', '', '<input class="input" id="fBranch" value="main">')}
                <div class="form-actions">
                    <button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button>
                    <button class="btn btn-primary" id="fSubmit">Adicionar</button>
                </div>
                <div id="fResult"></div>
            </div>`);
        $('fSubmit').addEventListener('click', async () => {
            const btn = $('fSubmit'); btn.disabled = true; btn.textContent = 'Adicionando...';
            try {
                await ensureAuth();
                const tkn = $('fToken') ? $('fToken').value : getGlobalToken();
                await api('POST', `/orgs/${ORG_ID}/repos`, { platform: $('fPlatform').value, full_name: $('fFullName').value, access_token: tkn, default_branch: $('fBranch').value });
                toast('Repositório adicionado!'); closeActionModal(); if (currentPage === 'repositories') loadRepos();
            } catch (e) { $('fResult').innerHTML = `<div class="form-error">✗ ${e.message || e.detail || JSON.stringify(e)}</div>`; btn.disabled = false; btn.textContent = 'Adicionar'; }
        });
    }

    function getGlobalToken() { return localStorage.getItem('cg_git_token') || ''; }
    function getGlobalPlatform() { return localStorage.getItem('cg_git_platform') || 'github'; }

    function openBulkReposModal() {
        const gt = getGlobalToken();
        const gp = getGlobalPlatform();
        let fetchedRepos = [];
        let alreadyAdded = [];
        let selected = new Set();

        openActionModal('Importar Repositórios', `
            <div class="form-card">
                <!-- Step 1: Connect -->
                <div id="bulkStep1">
                    <div style="margin-bottom:16px;padding:14px;background:var(--bg-tertiary);border-radius:10px;font-size:0.85rem;color:var(--text-secondary);display:flex;gap:10px;align-items:flex-start">
                        ${icon('info', 16)} <div>Conecte sua conta GitHub ou GitLab para ver todos os seus repositórios e selecionar quais deseja monitorar.</div>
                    </div>
                    <div class="filter-row">
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('git-branch', 14)}</span>
                            <select class="input filter-input" id="fBulkPlatform">
                                <option value="github" ${gp === 'github' ? 'selected' : ''}>GitHub</option>
                                <option value="gitlab" ${gp === 'gitlab' ? 'selected' : ''}>GitLab</option>
                            </select>
                        </div>
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('key', 14)}</span>
                            <input class="input filter-input" id="fBulkToken" type="password" value="${esc(gt)}" placeholder="ghp_... ou glpat-...">
                        </div>
                    </div>
                    <button class="btn btn-primary" id="fBulkFetch" style="width:100%;justify-content:center;margin-top:12px">${icon('search')} Buscar Repositórios</button>
                    <div id="fBulkError" style="margin-top:10px"></div>
                </div>

                <!-- Step 2: Select (hidden initially) -->
                <div id="bulkStep2" style="display:none">
                    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
                        <div class="filter-input-wrap" style="flex:1">
                            <span class="filter-input-icon">${icon('search', 14)}</span>
                            <input class="input filter-input" id="fBulkSearch" placeholder="Filtrar repositórios...">
                        </div>
                        <button class="btn btn-secondary btn-sm" id="fBulkSelectAll">Selecionar todos</button>
                        <button class="btn btn-secondary btn-sm" id="fBulkClearSel">Limpar</button>
                    </div>
                    <div id="fBulkRepoList" class="repo-select-list"></div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color)">
                        <span id="fBulkCount" style="font-size:0.85rem;color:var(--text-tertiary)">0 selecionados</span>
                        <div style="display:flex;gap:8px">
                            <button class="btn btn-secondary btn-sm" id="fBulkBack">${icon('arrow-left', 14)} Voltar</button>
                            <button class="btn btn-primary btn-sm" id="fBulkAdd" disabled>${icon('plus', 14)} Adicionar Selecionados</button>
                        </div>
                    </div>
                    <div id="fBulkResult" style="margin-top:10px;max-height:150px;overflow-y:auto"></div>
                </div>
            </div>`);

        // Step 1: Fetch repos
        $('fBulkFetch').addEventListener('click', async () => {
            const token = $('fBulkToken').value.trim();
            const platform = $('fBulkPlatform').value;
            if (!token) { $('fBulkError').innerHTML = '<div class="form-error">Insira o Access Token</div>'; return; }

            const btn = $('fBulkFetch');
            btn.disabled = true; btn.innerHTML = icon('loader', 16) + ' Buscando...';
            $('fBulkError').innerHTML = '';

            try {
                await ensureAuth();
                const data = await api('GET', '/orgs/' + ORG_ID + '/repos/available?platform=' + platform + '&token=' + encodeURIComponent(token));
                fetchedRepos = data.repos || [];
                alreadyAdded = data.already_added || [];

                if (!fetchedRepos.length) {
                    $('fBulkError').innerHTML = '<div class="form-error">Nenhum repositório encontrado nesta conta</div>';
                    btn.disabled = false; btn.innerHTML = icon('search') + ' Buscar Repositórios';
                    return;
                }

                // Save token globally
                localStorage.setItem('cg_git_token', token);
                localStorage.setItem('cg_git_platform', platform);

                // Switch to step 2
                $('bulkStep1').style.display = 'none';
                $('bulkStep2').style.display = 'block';
                selected.clear();
                renderBulkRepoList();
            } catch (e) {
                $('fBulkError').innerHTML = '<div class="form-error">' + icon('alert-circle', 14) + ' ' + esc(e.message || e.detail || 'Erro ao buscar repositórios') + '</div>';
                btn.disabled = false; btn.innerHTML = icon('search') + ' Buscar Repositórios';
            }
        });

        function renderBulkRepoList() {
            const search = ($('fBulkSearch') ? $('fBulkSearch').value : '').toLowerCase();
            const filtered = fetchedRepos.filter(r => !search || r.full_name.toLowerCase().includes(search) || (r.description || '').toLowerCase().includes(search) || (r.language || '').toLowerCase().includes(search));

            $('fBulkRepoList').innerHTML = filtered.map(r => {
                const added = alreadyAdded.includes(r.full_name);
                const checked = selected.has(r.full_name);
                return `<label class="repo-select-item ${added ? 'disabled' : ''} ${checked ? 'selected' : ''}" data-repo="${esc(r.full_name)}">
                    <input type="checkbox" ${checked ? 'checked' : ''} ${added ? 'disabled' : ''} data-repo-cb="${esc(r.full_name)}">
                    <div class="repo-select-info">
                        <div class="repo-select-name">${esc(r.full_name)} ${r.private ? '<span class="repo-select-badge private">' + icon('lock', 11) + ' Privado</span>' : '<span class="repo-select-badge public">' + icon('globe', 11) + ' Público</span>'}</div>
                        <div class="repo-select-meta">${r.language ? '<span>' + esc(r.language) + '</span>' : ''}${r.stars ? '<span>' + icon('star', 11) + ' ' + r.stars + '</span>' : ''}${r.description ? '<span>' + esc(r.description.slice(0, 60)) + '</span>' : ''}</div>
                    </div>
                    ${added ? '<span class="repo-select-added">' + icon('check-circle', 14) + ' Já adicionado</span>' : ''}
                </label>`;
            }).join('') || '<div style="padding:20px;text-align:center;color:var(--text-tertiary)">Nenhum repo encontrado</div>';

            $('fBulkRepoList').querySelectorAll('[data-repo-cb]').forEach(cb => {
                cb.addEventListener('change', () => {
                    if (cb.checked) selected.add(cb.dataset.repoCb);
                    else selected.delete(cb.dataset.repoCb);
                    updateBulkCount();
                    cb.closest('.repo-select-item').classList.toggle('selected', cb.checked);
                });
            });
            updateBulkCount();
        }

        function updateBulkCount() {
            const count = selected.size;
            $('fBulkCount').textContent = count + ' selecionado' + (count !== 1 ? 's' : '');
            $('fBulkAdd').disabled = count === 0;
            $('fBulkAdd').innerHTML = icon('plus', 14) + ' Adicionar ' + (count || '') + ' Selecionado' + (count !== 1 ? 's' : '');
        }

        // Search
        document.addEventListener('input', e => { if (e.target.id === 'fBulkSearch') renderBulkRepoList(); });

        // Select all / clear
        $('fBulkSelectAll').addEventListener('click', () => {
            fetchedRepos.forEach(r => { if (!alreadyAdded.includes(r.full_name)) selected.add(r.full_name); });
            renderBulkRepoList();
        });
        $('fBulkClearSel').addEventListener('click', () => { selected.clear(); renderBulkRepoList(); });

        // Back button
        $('fBulkBack').addEventListener('click', () => {
            $('bulkStep1').style.display = 'block';
            $('bulkStep2').style.display = 'none';
            const btn = $('fBulkFetch');
            btn.disabled = false; btn.innerHTML = icon('search') + ' Buscar Repositórios';
        });

        // Add selected repos
        $('fBulkAdd').addEventListener('click', async () => {
            const token = $('fBulkToken').value.trim();
            const platform = $('fBulkPlatform').value;
            const repos = [...selected];
            if (!repos.length) return;

            const btn = $('fBulkAdd');
            btn.disabled = true; btn.innerHTML = icon('loader', 14) + ' Adicionando...';
            let ok = 0, fail = 0;
            const results = [];

            for (const repoName of repos) {
                const repoData = fetchedRepos.find(r => r.full_name === repoName);
                const branch = repoData ? repoData.default_branch : 'main';
                try {
                    await ensureAuth();
                    await api('POST', '/orgs/' + ORG_ID + '/repos', { platform, full_name: repoName, access_token: token, default_branch: branch });
                    ok++;
                    alreadyAdded.push(repoName);
                    results.push('<div style="color:var(--accent-success);font-size:0.85rem;display:flex;align-items:center;gap:6px">' + icon('check-circle', 14) + ' ' + esc(repoName) + '</div>');
                } catch (e) {
                    fail++;
                    results.push('<div style="color:var(--accent-danger);font-size:0.85rem;display:flex;align-items:center;gap:6px">' + icon('x-circle', 14) + ' ' + esc(repoName) + ' — ' + esc(e.message || 'erro') + '</div>');
                }
                $('fBulkResult').innerHTML = results.join('');
            }

            selected.clear();
            renderBulkRepoList();
            btn.disabled = false; btn.innerHTML = icon('plus', 14) + ' Adicionar Selecionados';
            if (ok > 0) { toast(ok + ' repositório(s) adicionado(s)!'); loadRepos(); }
        });
    }

    function openBulkAddModal() {
        openActionModal('Análise em Massa', `
            <div class="form-card">
                <div id="bulkDropZone" style="border:2px dashed var(--border-color);border-radius:var(--radius-md);padding:36px;text-align:center;cursor:pointer;transition:all 0.2s;margin-bottom:16px">
                    <div style="margin-bottom:10px">${icon('file-code', 40)}</div>
                    <div style="font-weight:600;color:var(--text-primary);font-size:1.05rem">Arraste seus arquivos aqui</div>
                    <div style="color:var(--text-tertiary);font-size:0.82rem;margin-top:6px">.py, .js, .ts, .java, .go, .zip, .patch — ou clique para selecionar</div>
                    <input type="file" id="bulkFileInput" multiple accept=".py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.patch,.diff,.txt,.zip,.json,.yaml,.yml,.html,.css,.sql,.sh" style="display:none">
                </div>
                <div id="bulkFileList"></div>
                <div class="form-actions" style="margin-top:16px">
                    <button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button>
                    <button class="btn btn-primary" id="fBulkSubmit" disabled>${icon('sparkles')} Analisar Todos</button>
                </div>
            </div>`);

        let selectedFiles = [];
        const dropZone = $('bulkDropZone'), fileInput = $('bulkFileInput');
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent-primary)'; dropZone.style.background = 'rgba(226,232,240,0.05)'; });
        dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border-color)'; dropZone.style.background = ''; });
        dropZone.addEventListener('drop', async e => { e.preventDefault(); dropZone.style.borderColor = 'var(--border-color)'; dropZone.style.background = ''; await addBulkFiles(Array.from(e.dataTransfer.files)); });
        fileInput.addEventListener('change', async () => await addBulkFiles(Array.from(fileInput.files)));

        async function addBulkFiles(files) {
            const skipExts = ['png','jpg','jpeg','gif','svg','ico','woff','ttf','eot','mp3','mp4','pdf','exe','dll','zip'];

            for (const f of files) {
                if (f.size > 5 * 1024 * 1024) continue;

                // If ZIP, extract individual files
                if (f.name.endsWith('.zip') && window.JSZip) {
                    try {
                        const zip = await JSZip.loadAsync(f);
                        const extracted = [];
                        for (const [path, entry] of Object.entries(zip.files)) {
                            if (entry.dir) continue;
                            const ext = path.split('.').pop().toLowerCase();
                            if (skipExts.includes(ext)) continue;
                            const content = await entry.async('blob');
                            const name = path.includes('/') ? path.split('/').pop() : path;
                            extracted.push(new File([content], name, { type: 'text/plain' }));
                        }
                        for (const ef of extracted) {
                            if (!selectedFiles.find(x => x.name === ef.name)) selectedFiles.push(ef);
                        }
                        toast(extracted.length + ' arquivos extraídos do ZIP');
                    } catch (_) { toast('Erro ao abrir ZIP', 'error'); }
                    continue;
                }

                if (!selectedFiles.find(x => x.name === f.name)) selectedFiles.push(f);
            }
            renderBulkFileList();
        }

        function renderBulkFileList() {
            const el = $('bulkFileList'); $('fBulkSubmit').disabled = !selectedFiles.length;
            if (!selectedFiles.length) { el.innerHTML = ''; return; }
            el.innerHTML = '<div style="display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto">' + selectedFiles.map((f,i) =>
                '<div class="bulk-file-row"><span>' + icon('file-code',14) + '</span><span class="file-name">' + esc(f.name) + '</span><span style="color:var(--text-tertiary);font-size:0.78rem">' + (f.size<1024?f.size+'B':(f.size/1024).toFixed(1)+'KB') + '</span><button data-bulk-rm="'+i+'" style="background:none;border:none;color:var(--accent-danger);cursor:pointer">' + icon('x',14) + '</button></div>'
            ).join('') + '</div>';
            el.querySelectorAll('[data-bulk-rm]').forEach(b => b.addEventListener('click', () => { selectedFiles.splice(+b.dataset.bulkRm,1); renderBulkFileList(); }));
        }

        $('fBulkSubmit').addEventListener('click', () => {
            if (!selectedFiles.length) return;
            closeActionModal();
            runBulkAnalysis(selectedFiles);
        });
    }

    async function runBulkAnalysis(files) {
        const total = files.length;

        // Create fullscreen overlay
        const overlay = document.createElement('div');
        overlay.className = 'bulk-overlay';
        overlay.id = 'bulkOverlay';
        overlay.innerHTML = `
            <div class="circle-progress">
                <svg viewBox="0 0 180 180">
                    <circle class="track" cx="90" cy="90" r="80"/>
                    <circle class="fill" id="circFill" cx="90" cy="90" r="80"/>
                </svg>
                <div class="center-text">
                    <div class="pct" id="circPct">0%</div>
                    <div class="label" id="circLabel">Enviando...</div>
                </div>
            </div>
            <div style="color:var(--text-primary);font-size:1.1rem;font-weight:600" id="circTitle">Preparando análise...</div>
            <div style="max-width:500px;width:90%;display:flex;flex-direction:column;gap:6px" id="circFiles"></div>
        `;
        document.body.appendChild(overlay);

        const circFill = $('circFill');
        const circPct = $('circPct');
        const circLabel = $('circLabel');
        const circTitle = $('circTitle');
        const circFiles = $('circFiles');
        const circumference = 2 * Math.PI * 80; // ~502

        function setPct(pct) {
            const offset = circumference - (pct / 100) * circumference;
            circFill.style.strokeDashoffset = offset;
            circPct.textContent = Math.round(pct) + '%';
        }

        // Render file rows
        circFiles.innerHTML = files.map((f, i) =>
            '<div class="bulk-file-row" id="bf-' + i + '">' +
                '<span class="icon-spin">' + icon('loader', 16) + '</span>' +
                '<span class="file-name">' + esc(f.name) + '</span>' +
                '<span class="file-status" style="color:var(--text-tertiary)">aguardando</span>' +
            '</div>'
        ).join('');

        // Phase 1: Submit all files
        circTitle.textContent = 'Enviando ' + total + ' arquivo(s)...';
        const jobs = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const row = $('bf-' + i);
            row.querySelector('.file-status').textContent = 'enviando...';

            try {
                await ensureAuth();
                const fd = new FormData();
                fd.append('mr_title', file.name);
                fd.append('mr_description', 'Análise em massa — ' + file.name);
                fd.append('file', file);
                const r = await fetch(API + '/orgs/' + ORG_ID + '/upload-analysis', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
                const d = await r.json();
                if (r.ok) {
                    jobs.push({ idx: i, name: file.name, id: d.analysis_id, status: 'queued', score: null });
                    row.querySelector('.file-status').textContent = 'na fila';
                    row.querySelector('.file-status').style.color = 'var(--accent-warning)';
                } else {
                    jobs.push({ idx: i, name: file.name, id: null, status: 'failed', score: null });
                    row.classList.add('failed');
                    row.children[0].innerHTML = icon('x-circle', 16);
                    row.querySelector('.file-status').textContent = 'erro';
                    row.querySelector('.file-status').style.color = 'var(--accent-danger)';
                }
            } catch (e) {
                jobs.push({ idx: i, name: file.name, id: null, status: 'failed', score: null });
                row.classList.add('failed');
                row.children[0].innerHTML = icon('x-circle', 16);
                row.querySelector('.file-status').textContent = 'erro';
                row.querySelector('.file-status').style.color = 'var(--accent-danger)';
            }
            setPct(((i + 1) / total) * 20);
        }

        // Phase 2: Poll until all done
        const pending = jobs.filter(j => j.id);
        if (!pending.length) {
            circTitle.textContent = 'Nenhum arquivo pôde ser enviado';
            circLabel.textContent = 'Tente novamente';
            setTimeout(() => overlay.remove(), 3000);
            return;
        }

        circTitle.textContent = 'IA analisando ' + pending.length + ' arquivo(s)...';
        circLabel.textContent = 'Preparando análise...';
        let done = 0;
        let circPctVal = 20;

        // Contagem rápida autônoma até 90%
        const countInterval = setInterval(() => {
            if (circPctVal < 50) circPctVal += 1.5;
            else if (circPctVal < 75) circPctVal += 0.8;
            else if (circPctVal < 90) circPctVal += 0.3;
            setPct(Math.round(circPctVal));
        }, 150);

        const bulkLabels = ['Preparando análise...', 'Lendo arquivo...', 'Carregando regras...', 'Enviando para IA...', 'IA analisando código...', 'Processando resultados...', 'Finalizando...'];
        let bulkLabelIdx = 0;
        const labelInterval = setInterval(() => {
            if (bulkLabelIdx < bulkLabels.length - 1 && done < pending.length) {
                bulkLabelIdx++;
                circLabel.textContent = bulkLabels[bulkLabelIdx];
            }
        }, 4000);

        for (let poll = 0; poll < 180; poll++) {
            await new Promise(r => setTimeout(r, 1500));
            let allDone = true;

            for (const job of jobs) {
                if (!job.id || job.status === 'completed' || job.status === 'failed') continue;
                try {
                    const r = await fetch(API + '/analyses/' + job.id, { headers: { Authorization: 'Bearer ' + TOKEN } });
                    const d = await r.json();
                    const row = $('bf-' + job.idx);

                    if (d.status === 'completed') {
                        job.status = 'completed'; job.score = d.ai_score; done++;
                        const g = AnalysisEngine.getScoreGrade(d.ai_score);
                        row.classList.add('completed');
                        row.children[0].innerHTML = icon('check-circle', 16);
                        row.querySelector('.file-status').innerHTML = '<strong style="color:' + g.color + '">' + d.ai_score + '/100</strong>';
                    } else if (d.status === 'failed') {
                        job.status = 'failed'; done++;
                        row.classList.add('failed');
                        row.children[0].innerHTML = icon('x-circle', 16);
                        row.querySelector('.file-status').textContent = 'falhou';
                        row.querySelector('.file-status').style.color = 'var(--accent-danger)';
                    } else {
                        allDone = false;
                        const lbl = d.progress_label || 'analisando...';
                        row.querySelector('.file-status').textContent = lbl;
                        row.querySelector('.file-status').style.color = 'var(--accent-warning)';
                    }
                } catch (_) { allDone = false; }
            }

            if (done === pending.length) circTitle.textContent = done + ' de ' + pending.length + ' concluído(s)';

            if (allDone) break;
        }

        clearInterval(countInterval);
        clearInterval(labelInterval);

        // Mostra 100% por 1s antes de exibir resultado
        setPct(100);
        circLabel.textContent = 'Análise concluída!';
        await new Promise(r => setTimeout(r, 1000));

        // Phase 3: Done — show results
        const ok = jobs.filter(j => j.status === 'completed');
        const fail = jobs.filter(j => j.status === 'failed');
        const avg = ok.length ? Math.round(ok.reduce((s, j) => s + (j.score || 0), 0) / ok.length) : 0;

        if (ok.length) {
            const g = AnalysisEngine.getScoreGrade(avg);
            overlay.innerHTML = `
                <div class="card stagger-in" style="max-width:500px;width:90%;background:var(--bg-modal);box-shadow:var(--shadow-glow-lg)">
                    <div class="card-header"><span class="card-title">Análise em Massa Concluída</span><span class="card-badge" style="background:${g.color}20;color:${g.color}">${g.label}</span></div>
                    <div class="card-body" style="padding:32px;text-align:center">
                        <div class="score-circle" style="--score-color:${g.color};--score-pct:${avg};color:${g.color};margin:0 auto 20px;width:120px;height:120px;font-size:2.5rem">${avg}</div>
                        <h3 style="font-size:1.2rem;margin-bottom:8px">Score Médio: ${avg}/100</h3>
                        <p style="color:var(--text-secondary);margin-bottom:24px">${ok.length} arquivos analisados com sucesso ${fail.length ? `(${fail.length} falhas)` : ''}. ${g.description}</p>
                        <button class="btn btn-primary" id="bulkCloseBtn" style="width:100%;justify-content:center;padding:12px">${icon('arrow-right')} Ver Resultados</button>
                    </div>
                </div>
            `;
            refreshIcons();
        } else {
            overlay.innerHTML = `
                <div class="card stagger-in" style="max-width:500px;width:90%;background:var(--bg-modal);">
                    <div class="card-body" style="padding:32px;text-align:center">
                        <div style="color:var(--accent-danger);margin-bottom:16px">${icon('x-circle', 48)}</div>
                        <h3 style="font-size:1.2rem;margin-bottom:8px">Falha na Análise</h3>
                        <p style="color:var(--text-secondary);margin-bottom:24px">Nenhum arquivo pôde ser analisado com sucesso.</p>
                        <button class="btn btn-secondary" id="bulkCloseBtn" style="width:100%;justify-content:center;padding:12px">Fechar</button>
                    </div>
                </div>
            `;
        }

        $('bulkCloseBtn').addEventListener('click', () => {
            overlay.remove();
            document.querySelector('[data-page="merge-requests"]').click();
        });
    }

    // ================================================================
    //  TEAM PAGE
    // ================================================================
    function renderTeamPage() {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div><h1 class="page-title">Equipe</h1><p class="page-subtitle">Gerencie os membros da organização</p></div>
                ${isAdmin() ? '<div class="page-actions"><button class="btn btn-primary" id="btnInvite">+ Convidar por E-mail</button></div>' : ''}
            </div>
            <div id="teamContainer" style="margin-top:16px">${showLoading()}</div>`;
        if (isAdmin() && $('btnInvite')) $('btnInvite').addEventListener('click', openInviteMemberModal);
        loadTeam();
    }

    async function loadTeam() {
        const c = $('teamContainer');
        try {
            await ensureAuth();
            const members = await api('GET', `/orgs/${ORG_ID}/members`);
            if (!members.length) {
                c.innerHTML = `<div class="empty-state-card"><h3>Nenhum membro</h3><p>Convide membros para sua organização</p>
                    ${isAdmin() ? '<button class="btn btn-primary" onclick="document.getElementById(\'btnInvite\').click()" style="margin-top:16px">+ Convidar Primeiro Membro</button>' : ''}</div>`;
                return;
            }
            c.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Membros da Organização</span><span class="card-badge">${members.length}</span></div>
                <div class="team-grid">${members.map(m => {
                    const initials = m.initials || m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                    const isSelf = String(m.id) === String(currentUserId);
                    const memberData = JSON.stringify({ id: m.id, name: m.name, email: m.email, role: m.role, color: m.color || '#818cf8' });
                    return `<div class="team-card">
                        <div class="team-card-avatar" style="background:${m.color || '#818cf8'}">${initials}</div>
                        <div class="team-card-info">
                            <div class="team-card-name">${esc(m.name)}${isSelf ? ' <span style="font-size:0.75rem;color:var(--text-tertiary)">(voce)</span>' : ''}</div>
                            <div class="team-card-email">${esc(m.email)}</div>
                        </div>
                        <span class="badge ${m.role === 'admin' ? 'badge-approved' : 'badge-pending'}">${m.role === 'admin' ? 'Admin' : 'Membro'}</span>
                        <div style="display:flex;gap:6px">
                            ${isAdmin() ? `<button class="btn btn-secondary btn-sm" data-edit-member='${memberData}'>Editar</button>` : ''}
                            ${isAdmin() && !isSelf ? `<button class="btn btn-sm" data-delete-member="${m.id}" data-delete-name="${esc(m.name)}" style="background:transparent;color:var(--danger);border:1px solid var(--danger);cursor:pointer">Remover</button>` : ''}
                        </div>
                    </div>`;
                }).join('')}</div></div>`;

            c.querySelectorAll('[data-edit-member]').forEach(btn => {
                btn.addEventListener('click', () => openEditMemberModal(JSON.parse(btn.dataset.editMember)));
            });
            c.querySelectorAll('[data-delete-member]').forEach(btn => {
                btn.addEventListener('click', () => deleteMember(btn.dataset.deleteMember, btn.dataset.deleteName));
            });
        } catch (e) { c.innerHTML = `<div class="empty-state-card"><h3>Erro</h3><p>${e.message || e.detail || 'Verifique a API'}</p></div>`; }
    }

    async function deleteMember(userId, userName) {
        const confirmed = await confirmAction('Remover Membro', `Tem certeza que deseja remover "${esc(userName)}" da organização? Ele perderá acesso ao sistema.`);
        if (!confirmed) return;
        try {
            await ensureAuth();
            await api('DELETE', `/orgs/${ORG_ID}/members/${userId}`);
            toast(`${userName} removido da organização`);
            loadTeam();
        } catch (e) {
            toast(e.message || 'Erro ao remover membro', 'error');
        }
    }

    function openInviteMemberModal() {
        openActionModal('Convidar Membro por E-mail', `
            <div class="form-card">
                <div style="margin-bottom:16px;padding:12px 16px;background:var(--bg-tertiary);border-radius:8px;font-size:0.88rem;color:var(--text-secondary)">
                    O membro recebera acesso com uma senha temporaria. Ele podera alterar depois nas configuracoes.
                </div>
                ${formRow('Nome Completo', 'Nome do novo membro', '<input class="input" id="fName" placeholder="Joao Silva">')}
                ${formRow('E-mail', 'E-mail para acesso', '<input class="input" id="fEmail" type="email" placeholder="joao@empresa.com">')}
                ${formRow('Cargo', 'Permissões no sistema', `<select class="input" id="fRole">
                    <option value="member">Membro — visualiza MRs e análises</option>
                    <option value="admin">Admin — gerencia repos, equipe e regras</option>
                </select>`)}
                <div class="form-actions">
                    <button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button>
                    <button class="btn btn-primary" id="fInviteSubmit">Enviar Convite</button>
                </div>
                <div id="fInviteResult"></div>
            </div>`);
        $('fInviteSubmit').addEventListener('click', async () => {
            const name = $('fName').value.trim();
            const email = $('fEmail').value.trim();
            if (!name || !email) { $('fInviteResult').innerHTML = '<div class="form-error">Preencha nome e e-mail</div>'; return; }

            const btn = $('fInviteSubmit'); btn.disabled = true; btn.textContent = 'Convidando...';
            try {
                await ensureAuth();
                const m = await api('POST', `/orgs/${ORG_ID}/members/invite`, { name, email, role: $('fRole').value });

                // Show credentials for admin to copy/share
                const loginUrl = window.location.origin + '/app/index.html';
                const shareText = `Ola ${name}! Voce foi convidado para o Codexfy.\n\nAcesse: ${loginUrl}\nE-mail: ${email}\nSenha: ${m.temp_password}\n\nTroque sua senha apos o primeiro login.`;

                actionBody.innerHTML = `
                    <div style="text-align:center;padding:8px 0">
                        <div style="font-size:2.5rem;margin-bottom:12px">✅</div>
                        <h3 style="color:var(--text-primary);margin-bottom:4px">${esc(name)} adicionado!</h3>
                        <p style="color:var(--text-tertiary);margin-bottom:20px">Envie as credenciais abaixo para o membro</p>

                        <div style="background:var(--bg-tertiary);border-radius:10px;padding:20px;text-align:left;margin-bottom:16px;border:1px solid var(--border-color)">
                            <div style="margin-bottom:10px"><span style="color:var(--text-tertiary);font-size:0.82rem">Link de acesso</span><div style="font-weight:600;color:var(--text-primary);word-break:break-all">${loginUrl}</div></div>
                            <div style="margin-bottom:10px"><span style="color:var(--text-tertiary);font-size:0.82rem">E-mail</span><div style="font-weight:600;color:var(--text-primary)">${esc(email)}</div></div>
                            <div><span style="color:var(--text-tertiary);font-size:0.82rem">Senha temporaria</span><div style="font-weight:700;font-size:1.2rem;color:var(--accent-primary);font-family:JetBrains Mono,monospace;letter-spacing:1px">${esc(m.temp_password)}</div></div>
                        </div>

                        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                            <button class="btn btn-primary" id="btnCopyCredentials" style="font-size:0.88rem">Copiar para WhatsApp</button>
                            <button class="btn btn-secondary" id="btnCloseInvite" style="font-size:0.88rem">Fechar</button>
                        </div>
                    </div>`;

                $('btnCopyCredentials').addEventListener('click', () => {
                    navigator.clipboard.writeText(shareText).then(() => {
                        $('btnCopyCredentials').textContent = 'Copiado!';
                        toast('Credenciais copiadas! Cole no WhatsApp.');
                        setTimeout(() => { $('btnCopyCredentials').textContent = 'Copiar para WhatsApp'; }, 2000);
                    });
                });
                $('btnCloseInvite').addEventListener('click', () => {
                    closeActionModal();
                    if (currentPage === 'team') loadTeam();
                });

            } catch (e) {
                const msg = e.message || e.detail || JSON.stringify(e);
                $('fInviteResult').innerHTML = `<div class="form-error">${msg}</div>`;
                btn.disabled = false; btn.textContent = 'Enviar Convite';
            }
        });
    }

    function openEditMemberModal(member) {
        const isSelf = String(member.id) === String(currentUserId);
        openActionModal('Editar Perfil — ' + member.name, `
            <div class="form-card">
                <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)">
                    <div class="team-card-avatar" style="background:${member.color};width:56px;height:56px;font-size:1.2rem">${member.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}</div>
                    <div><div style="font-size:1.1rem;font-weight:700;color:var(--text-primary)">${esc(member.name)}</div><div style="color:var(--text-tertiary);font-size:0.88rem">${esc(member.email)}</div></div>
                </div>
                ${formRow('Nome', '', `<input class="input" id="eName" value="${esc(member.name)}">`)}
                ${formRow('E-mail', '', `<input class="input" id="eEmail" value="${esc(member.email)}" disabled style="opacity:0.6">`)}
                ${formRow('Cargo', '', `<select class="input" id="eRole">
                    <option value="member" ${member.role === 'member' ? 'selected' : ''}>Membro</option>
                    <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>`)}
                ${formRow('Cor do Avatar', '', `<input type="color" id="eColor" value="${member.color}" style="width:48px;height:36px;border:none;background:none;cursor:pointer">`)}
                <div class="form-actions">
                    <button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button>
                    <button class="btn btn-primary" id="eSubmit">Salvar</button>
                </div>
                <div id="eResult"></div>
            </div>`);
        $('eSubmit').addEventListener('click', async () => {
            const btn = $('eSubmit'); btn.disabled = true; btn.textContent = 'Salvando...';
            try {
                await ensureAuth();
                await api('PATCH', `/orgs/${ORG_ID}/members/${member.id}`, {
                    name: $('eName').value,
                    role: $('eRole').value,
                    color: $('eColor').value,
                });
                toast('Perfil atualizado!');
                closeActionModal();
                if (currentPage === 'team') loadTeam();
                if (isSelf) loadMyRole();
            } catch (e) {
                $('eResult').innerHTML = `<div class="form-error">${e.message || e.detail || JSON.stringify(e)}</div>`;
                btn.disabled = false; btn.textContent = 'Salvar';
            }
        });
    }

    // ================================================================
    //  MERGE REQUESTS
    // ================================================================
    let allMRsNormalized = [];
    let mrPage = 1;
    const MRS_PER_PAGE = 15;

    async function renderMergeRequests(q) {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div><h1 class="page-title">Merge Requests</h1><p class="page-subtitle">Todos os merge requests com análise detalhada da IA</p></div>
                <div class="page-actions">
                    <button class="btn btn-primary" id="btnBulkAnalysis">${icon('sparkles')} Análise Rápida</button>
                </div>
            </div>
            <!-- Filtros -->
            <div class="card" style="margin-bottom:16px">
                <div class="card-body" style="padding:16px">
                    <div class="filter-row">
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('search', 14)}</span>
                            <input class="input filter-input" id="mrSearch" type="text" placeholder="Buscar MR...">
                        </div>
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('calendar', 14)}</span>
                            <input class="input filter-input" id="mrDateFrom" type="date">
                            <span class="filter-input-hint">De</span>
                        </div>
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('calendar', 14)}</span>
                            <input class="input filter-input" id="mrDateTo" type="date">
                            <span class="filter-input-hint">Até</span>
                        </div>
                    </div>
                    <div class="filter-row" style="margin-top:10px">
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('activity', 14)}</span>
                            <select class="input filter-input" id="mrFilterStatus">
                                <option value="all">Status: Todos</option>
                                <option value="approved">Aprovado</option>
                                <option value="pending">Pendente</option>
                                <option value="issues">Issues</option>
                                <option value="analyzing">Analisando</option>
                                <option value="merged">Merged</option>
                            </select>
                        </div>
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('star', 14)}</span>
                            <select class="input filter-input" id="mrFilterScore">
                                <option value="all">Score: Todos</option>
                                <option value="high">65+ Verde</option>
                                <option value="medium">50-64 Amarelo</option>
                                <option value="low">0-49 Vermelho</option>
                            </select>
                        </div>
                        <div class="filter-input-wrap">
                            <span class="filter-input-icon">${icon('user', 14)}</span>
                            <select class="input filter-input" id="mrFilterAuthor">
                                <option value="all">Autor: Todos</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-title">Todos os MRs</span>
                    <span class="card-badge" id="mrPageCount">...</span>
                </div>
                <div class="mr-table-container" id="mrPageTable">${showLoading()}</div>
                <div id="mrPagination"></div>
            </div>`;
        if ($('btnBulkAnalysis')) $('btnBulkAnalysis').addEventListener('click', openBulkAddModal);

        try {
            const mrs = await loadAllMRs();
            allMRsNormalized = mrs.map(normalizeMR);
        } catch (_) {
            allMRsNormalized = typeof MERGE_REQUESTS !== 'undefined' ? MERGE_REQUESTS : [];
        }

        // Populate author filter
        const authors = [...new Set(allMRsNormalized.map(m => m.author.name))].sort();
        const authorSelect = $('mrFilterAuthor');
        authors.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; authorSelect.appendChild(o); });

        if (q) $('mrSearch').value = q;
        mrPage = 1;
        renderFilteredMRs();

        $('mrSearch').addEventListener('input', () => { mrPage = 1; renderFilteredMRs(); });
        if ($('mrDateFrom')) $('mrDateFrom').addEventListener('change', () => { mrPage = 1; renderFilteredMRs(); });
        if ($('mrDateTo')) $('mrDateTo').addEventListener('change', () => { mrPage = 1; renderFilteredMRs(); });
        $('mrFilterStatus').addEventListener('change', () => { mrPage = 1; renderFilteredMRs(); });
        $('mrFilterScore').addEventListener('change', () => { mrPage = 1; renderFilteredMRs(); });
        $('mrFilterAuthor').addEventListener('change', () => { mrPage = 1; renderFilteredMRs(); });
    }

    function renderFilteredMRs() {
        const q = ($('mrSearch') ? $('mrSearch').value : '').toLowerCase();
        const mrDateFrom = $('mrDateFrom') ? $('mrDateFrom').value : '';
        const mrDateTo = $('mrDateTo') ? $('mrDateTo').value : '';
        const status = $('mrFilterStatus') ? $('mrFilterStatus').value : 'all';
        const score = $('mrFilterScore') ? $('mrFilterScore').value : 'all';
        const author = $('mrFilterAuthor') ? $('mrFilterAuthor').value : 'all';

        let filtered = allMRsNormalized;
        if (q) filtered = filtered.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q));
        if (mrDateFrom) filtered = filtered.filter(m => m.createdAt && m.createdAt.slice(0, 10) >= mrDateFrom);
        if (mrDateTo) filtered = filtered.filter(m => m.createdAt && m.createdAt.slice(0, 10) <= mrDateTo);
        if (status !== 'all') filtered = filtered.filter(m => m.status === status);
        if (score === 'high') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore >= 65);
        else if (score === 'medium') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore >= 50 && m.aiScore < 65);
        else if (score === 'low') filtered = filtered.filter(m => m.aiScore !== null && m.aiScore < 50);
        if (author !== 'all') filtered = filtered.filter(m => m.author.name === author);

        const totalPages = Math.max(1, Math.ceil(filtered.length / MRS_PER_PAGE));
        if (mrPage > totalPages) mrPage = totalPages;
        const start = (mrPage - 1) * MRS_PER_PAGE;
        const pageMRs = filtered.slice(start, start + MRS_PER_PAGE);

        $('mrPageCount').textContent = filtered.length;
        $('mrPageTable').innerHTML = renderMRTable(pageMRs);
        attachTableListeners();

        $('mrPagination').innerHTML = totalPages > 1 ? `<div class="repo-pagination">
            <button class="btn btn-secondary btn-sm" id="mrPrev" ${mrPage <= 1 ? 'disabled' : ''}>${icon('chevron-left', 14)} Anterior</button>
            <span style="color:var(--text-secondary);font-size:0.88rem">Página <strong>${mrPage}</strong> de <strong>${totalPages}</strong></span>
            <button class="btn btn-secondary btn-sm" id="mrNext" ${mrPage >= totalPages ? 'disabled' : ''}>Próxima ${icon('chevron-right', 14)}</button>
        </div>` : '';

        if ($('mrPrev')) $('mrPrev').addEventListener('click', () => { mrPage--; renderFilteredMRs(); });
        if ($('mrNext')) $('mrNext').addEventListener('click', () => { mrPage++; renderFilteredMRs(); });
    }

    let sortCol = null, sortAsc = true;

    function sortMRs(mrs) {
        if (!sortCol) return mrs;
        const sorted = [...mrs];
        sorted.sort((a, b) => {
            let va, vb;
            if (sortCol === 'score') { va = a.aiScore ?? -1; vb = b.aiScore ?? -1; }
            else if (sortCol === 'author') { va = a.author.name.toLowerCase(); vb = b.author.name.toLowerCase(); }
            else if (sortCol === 'status') { va = a.status; vb = b.status; }
            else if (sortCol === 'time') { va = a.createdAt || ''; vb = b.createdAt || ''; }
            else if (sortCol === 'changes') { va = a.additions + a.deletions; vb = b.additions + b.deletions; }
            else return 0;
            if (va < vb) return sortAsc ? -1 : 1;
            if (va > vb) return sortAsc ? 1 : -1;
            return 0;
        });
        return sorted;
    }

    function sortIcon(col) {
        if (sortCol !== col) return `<span class="sort-icon">${icon('arrow-up-down', 12)}</span>`;
        return `<span class="sort-icon active">${sortAsc ? icon('arrow-up', 12) : icon('arrow-down', 12)}</span>`;
    }

    function renderMRTable(mrs) {
        if (!mrs.length) return `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><h3>Nenhum MR encontrado</h3></div>`;
        const sorted = sortMRs(mrs);
        return `<table class="mr-table"><thead><tr><th>Merge Request</th><th class="sortable" data-sort="author">Autor ${sortIcon('author')}</th><th class="sortable" data-sort="status">Status ${sortIcon('status')}</th><th class="sortable" data-sort="score">Score ${sortIcon('score')}</th><th class="sortable" data-sort="changes">Alterações ${sortIcon('changes')}</th><th class="sortable" data-sort="time">Tempo ${sortIcon('time')}</th></tr></thead><tbody>${sorted.map(mr => {
            const s = AnalysisEngine.getStatusInfo(mr.status), g = mr.aiScore !== null && mr.aiScore !== undefined ? AnalysisEngine.getScoreGrade(mr.aiScore) : null;
            const repoId = mr._repo_id || '';
            return `<tr data-mr-id="${mr.id}" data-repo-id="${repoId}"><td><div class="mr-title-cell"><span class="mr-title">${esc(mr.title)}</span><span class="mr-branch">${esc(mr.branch)} → ${esc(mr.targetBranch)}</span></div></td><td><div class="mr-author"><div class="mr-author-avatar" style="background:${mr.author.color}">${mr.author.initials}</div><span>${esc(mr.author.name)}</span></div></td><td><span class="badge ${s.class}">${s.icon} ${s.label}</span></td><td>${g ? `<div class="score-pill"><div class="score-ring ${g.class}">${mr.aiScore}</div></div>` : '<div class="analyzing-indicator"><div class="analyzing-dots"><span></span><span></span><span></span></div>Analisando</div>'}</td><td><span style="color:var(--accent-success)">+${mr.additions}</span> <span style="color:var(--accent-danger)">-${mr.deletions}</span></td><td style="color:var(--text-secondary);white-space:nowrap">${AnalysisEngine.timeAgo(mr.createdAt)}</td></tr>`;
        }).join('')}</tbody></table>`;
    }

    function attachTableListeners() {
        document.querySelectorAll('.mr-table tbody tr').forEach(row => row.addEventListener('click', () => {
            const mrId = row.dataset.mrId;
            const repoId = row.dataset.repoId;
            openMRDetail(mrId, repoId && repoId !== '' && repoId !== 'undefined' ? repoId : null);
        }));
        document.querySelectorAll('.mr-table th.sortable').forEach(th => th.addEventListener('click', e => {
            e.stopPropagation();
            const col = th.dataset.sort;
            if (sortCol === col) sortAsc = !sortAsc;
            else { sortCol = col; sortAsc = true; }
            if (currentPage === 'dashboard') renderDashMRs();
            else if (currentPage === 'merge-requests') renderFilteredMRs();
        }));
    }

    // ── MR Detail Modal ──────────────────────────────────────
    async function openMRDetail(mrId, repoId) {
        currentTab = 'overview';
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="overview"]').classList.add('active');
        modalBody.innerHTML = showLoading();
        modalTitle.textContent = 'Carregando...';
        modalSubtitle.textContent = '';
        modalOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        currentMR = null;

        // 1. Try API
        if (repoId) {
            try {
                const authed = await ensureAuth();
                if (authed) {
                    const mr = await api('GET', `/orgs/${ORG_ID}/repos/${repoId}/mrs/${mrId}`);
                    currentMR = normalizeMR(mr);
                    currentMR._repo_id = repoId;
                }
            } catch (_) {}
        }

        // 2. Try cached
        if (!currentMR) {
            const found = cachedMRs.find(m => String(m.id) === String(mrId));
            if (found) currentMR = normalizeMR(found);
        }

        // 3. Try mock data
        if (!currentMR && typeof MERGE_REQUESTS !== 'undefined') {
            const found = MERGE_REQUESTS.find(m => String(m.id) === String(mrId));
            if (found) currentMR = found; // mock data is already in the right format
        }

        if (!currentMR) {
            modalBody.innerHTML = '<div class="empty-state"><h3>MR nao encontrado</h3></div>';
            return;
        }

        modalTitle.textContent = currentMR.title;
        modalSubtitle.textContent = (currentMR.branch || '') + ' → ' + (currentMR.targetBranch || currentMR.target_branch || 'main');
        renderTabContent();
    }

    function renderTabContent() {
        if (!currentMR) return;
        ({ overview: renderOverviewTab, analysis: renderAnalysisTab, diff: renderDiffTab, rules: renderRulesTab, chat: renderChatTab }[currentTab] || renderOverviewTab)();
    }

    function renderOverviewTab() {
        const mr = currentMR, s = AnalysisEngine.getStatusInfo(mr.status);
        modalBody.innerHTML = `<div class="overview-grid"><div class="overview-item"><span class="overview-label">Autor</span><div class="mr-author" style="margin-top:4px"><div class="mr-author-avatar" style="background:${mr.author.color}">${mr.author.initials}</div><span class="overview-value">${esc(mr.author.name)}</span></div></div><div class="overview-item"><span class="overview-label">Status</span><span class="badge ${s.class}" style="margin-top:4px">${s.icon} ${s.label}</span></div><div class="overview-item"><span class="overview-label">Branch</span><span class="overview-value" style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">${esc(mr.branch)} → ${esc(mr.targetBranch)}</span></div><div class="overview-item"><span class="overview-label">Criado em</span><span class="overview-value">${new Date(mr.createdAt).toLocaleString('pt-BR')}</span></div><div class="overview-item" style="grid-column:1/-1"><span class="overview-label">Descrição</span><span class="overview-value">${esc(mr.description || 'Sem descrição')}</span></div></div><div class="overview-stats"><div class="overview-stat"><div class="overview-stat-value green">+${mr.additions}</div><div class="overview-stat-label">Adicoes</div></div><div class="overview-stat"><div class="overview-stat-value red">-${mr.deletions}</div><div class="overview-stat-label">Remocoes</div></div><div class="overview-stat"><div class="overview-stat-value blue">${mr.filesChanged}</div><div class="overview-stat-label">Arquivos</div></div></div>${mr.files && mr.files.length ? '<h3 style="margin-top:24px;margin-bottom:12px;font-size:1rem;font-weight:700">Arquivos Alterados</h3>' + mr.files.map(f => `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm);margin-bottom:4px;font-family:'JetBrains Mono',monospace;font-size:0.82rem"><span>📄 ${esc(f.name || f.file_path || '')}</span><span><span style="color:var(--accent-success)">+${f.additions}</span> <span style="color:var(--accent-danger)">-${f.deletions}</span></span></div>`).join('') : ''}
        ${mr._repo_id ? `<div style="margin-top:20px"><button class="btn btn-primary" id="btnTriggerAnalysis">${icon('refresh-cw')} Disparar Análise IA</button></div>` : ''}`;

        if (mr._repo_id && $('btnTriggerAnalysis')) {
            $('btnTriggerAnalysis').addEventListener('click', async () => {
                const btn = $('btnTriggerAnalysis'); btn.disabled = true; btn.textContent = 'Iniciando...';
                try {
                    await api('POST', `/orgs/${ORG_ID}/repos/${mr._repo_id}/mrs/${mr.id}/analyze`);
                    toast('Análise iniciada! Aguarde...'); btn.textContent = 'Análise em andamento...';
                    const repoId = mr._repo_id, mrId = mr.id;
                    let tries = 0;
                    const poll = setInterval(async () => {
                        tries++;
                        try {
                            const updated = await api('GET', `/orgs/${ORG_ID}/repos/${repoId}/mrs/${mrId}`);
                            if (updated.status === 'approved' || updated.status === 'issues' || tries >= 30) {
                                clearInterval(poll);
                                openMRDetail(mrId, repoId);
                            }
                        } catch (_) {
                            if (tries >= 30) { clearInterval(poll); btn.disabled = false; btn.textContent = 'Disparar Análise IA'; toast('Tempo esgotado. Verifique manualmente.', 'error'); }
                        }
                    }, 3000);
                } catch (e) { toast(e.message || 'Erro ao iniciar análise', 'error'); btn.disabled = false; btn.textContent = 'Disparar Análise IA'; }
            });
        }
    }

    function renderAnalysisTab() {
        const mr = currentMR;
        if (mr.aiScore === null || mr.aiScore === undefined) { modalBody.innerHTML = '<div class="empty-state"><div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px;margin-bottom:16px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Análise em andamento</div><h3>A IA esta analisando este MR</h3></div>'; return; }
        const g = AnalysisEngine.getScoreGrade(mr.aiScore);
        const cats = mr.analysisCategories || {};
        const hasCats = Object.keys(cats).length > 0;

        // Count issues by severity for filter chips
        const sevCounts = { critical: 0, warning: 0, info: 0, suggestion: 0 };
        (mr.issues || []).forEach(i => { const s = i.severity || 'info'; if (sevCounts[s] !== undefined) sevCounts[s]++; });

        const actionButtons = `<div class="analysis-actions" style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            <button class="btn btn-sm btn-outline" id="btnExportReport">${icon('download',14)} Exportar Relatório</button>
            <button class="btn btn-sm btn-outline" id="btnReanalyze">${icon('refresh-cw',14)} Re-analisar</button>
        </div>`;

        const filterChips = mr.issues.length ? `<div class="issue-filters" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <button class="issue-filter-chip active" data-sev="all">Todos (${mr.issues.length})</button>
            ${sevCounts.critical ? `<button class="issue-filter-chip critical" data-sev="critical">Critical (${sevCounts.critical})</button>` : ''}
            ${sevCounts.warning ? `<button class="issue-filter-chip warning" data-sev="warning">Warning (${sevCounts.warning})</button>` : ''}
            ${sevCounts.info ? `<button class="issue-filter-chip info" data-sev="info">Info (${sevCounts.info})</button>` : ''}
            ${sevCounts.suggestion ? `<button class="issue-filter-chip suggestion" data-sev="suggestion">Suggestion (${sevCounts.suggestion})</button>` : ''}
        </div>` : '';

        modalBody.innerHTML = `<div class="analysis-score-section"><div class="score-circle" style="--score-color:${g.color};--score-pct:${mr.aiScore};color:${g.color}">${mr.aiScore}</div><div class="score-details"><div class="score-title">${g.label}</div><div class="score-description">${g.description}</div>${actionButtons}</div></div>${hasCats ? `<div class="analysis-categories">${Object.entries(cats).map(([k,v]) => `<div class="category-card"><div class="category-header"><span class="category-name">${AnalysisEngine.getCategoryLabel(k)}</span><span class="category-score" style="color:${AnalysisEngine.getCategoryColor(v)}">${v}/100</span></div><div class="category-bar"><div class="category-bar-fill" style="width:${v}%;background:${AnalysisEngine.getCategoryColor(v)}"></div></div></div>`).join('')}</div>` : ''}${mr.issues.length ? `<div class="issues-section"><h3>Issues (${mr.issues.length})</h3>${filterChips}<div id="issuesList">${_renderIssueCards(mr.issues)}</div></div>` : '<div class="empty-state" style="padding:30px"><h3>Sem issues!</h3></div>'}`;

        // Bind action buttons
        const btnExport = $('btnExportReport');
        if (btnExport) btnExport.addEventListener('click', () => exportAnalysisReport(mr));
        const btnReanalyze = $('btnReanalyze');
        if (btnReanalyze) btnReanalyze.addEventListener('click', () => reanalyzeCurrentMR(mr));

        // Bind filter chips
        document.querySelectorAll('.issue-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.issue-filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                const sev = chip.dataset.sev;
                const filtered = sev === 'all' ? mr.issues : mr.issues.filter(i => (i.severity || 'info') === sev);
                const list = $('issuesList');
                if (list) list.innerHTML = _renderIssueCards(filtered);
                refreshIcons();
            });
        });
        refreshIcons();
    }

    function _renderIssueCards(issues) {
        return issues.map(i => {
            const sev = i.severity || 'info';
            const title = i.title || '';
            const file = i.file || i.file_path || '';
            const desc = i.description || '';
            const sug = i.suggestion || '';
            return `<div class="issue-card ${sev}"><div class="issue-header"><span class="issue-title">${esc(title)}</span><span class="issue-severity ${sev}">${sev.toUpperCase()}</span></div>${file ? `<div class="issue-file">${esc(file)}${i.line_ref ? ':' + i.line_ref : ''}</div>` : ''}<div class="issue-description">${esc(desc)}</div>${sug ? `<div class="issue-suggestion"><strong>${icon('lightbulb', 14)} Sugestão</strong> ${esc(sug)}</div>` : ''}</div>`;
        }).join('') || '<div style="padding:20px;text-align:center;color:var(--text-tertiary)">Nenhuma issue nesta categoria</div>';
    }

    function exportAnalysisReport(mr) {
        toast('Gerando relatório...');
        const g = AnalysisEngine.getScoreGrade(mr.aiScore);
        const cats = mr.analysisCategories || {};
        const hasCats = Object.keys(cats).length > 0;
        const SC = { critical: '#f87171', danger: '#f87171', warning: '#fbbf24', info: '#60a5fa', suggestion: '#34d399' };

        const sec = (title, icon, content) => `<div style="margin-bottom:28px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #e2e8f0"><span style="font-size:1.1rem">${icon}</span><h3 style="font-size:0.95rem;font-weight:700;color:#1e293b;margin:0">${title}</h3></div>${content}</div>`;

        // ── Categorias ──
        let catsHtml = '';
        if (hasCats) {
            catsHtml = sec('Categorias', '📊', Object.entries(cats).map(([k, v]) => {
                const label = AnalysisEngine.getCategoryLabel(k);
                const c = v >= 65 ? '#34d399' : v >= 50 ? '#fbbf24' : '#f87171';
                return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:5px"><span style="color:#475569">${label}</span><span style="color:${c};font-weight:700">${v}/100</span></div><div style="background:#e2e8f0;border-radius:4px;height:10px;overflow:hidden"><div style="background:${c};height:100%;width:${v}%;border-radius:4px"></div></div></div>`;
            }).join(''));
        }

        // ── Issues ──
        let issuesHtml = '';
        if (mr.issues && mr.issues.length) {
            issuesHtml = sec('Análise da IA — Issues (' + mr.issues.length + ')', '🔍', mr.issues.map(i => {
                const sev = i.severity || 'info';
                const c = SC[sev] || '#60a5fa';
                const file = i.file_path || i.file || '';
                return `<div style="background:#f8fafc;border-left:3px solid ${c};border-radius:8px;padding:14px 16px;margin-bottom:10px;border:1px solid #e2e8f0;border-left:3px solid ${c}">` +
                    `<div style="margin-bottom:6px"><span style="display:inline-block;background:${c}20;color:${c};padding:3px 10px;border-radius:12px;font-size:0.68rem;font-weight:800;text-transform:uppercase;letter-spacing:0.5px">${sev}</span> <span style="font-weight:600;font-size:0.85rem;color:#1e293b;margin-left:6px">${esc(i.title || '')}</span></div>` +
                    (file ? `<div style="font-size:0.73rem;color:#64748b;margin-bottom:5px">📁 ${esc(file)}${i.line_ref ? ':' + i.line_ref : ''}</div>` : '') +
                    (i.description ? `<div style="font-size:0.8rem;color:#475569;line-height:1.5;margin-bottom:6px">${esc(i.description)}</div>` : '') +
                    (i.suggestion ? `<div style="font-size:0.76rem;color:#166534;background:#f0fdf4;padding:10px 12px;border-radius:6px;border-left:2px solid #34d399;margin-top:8px;line-height:1.5">💡 <strong>Sugestão:</strong> ${esc(i.suggestion)}</div>` : '') +
                    '</div>';
            }).join(''));
        }

        // ── Diff ──
        let diffHtml = '';
        if (mr.diff && mr.diff.length) {
            diffHtml = sec('Diff — Código Fonte', '📝', mr.diff.map(f => {
                const anns = f.annotations || [];
                const aMap = {};
                anns.forEach(a => { aMap[a.afterLine || a.after_line] = a; });
                (mr.issues || []).filter(i => (i.file_path || i.file || '') === f.file).forEach(iss => {
                    const ln = parseInt(iss.line_ref || iss.lineRef || 0);
                    if (!ln) return;
                    if (aMap[ln]) { if (iss.suggestion && !aMap[ln].suggestion) aMap[ln].suggestion = iss.suggestion; }
                    else { aMap[ln] = { type: iss.severity === 'critical' ? 'danger' : iss.severity === 'warning' ? 'warning' : 'info', text: iss.title + (iss.description ? ' — ' + iss.description : ''), suggestion: iss.suggestion || '' }; }
                });
                let lh = '';
                const dt = f.diff_text || '';
                if (dt) {
                    let ln = 0;
                    for (const dl of dt.split('\n')) {
                        if (dl.startsWith('diff --git') || dl.startsWith('---') || dl.startsWith('+++') || dl.startsWith('@@')) {
                            lh += `<div style="background:#e2e8f0;color:#475569;padding:3px 12px;font-size:0.7rem;font-family:monospace">${esc(dl)}</div>`;
                            if (dl.startsWith('@@')) { const m = dl.match(/@@ .+\+(\d+)/); if (m) ln = parseInt(m[1]) - 1; }
                            continue;
                        }
                        ln++;
                        const isA = dl.startsWith('+'), isR = dl.startsWith('-');
                        const ct = isA || isR ? dl.slice(1) : dl;
                        const an = aMap[ln];
                        let bg = isA ? '#dcfce7' : isR ? '#fee2e2' : '#ffffff';
                        if (an) bg = an.type === 'danger' ? '#fee2e2' : an.type === 'warning' ? '#fef9c3' : '#dbeafe';
                        const lbc = an ? (an.type === 'danger' ? '#f87171' : an.type === 'warning' ? '#fbbf24' : '#60a5fa') : 'transparent';
                        lh += `<div style="display:flex;background:${bg};border-left:2px solid ${lbc};font-size:0.72rem;line-height:1.7;font-family:'JetBrains Mono',Consolas,monospace"><span style="width:36px;text-align:right;padding-right:8px;color:#94a3b8;flex-shrink:0">${ln}</span><span style="flex:1;white-space:pre-wrap;word-break:break-all;color:#1e293b">${esc(ct)}</span></div>`;
                        if (an) {
                            const ac = an.type === 'danger' ? '#f87171' : an.type === 'warning' ? '#fbbf24' : '#60a5fa';
                            const al = an.type === 'danger' ? '🔴 PROBLEMA' : an.type === 'warning' ? '🟡 ATENÇÃO' : '🔵 INFO';
                            lh += `<div style="background:${ac}0d;border-left:3px solid ${ac};padding:8px 12px 8px 46px;font-size:0.74rem"><div style="margin-bottom:3px"><strong style="color:${ac};font-size:0.68rem">${al}</strong></div><div style="color:#475569;line-height:1.5">${esc(an.text || '')}</div>`;
                            if (an.suggestion) lh += `<div style="color:#166534;margin-top:6px;padding:6px 8px;background:#f0fdf4;border-radius:4px;font-size:0.72rem;line-height:1.5">💡 <strong>Sugestão:</strong> ${esc(an.suggestion)}</div>`;
                            lh += '</div>';
                        }
                    }
                }
                return `<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:14px"><div style="background:#f1f5f9;padding:9px 14px;font-size:0.8rem;font-weight:600;color:#1e293b">📄 ${esc(f.file)}</div><div>${lh || '<div style="padding:12px;color:#64748b;font-size:0.8rem">Sem código disponível</div>'}</div></div>`;
            }).join(''));
        }

        // ── Regras ──
        let rulesHtml = '';
        if (mr.rules && mr.rules.length) {
            const rc = AnalysisEngine.countRules(mr.rules.map(r => ({ status: r.status || 'warn' })));
            const ri = { pass: '✅', fail: '❌', warn: '⚠️' };
            const rcol = { pass: '#34d399', fail: '#f87171', warn: '#fbbf24' };
            const summary = `<table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tr>` +
                `<td style="width:33%;text-align:center;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px"><div style="font-size:1.6rem;font-weight:800;color:#16a34a">${rc.pass}</div><div style="font-size:0.73rem;color:#475569;margin-top:2px">Aprovadas</div></td>` +
                `<td style="width:8px"></td>` +
                `<td style="width:33%;text-align:center;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px"><div style="font-size:1.6rem;font-weight:800;color:#dc2626">${rc.fail}</div><div style="font-size:0.73rem;color:#475569;margin-top:2px">Reprovadas</div></td>` +
                `<td style="width:8px"></td>` +
                `<td style="width:33%;text-align:center;background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px"><div style="font-size:1.6rem;font-weight:800;color:#ca8a04">${rc.warn}</div><div style="font-size:0.73rem;color:#475569;margin-top:2px">Atenção</div></td>` +
            `</tr></table>`;
            const list = mr.rules.map(r => {
                const st = r.status || 'warn';
                return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px"><span style="font-size:1rem;flex-shrink:0">${ri[st] || '⚠️'}</span><div style="flex:1"><div style="font-weight:600;font-size:0.82rem;color:#1e293b">${esc(r.name || r.rule_name || '')}</div>${r.description || r.desc ? `<div style="font-size:0.74rem;color:#64748b;margin-top:2px">${esc(r.description || r.desc)}</div>` : ''}</div><span style="color:${rcol[st]};font-size:0.7rem;font-weight:700;text-transform:uppercase">${st === 'pass' ? 'APROVADA' : st === 'fail' ? 'REPROVADA' : 'ATENÇÃO'}</span></div>`;
            }).join('');
            rulesHtml = sec('Regras de Qualidade', '📋', summary + list);
        }

        // ── Score header ──
        const scoreColor = g.color;
        const scoreHtml = `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:28px;text-align:center">` +
            `<div style="display:inline-block;width:100px;height:100px;border-radius:50%;border:5px solid ${scoreColor};line-height:90px;font-size:2.2rem;font-weight:900;color:${scoreColor};margin-bottom:12px">${mr.aiScore ?? '—'}</div>` +
            `<div style="font-size:1.1rem;font-weight:800;color:${scoreColor};margin-bottom:4px">${g.label}</div>` +
            `<div style="font-size:0.82rem;color:#475569;max-width:500px;margin:0 auto;line-height:1.5">${g.description}</div>` +
        `</div>`;

        // ── Assemble ──
        const bodyHtml = `
            <div style="text-align:center;margin-bottom:8px">
                <div style="font-size:1.8rem;font-weight:900;color:#6366f1;letter-spacing:-0.5px">Codexify</div>
                <div style="font-size:0.7rem;color:#64748b;letter-spacing:3px;text-transform:uppercase;margin-top:2px">Relatório de Análise de Código</div>
            </div>
            <div style="height:1px;background:linear-gradient(90deg,transparent,#6366f1,transparent);margin:16px 0 24px 0"></div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:24px">
                <h2 style="font-size:1.1rem;margin:0 0 10px 0;color:#1e293b;font-weight:700">${esc(mr.title)}</h2>
                <table style="border-collapse:collapse;font-size:0.8rem;color:#475569"><tr>
                    <td style="padding-right:20px">Branch: <strong style="color:#6366f1">${esc(mr.branch)} → ${esc(mr.targetBranch)}</strong></td>
                    <td style="padding-right:20px">Autor: <strong style="color:#1e293b">${esc(mr.author?.name || '')}</strong></td>
                    <td>Data: <strong style="color:#1e293b">${new Date().toLocaleDateString('pt-BR')}</strong></td>
                </tr></table>
            </div>
            ${scoreHtml}
            ${catsHtml}
            ${issuesHtml}
            ${diffHtml}
            ${rulesHtml}
            <div style="text-align:center;padding-top:20px;margin-top:12px;border-top:1px solid #e2e8f0">
                <div style="font-size:0.68rem;color:#64748b">Gerado por <strong style="color:#6366f1">Codexify AI</strong> — ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}</div>
            </div>`;

        // ── Open popup with print-to-PDF (native browser, 100% reliable) ──
        const safeBody = bodyHtml.replace(/<\/script>/g, '<\\/script>');
        const win = window.open('', '_blank');
        if (!win) { toast('Popup bloqueado pelo navegador. Permita popups para este site.', 'error'); return; }

        win.document.open();
        win.document.write([
            '<!DOCTYPE html><html><head><meta charset="UTF-8">',
            '<title>Codexify — Relatório de Análise</title>',
            '<style>',
            '*{margin:0;padding:0;box-sizing:border-box}',
            'body{background:#ffffff;color:#1e293b;font-family:Inter,Arial,Helvetica,sans-serif;padding:32px 28px;max-width:900px;margin:0 auto}',
            '@media print{',
            '  body{padding:16px 12px}',
            '  .no-print{display:none!important}',
            '  @page{margin:10mm 8mm;size:A4}',
            '}',
            '</style>',
            '</head><body>',
            safeBody,
            '<div class="no-print" style="position:fixed;bottom:0;left:0;right:0;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;padding:14px;z-index:9999">',
            '<button onclick="window.print()" style="background:#6366f1;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-weight:700;cursor:pointer;font-size:0.9rem;letter-spacing:0.3px">Salvar como PDF</button>',
            '<span style="display:block;margin-top:6px;font-size:0.72rem;color:#64748b">Na janela de impressão, selecione <strong style=color:#475569>Salvar como PDF</strong> e clique em Salvar</span>',
            '</div>',
            '<div style="height:60px" class="no-print"></div>',
            '<script>setTimeout(function(){window.print()},800)<\/script>',
            '</body></html>',
        ].join(''));
        win.document.close();
        toast('Relatório aberto — salve como PDF na janela de impressão.');
    }

    async function reanalyzeCurrentMR(mr) {
        if (!mr._repo_id || !mr.id) { toast('Não é possível re-analisar este MR', 'error'); return; }
        try {
            await ensureAuth();
            await api('POST', `/orgs/${ORG_ID}/repos/${mr._repo_id}/mrs/${mr.id}/analyze`);
            toast('Re-análise iniciada! Aguarde...');
            const repoId = mr._repo_id, mrId = mr.id;
            let tries = 0;
            const poll = setInterval(async () => {
                tries++;
                try {
                    const updated = await api('GET', `/orgs/${ORG_ID}/repos/${repoId}/mrs/${mrId}`);
                    if (updated.status === 'approved' || updated.status === 'issues' || tries >= 30) {
                        clearInterval(poll);
                        openMRDetail(mrId, repoId);
                    }
                } catch (_) {
                    if (tries >= 30) { clearInterval(poll); toast('Tempo esgotado. Verifique manualmente.', 'error'); }
                }
            }, 3000);
        } catch (e) { toast(e.message || 'Erro ao re-analisar', 'error'); }
    }

    function renderDiffTab() {
        const mr = currentMR;
        if (!mr.diff || !mr.diff.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Diff não disponível</h3><p>O diff será carregado após a análise da IA</p></div>'; return; }

        // Merge issues into annotations for richer display
        const issuesByFile = {};
        (mr.issues || []).forEach(iss => {
            const fp = iss.file_path || iss.filePath || '';
            if (fp) {
                if (!issuesByFile[fp]) issuesByFile[fp] = [];
                issuesByFile[fp].push(iss);
            }
        });

        modalBody.innerHTML = mr.diff.map(f => {
            let h = '';
            const annotations = f.annotations || [];
            const annotMap = {};
            annotations.forEach(a => { annotMap[a.afterLine || a.after_line] = a; });

            // Also map issues by line — merge suggestion into existing annotations
            const fileIssues = issuesByFile[f.file] || [];
            fileIssues.forEach(iss => {
                const line = parseInt(iss.line_ref || iss.lineRef || 0);
                if (!line) return;
                if (annotMap[line]) {
                    if (iss.suggestion && !annotMap[line].suggestion) annotMap[line].suggestion = iss.suggestion;
                } else {
                    annotMap[line] = { type: iss.severity === 'critical' ? 'danger' : iss.severity === 'warning' ? 'warning' : 'info', text: iss.title + (iss.description ? ' — ' + iss.description : ''), suggestion: iss.suggestion || '' };
                }
            });

            if (f.lines && f.lines.length) {
                f.lines.forEach(l => {
                    const cls = l.type === 'added' ? 'added' : l.type === 'removed' ? 'removed' : '';
                    const sev = annotMap[l.num] ? ` line-${annotMap[l.num].type}` : '';
                    h += `<div class="diff-line ${cls}${sev}"><span class="diff-line-number">${l.num}</span><span class="diff-line-content">${esc(l.content)}</span></div>`;
                    const a = annotMap[l.num];
                    if (a) h += renderDiffAnnotation(a);
                });
            } else if (f.diff_text) {
                if (f.diff_text.trimStart().startsWith('diff --git') || f.diff_text.includes('\n@@')) {
                    h = renderRawDiff(f.diff_text, annotMap);
                } else {
                    h = renderRawFileContent(f.diff_text, annotMap);
                }
            } else if (annotations.length || fileIssues.length) {
                const allAnns = [...annotations];
                fileIssues.forEach(iss => {
                    allAnns.push({ type: iss.severity === 'critical' ? 'danger' : iss.severity === 'warning' ? 'warning' : 'info', text: iss.title + (iss.description ? ' — ' + iss.description : ''), suggestion: iss.suggestion || '' });
                });
                allAnns.forEach(a => { h += renderDiffAnnotation(a); });
            }

            const fileStats = annotations.length || fileIssues.length;
            const statsHtml = fileStats ? `<span class="diff-file-stats">${fileStats} anotação(ões)</span>` : '';

            return `<div class="diff-file"><div class="diff-file-header"><span>${icon('file-code', 14)} ${esc(f.file)}</span>${statsHtml}</div><div class="diff-content">${h || '<div class="diff-empty">Sem alterações anotadas</div>'}</div></div>`;
        }).join('');
        refreshIcons();
    }

    function renderDiffAnnotation(a) {
        const cls = a.type === 'danger' ? 'danger-annotation' : a.type === 'warning' ? 'warning-annotation' : 'info-annotation';
        const icn = a.type === 'danger' ? icon('alert-triangle', 14) : a.type === 'warning' ? icon('alert-circle', 14) : icon('check-circle', 14);
        const label = a.type === 'danger' ? 'Problema' : a.type === 'warning' ? 'Atenção' : 'Info';
        let suggestion = '';
        if (a.suggestion) {
            suggestion = `<div class="diff-annotation-suggestion">${icon('lightbulb', 13)} <strong>Sugestão:</strong> ${esc(a.suggestion)}</div>`;
        }
        return `<div class="diff-annotation ${cls}"><div class="diff-annotation-header"><div class="diff-annotation-icon">${icn}</div><span class="diff-annotation-label">${label}</span></div><div class="diff-annotation-text">${esc(a.text)}</div>${suggestion}</div>`;
    }

    function renderRawDiff(diffText, annotMap) {
        let h = '';
        const lines = diffText.split('\n');
        let lineNum = 0;
        for (const line of lines) {
            // Skip diff headers
            if (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
                h += `<div class="diff-line" style="color:var(--text-tertiary);background:var(--bg-tertiary)"><span class="diff-line-number"></span><span class="diff-line-content">${esc(line)}</span></div>`;
                if (line.startsWith('@@')) {
                    const match = line.match(/@@ .+\+(\d+)/);
                    if (match) lineNum = parseInt(match[1]) - 1;
                }
                continue;
            }
            lineNum++;
            const type = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
            const content = line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line;
            const sev = annotMap[lineNum] ? ` line-${annotMap[lineNum].type}` : '';
            h += `<div class="diff-line ${type}${sev}"><span class="diff-line-number">${lineNum}</span><span class="diff-line-content">${esc(content)}</span></div>`;
            const a = annotMap[lineNum];
            if (a) h += renderDiffAnnotation(a);
        }
        return h;
    }

    function renderRawFileContent(content, annotMap) {
        let h = '';
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const sev = annotMap[lineNum] ? ` line-${annotMap[lineNum].type}` : '';
            h += `<div class="diff-line added${sev}"><span class="diff-line-number">${lineNum}</span><span class="diff-line-content">${esc(lines[i])}</span></div>`;
            const a = annotMap[lineNum];
            if (a) h += renderDiffAnnotation(a);
        }
        return h;
    }

    function renderRulesTab() {
        const mr = currentMR;
        if (!mr.rules || !mr.rules.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Regras pendentes</h3><p>As regras serao avaliadas apos a análise da IA</p></div>'; return; }
        const rules = mr.rules.map(r => ({
            name: r.name || r.rule_name || '',
            status: r.status || 'warn',
            desc: r.desc || r.description || '',
        }));
        const c = AnalysisEngine.countRules(rules), icons = { pass: '✓', fail: '✗', warn: '⚠' };
        modalBody.innerHTML = `<div class="rules-summary"><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-success)">${c.pass}</div><div class="rules-summary-label">Aprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-danger)">${c.fail}</div><div class="rules-summary-label">Reprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-warning)">${c.warn}</div><div class="rules-summary-label">Atenção</div></div></div>${rules.map(r => `<div class="rule-item"><div class="rule-status-icon ${r.status}">${icons[r.status]}</div><div class="rule-info"><div class="rule-name">${esc(r.name)}</div><div class="rule-desc">${esc(r.desc)}</div></div></div>`).join('')}`;
    }

    // ── Chat Tab (P1) ──────────────────────────────────────────
    function renderChatTab() {
        const mr = currentMR;
        const suggestions = [
            'Quais sao os principais riscos de seguranca?',
            'Gere testes unitarios para este código',
            'Como melhorar a performance?',
            'Explique o que esse MR faz em resumo',
            'Tem algum bug potencial?',
        ];
        modalBody.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;min-height:400px">
                <div id="chatMessages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
                    <div style="padding:16px;background:var(--bg-tertiary);border-radius:var(--radius-md);color:var(--text-secondary)">
                        <div style="font-weight:700;margin-bottom:8px">${icon('message-circle', 16)} Chat com IA sobre "${esc(mr.title || 'este MR')}"</div>
                        <div style="font-size:0.85rem;color:var(--text-tertiary);margin-bottom:12px">Pergunte qualquer coisa sobre o código, issues, seguranca ou melhorias.</div>
                        <div style="display:flex;flex-wrap:wrap;gap:6px">
                            ${suggestions.map(s => `<button class="chat-suggestion" data-q="${esc(s)}" style="padding:6px 12px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:20px;font-size:0.78rem;color:var(--accent-primary);cursor:pointer;transition:all 0.15s">${esc(s)}</button>`).join('')}
                        </div>
                    </div>
                </div>
                <div style="display:flex;gap:8px;padding:12px;border-top:1px solid var(--border-color)">
                    <input class="input" id="chatInput" placeholder="Pergunte algo sobre o MR..." style="flex:1">
                    <button class="btn btn-primary" id="chatSend">Enviar</button>
                </div>
            </div>`;

        // Click suggestions
        modalBody.querySelectorAll('.chat-suggestion').forEach(btn => {
            btn.addEventListener('click', () => {
                $('chatInput').value = btn.dataset.q;
                $('chatSend').click();
            });
        });

        // Enter key
        $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('chatSend').click(); });

        $('chatSend').addEventListener('click', async () => {
            const input = $('chatInput');
            const q = input.value.trim();
            if (!q) return;

            const msgs = $('chatMessages');
            msgs.innerHTML += `<div style="align-self:flex-end;padding:10px 14px;background:var(--accent-primary);color:white;border-radius:var(--radius-md) var(--radius-md) 4px var(--radius-md);max-width:80%">${esc(q)}</div>`;
            input.value = '';

            const typingId = 'typing_' + Date.now();
            msgs.innerHTML += `<div id="${typingId}" style="align-self:flex-start;padding:10px 14px;background:var(--bg-tertiary);border-radius:var(--radius-md) var(--radius-md) var(--radius-md) 4px;color:var(--text-tertiary);max-width:85%"><div class="analyzing-dots" style="display:inline-flex"><span></span><span></span><span></span></div> Pensando...</div>`;
            msgs.scrollTop = msgs.scrollHeight;

            const btn = $('chatSend'); btn.disabled = true;
            let answered = false;

            // Try API first
            try {
                const authed = await ensureAuth();
                if (authed && mr._repo_id) {
                    let analysisId = mr._analysis_id;
                    if (!analysisId) {
                        const analyses = await api('GET', `/orgs/${ORG_ID}/repos/${mr._repo_id}/mrs/${mr.id}/analyses`);
                        if (analyses && analyses.length) analysisId = analyses[0].id;
                    }
                    if (analysisId) {
                        const res = await api('POST', `/analyses/${analysisId}/chat`, { question: q });
                        const el = document.getElementById(typingId);
                        if (el) { el.innerHTML = res.answer ? esc(res.answer).replace(/\n/g, '<br>') : 'Sem resposta'; el.style.color = 'var(--text-primary)'; }
                        answered = true;
                    }
                }
            } catch (_) {}

            // Fallback: generate local response from mock data
            if (!answered) {
                const el = document.getElementById(typingId);
                if (el) {
                    const localAnswer = generateLocalChatAnswer(mr, q);
                    el.innerHTML = localAnswer;
                    el.style.color = 'var(--text-primary)';
                }
            }

            btn.disabled = false;
            msgs.scrollTop = msgs.scrollHeight;
        });
    }

    function generateLocalChatAnswer(mr, question) {
        const q = question.toLowerCase();
        const issues = mr.issues || [];
        const cats = mr.analysisCategories || {};
        const title = mr.title || '';
        const files = mr.files || [];

        if (q.includes('risco') || q.includes('segur')) {
            const secIssues = issues.filter(i => i.severity === 'critical' || i.severity === 'warning');
            if (secIssues.length) {
                return `<strong>🔒 Riscos de Seguranca Identificados:</strong><br><br>` +
                    secIssues.map((i, idx) => `<strong>${idx+1}. ${esc(i.title)}</strong><br>${esc(i.description || '')}<br>${i.suggestion ? '<em>' + icon('lightbulb', 12) + ' ' + esc(i.suggestion) + '</em>' : ''}<br>`).join('<br>') +
                    `<br>Score de seguranca: <strong>${cats.security || 'N/A'}/100</strong>`;
            }
            return `Score de seguranca: <strong>${cats.security || 'N/A'}/100</strong>. Nenhum risco critico encontrado neste MR.`;
        }
        if (q.includes('teste') || q.includes('test')) {
            const fileNames = files.map(f => f.name || '').filter(Boolean);
            return `<strong>${icon('flask-conical', 14)} Sugestão de Testes para "${esc(title)}":</strong><br><br>` +
                `<code style="display:block;padding:12px;background:var(--bg-secondary);border-radius:8px;font-size:0.82rem;line-height:1.6;white-space:pre-wrap">` +
                `describe('${esc(title.split(' ').slice(0,3).join(' '))}', () => {\n` +
                fileNames.slice(0, 3).map(f => `  it('deve validar ${esc(f.split('/').pop())}', () => {\n    // Arrange\n    // Act\n    // Assert\n    expect(result).toBeDefined();\n  });\n`).join('\n') +
                `  it('deve tratar erros corretamente', () => {\n    expect(() => execute(null)).toThrow();\n  });\n` +
                `});</code><br>` +
                `Adapte os nomes e imports conforme a estrutura real do projeto.`;
        }
        if (q.includes('performance') || q.includes('otimiz')) {
            return `<strong>⚡ Análise de Performance:</strong><br><br>` +
                `Score de performance: <strong>${cats.performance || 'N/A'}/100</strong><br><br>` +
                (issues.filter(i => i.title && i.title.toLowerCase().includes('perform')).length ?
                    issues.filter(i => i.title && i.title.toLowerCase().includes('perform')).map(i => `• ${esc(i.title)}: ${esc(i.description || '')}`).join('<br>') :
                    `Nenhum issue especifico de performance. Verifique:<br>• Uso de cache para dados repetidos<br>• Queries N+1 em loops<br>• Lazy loading de componentes pesados<br>• Indices no banco de dados`);
        }
        if (q.includes('resum') || q.includes('o que') || q.includes('expliq')) {
            return `<strong>${icon('file-text', 14)} Resumo do MR "${esc(title)}":</strong><br><br>` +
                `• <strong>Branch:</strong> ${esc(mr.branch || '')} → ${esc(mr.targetBranch || '')}<br>` +
                `• <strong>Arquivos alterados:</strong> ${mr.filesChanged || files.length}<br>` +
                `• <strong>Adicoes:</strong> +${mr.additions || 0} / Remocoes: -${mr.deletions || 0}<br>` +
                `• <strong>Score IA:</strong> ${mr.aiScore || 'N/A'}/100<br><br>` +
                (mr.description ? `<strong>Descrição:</strong> ${esc(mr.description)}<br><br>` : '') +
                (issues.length ? `<strong>Issues encontradas:</strong> ${issues.length} (${issues.filter(i=>i.severity==='critical').length} criticas, ${issues.filter(i=>i.severity==='warning').length} warnings)` : 'Nenhuma issue encontrada.');
        }
        if (q.includes('bug') || q.includes('erro') || q.includes('problem')) {
            const criticals = issues.filter(i => i.severity === 'critical');
            if (criticals.length) {
                return `<strong>🐛 Bugs Potenciais Encontrados:</strong><br><br>` +
                    criticals.map((i, idx) => `<strong>${idx+1}. ${esc(i.title)}</strong><br>Arquivo: <code>${esc(i.file || i.file_path || 'N/A')}</code><br>${esc(i.description || '')}<br>${i.suggestion ? '<em>' + icon('lightbulb', 12) + ' Fix: ' + esc(i.suggestion) + '</em>' : ''}<br>`).join('<br>');
            }
            return `Nenhum bug critico encontrado pela análise. Score geral: <strong>${mr.aiScore || 'N/A'}/100</strong>. Revise warnings menores nas abas Análise e Regras.`;
        }
        // Default
        return `<strong>Sobre "${esc(title)}":</strong><br><br>` +
            `Score: <strong>${mr.aiScore || 'N/A'}/100</strong><br>` +
            `Issues: <strong>${issues.length}</strong><br>` +
            `Arquivos: <strong>${mr.filesChanged || files.length}</strong><br><br>` +
            `Experimente perguntar:<br>• "Quais os riscos de seguranca?"<br>• "Gere testes unitarios"<br>• "Como melhorar a performance?"<br>• "Tem algum bug?"`;
    }

    // ================================================================
    //  RULES PAGE
    // ================================================================
    let _rulesCache = [];

    async function renderRulesPage() {
        pageContent.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
                <div>
                    <h1 class="page-title">Regras de Negócio</h1>
                    <p class="page-subtitle">Configure as regras que a IA verifica em cada merge request</p>
                </div>
                ${isAdmin() ? '<button class="btn btn-primary" id="btnNewRule">+ Nova Regra</button>' : ''}
            </div>
            <div id="rulesPageContainer">${showLoading()}</div>`;

        if ($('btnNewRule')) $('btnNewRule').addEventListener('click', () => openRuleForm());

        try {
            await ensureAuth();
            const resp = await api('GET', `/orgs/${ORG_ID}/rules`);
            _rulesCache = Array.isArray(resp) ? resp : (resp.items || []);
            renderRulesGrid(_rulesCache);
        } catch (e) {
            console.warn('Erro ao carregar regras:', e);
            _rulesCache = [];
            renderRulesGrid(_rulesCache);
        }
    }

    function openRuleForm(rule) {
        const isEdit = !!rule;
        const title = isEdit ? 'Editar Regra' : 'Nova Regra';
        openActionModal(title, `
            <div style="display:flex;flex-direction:column;gap:16px;padding:8px 0">
                <div>
                    <label style="font-weight:600;margin-bottom:4px;display:block">Nome</label>
                    <input class="input" id="ruleFormName" value="${esc(rule ? rule.name : '')}" placeholder="Ex: Validar tratamento de erros async">
                </div>
                <div>
                    <label style="font-weight:600;margin-bottom:4px;display:block">Descrição</label>
                    <textarea class="input" id="ruleFormDesc" rows="3" style="resize:vertical" placeholder="Descreva o que a IA deve verificar...">${esc(rule ? (rule.description || '') : '')}</textarea>
                </div>
                <div>
                    <label style="font-weight:600;margin-bottom:4px;display:block">Severidade</label>
                    <select class="input" id="ruleFormSev" style="min-width:160px">
                        <option value="info" ${rule && rule.severity === 'info' ? 'selected' : ''}>Info</option>
                        <option value="warning" ${(!rule || rule.severity === 'warning') ? 'selected' : ''}>Warning</option>
                        <option value="critical" ${rule && rule.severity === 'critical' ? 'selected' : ''}>Critical</option>
                    </select>
                </div>
                <div>
                    <label style="font-weight:600;margin-bottom:4px;display:block">Dica para a IA (opcional)</label>
                    <textarea class="input" id="ruleFormHint" rows="2" style="resize:vertical" placeholder="Ex: Verifique se todo bloco async/await tem try-catch...">${esc(rule && rule.prompt_hint ? rule.prompt_hint : '')}</textarea>
                </div>
                <div style="display:flex;gap:10px;margin-top:8px">
                    <button class="btn btn-primary" id="ruleFormSave">${isEdit ? 'Salvar' : 'Criar Regra'}</button>
                    <button class="btn" id="ruleFormCancel" style="background:var(--bg-tertiary);color:var(--text-primary)">Cancelar</button>
                </div>
            </div>
        `);

        $('ruleFormCancel').addEventListener('click', closeActionModal);
        $('ruleFormSave').addEventListener('click', async () => {
            const name = $('ruleFormName').value.trim();
            const description = $('ruleFormDesc').value.trim();
            const severity = $('ruleFormSev').value;
            const prompt_hint = $('ruleFormHint').value.trim();

            if (!name) { toast('Nome e obrigatório', 'error'); return; }

            const btn = $('ruleFormSave');
            btn.disabled = true; btn.textContent = 'Salvando...';

            try {
                await ensureAuth();
                if (isEdit) {
                    await api('PATCH', `/orgs/${ORG_ID}/rules/${rule.id}`, { name, description, severity, prompt_hint });
                    toast('Regra atualizada!');
                } else {
                    await api('POST', `/orgs/${ORG_ID}/rules`, { name, description, severity, is_active: true, prompt_hint });
                    toast('Regra criada!');
                }
                closeActionModal();
                renderRulesPage();
            } catch (e) {
                toast(e.message || 'Erro ao salvar regra', 'error');
                btn.disabled = false; btn.textContent = isEdit ? 'Salvar' : 'Criar Regra';
            }
        });
    }

    async function deleteRule(ruleId, ruleName) {
        const confirmed = await confirmAction('Excluir Regra', `Tem certeza que deseja excluir a regra "${esc(ruleName)}"? Essa ação não pode ser desfeita.`);
        if (!confirmed) return;

        try {
            await ensureAuth();
            await api('DELETE', `/orgs/${ORG_ID}/rules/${ruleId}`);
            toast('Regra excluida!');
            renderRulesPage();
        } catch (e) {
            toast(e.message || 'Erro ao excluir regra', 'error');
        }
    }

    function renderRulesGrid(rules) {
        const container = $('rulesPageContainer');
        if (!rules.length) {
            container.innerHTML = `
                <div class="card" style="text-align:center;padding:40px">
                    <p style="font-size:1.1rem;margin-bottom:12px">Nenhuma regra configurada ainda</p>
                    <p style="color:var(--text-tertiary);margin-bottom:20px">Crie regras personalizadas para que a IA verifique em cada merge request</p>
                    <button class="btn btn-primary" onclick="document.getElementById('btnNewRule').click()">+ Criar primeira regra</button>
                </div>`;
            return;
        }

        container.innerHTML = `<div class="rules-page-grid">${rules.map((r, i) => `
            <div class="rule-config-card stagger-in" style="animation-delay:${i*0.06}s">
                <div class="rule-config-header">
                    <span class="rule-config-title">${esc(r.name)}</span>
                    <button class="rule-toggle ${r.is_active ? 'active' : ''}" data-rule-id="${r.id}"></button>
                </div>
                <div class="rule-config-desc">${esc(r.description || r.desc || '')}</div>
                <div class="rule-config-severity">
                    <span class="issue-severity ${r.severity}">${(r.severity || 'info').toUpperCase()}</span>
                    <span class="rule-status-label">${r.is_active ? 'Ativa' : 'Inativa'}</span>
                </div>
                ${r.is_builtin ? '<div style="margin-top:8px;font-size:0.75rem;color:var(--text-tertiary)">Regra do sistema</div>' : (isAdmin() ? `
                <div style="margin-top:10px;display:flex;gap:8px">
                    <button class="btn rule-edit-btn" data-rule-id="${r.id}" style="font-size:0.78rem;padding:4px 12px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:6px;cursor:pointer">Editar</button>
                    <button class="btn rule-delete-btn" data-rule-id="${r.id}" data-rule-name="${esc(r.name)}" style="font-size:0.78rem;padding:4px 12px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:6px;cursor:pointer">Excluir</button>
                </div>` : '')}
            </div>`).join('')}</div>`;

        // Toggle ativar/desativar
        container.querySelectorAll('.rule-toggle').forEach(t => t.addEventListener('click', async () => {
            const ruleId = t.dataset.ruleId;
            const rule = rules.find(x => String(x.id) === String(ruleId));
            if (!rule) return;

            const newActive = !rule.is_active;
            t.classList.toggle('active');
            rule.is_active = newActive;
            const label = t.closest('.rule-config-card').querySelector('.rule-status-label');
            if (label) label.textContent = newActive ? 'Ativa' : 'Inativa';

            try {
                await ensureAuth();
                await api('PATCH', `/orgs/${ORG_ID}/rules/${ruleId}`, { is_active: newActive });
            } catch (e) {
                toast('Erro ao atualizar regra', 'error');
                rule.is_active = !newActive;
                t.classList.toggle('active');
                if (label) label.textContent = !newActive ? 'Ativa' : 'Inativa';
            }
        }));

        // Editar
        container.querySelectorAll('.rule-edit-btn').forEach(b => b.addEventListener('click', () => {
            const rule = rules.find(x => String(x.id) === String(b.dataset.ruleId));
            if (rule) openRuleForm(rule);
        }));

        // Excluir
        container.querySelectorAll('.rule-delete-btn').forEach(b => b.addEventListener('click', () => {
            deleteRule(b.dataset.ruleId, b.dataset.ruleName);
        }));
    }

    // ================================================================
    //  SETTINGS PAGE
    // ================================================================
    async function renderSettingsPage() {
        pageContent.innerHTML = `<h1 class="page-title">Configurações</h1><p class="page-subtitle">Integrações e preferências — Codexify AI</p>
            <div id="settingsContainer">${showLoading()}</div>`;

        let settings = { auto_analyze: true, min_score_threshold: 50, notification_email: '', slack_webhook_url: '', discord_webhook_url: '' };
        try {
            await ensureAuth();
            const s = await api('GET', `/orgs/${ORG_ID}/settings`);
            if (s) settings = { ...settings, ...s };
        } catch (_) { /* use defaults */ }

        const savedGitToken = localStorage.getItem('cg_git_token') || '';
        const savedGitPlatform = localStorage.getItem('cg_git_platform') || 'github';

        $('settingsContainer').innerHTML = `
            <div class="settings-section stagger-in"><h3 class="settings-section-title">${icon('key')} Token Global Git</h3>
                <div style="margin-bottom:12px;padding:12px 16px;background:var(--bg-tertiary);border-radius:8px;font-size:0.85rem;color:var(--text-secondary)">
                    ${icon('info', 15)} Configure seu token aqui uma única vez. Ele será usado automaticamente ao adicionar repositórios — sem precisar colar toda vez.
                </div>
                <div class="settings-card">
                    <div class="settings-row"><div class="settings-row-info"><h4>Plataforma Padrão</h4><p>GitHub, GitLab ou Bitbucket</p></div><select class="settings-input" id="settingsGitPlatform" style="min-width:180px"><option value="github" ${savedGitPlatform === 'github' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${savedGitPlatform === 'gitlab' ? 'selected' : ''}>GitLab</option><option value="bitbucket" ${savedGitPlatform === 'bitbucket' ? 'selected' : ''}>Bitbucket</option></select></div>
                    <div class="settings-row"><div class="settings-row-info"><h4>Access Token</h4><p>Token com permissão de leitura dos repos</p></div><div style="display:flex;gap:8px;align-items:center"><input class="settings-input" id="settingsGitToken" type="password" value="${esc(savedGitToken)}" placeholder="ghp_... ou glpat-..." style="font-family:monospace"><button class="btn btn-secondary btn-sm" id="btnToggleToken" style="white-space:nowrap">${icon('eye', 14)}</button></div></div>
                    <div class="settings-row"><div class="settings-row-info"><h4>Status</h4><p>Verificar se o token é válido</p></div><div style="display:flex;align-items:center;gap:8px"><span id="tokenStatus" style="font-size:0.85rem;color:var(--text-tertiary)">${savedGitToken ? icon('check-circle', 14) + ' Token configurado' : icon('alert-circle', 14) + ' Nenhum token salvo'}</span></div></div>
                </div>
            </div>
            <div class="settings-section stagger-in" style="animation-delay:0.15s"><h3 class="settings-section-title">${icon('bot')} IA</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>Modelo</h4><p>Modelo de IA para análise</p></div><select class="settings-input" style="min-width:180px"><option>Claude Sonnet 4.6</option><option>Claude Opus 4.6</option><option>GPT-4o</option></select></div><div class="settings-row"><div class="settings-row-info"><h4>Análise Automatica</h4><p>Analisar novos MRs automaticamente</p></div><button class="rule-toggle ${settings.auto_analyze ? 'active' : ''}" id="autoToggle"></button></div><div class="settings-row"><div class="settings-row-info"><h4>Score Minimo</h4><p>MRs abaixo serao sinalizados</p></div><input class="settings-input" type="number" min="0" max="100" value="${settings.min_score_threshold}" id="settingsMinScore" style="min-width:100px;text-align:center"></div></div></div>
            <div class="settings-section stagger-in" style="animation-delay:0.3s"><h3 class="settings-section-title">${icon('bell')} Notificações</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>E-mail</h4><p>E-mail para notificacoes</p></div><input class="settings-input" type="email" value="${esc(settings.notification_email || '')}" id="settingsEmail" placeholder="equipe@empresa.com"></div><div class="settings-row"><div class="settings-row-info"><h4>Webhook Slack</h4></div><input class="settings-input" type="text" value="${esc(settings.slack_webhook_url || '')}" id="settingsSlack" placeholder="https://hooks.slack.com/..."></div><div class="settings-row"><div class="settings-row-info"><h4>Webhook Discord</h4></div><input class="settings-input" type="text" value="${esc(settings.discord_webhook_url || '')}" id="settingsDiscord" placeholder="https://discord.com/api/webhooks/..."></div></div></div>
            <div style="margin-top:20px"><button class="btn btn-primary" id="btnSaveSettings">${icon('save')} Salvar Configurações</button></div>`;

        const at = $('autoToggle'); if (at) at.addEventListener('click', () => at.classList.toggle('active'));

        $('btnToggleToken').addEventListener('click', () => {
            const inp = $('settingsGitToken');
            inp.type = inp.type === 'password' ? 'text' : 'password';
        });

        $('btnSaveSettings').addEventListener('click', async () => {
            const btn = $('btnSaveSettings'); btn.disabled = true; btn.textContent = 'Salvando...';
            try {
                // Save git token locally
                const gitToken = $('settingsGitToken').value.trim();
                const gitPlatform = $('settingsGitPlatform').value;
                if (gitToken) localStorage.setItem('cg_git_token', gitToken);
                else localStorage.removeItem('cg_git_token');
                localStorage.setItem('cg_git_platform', gitPlatform);
                $('tokenStatus').innerHTML = gitToken ? icon('check-circle', 14) + ' Token configurado' : icon('alert-circle', 14) + ' Nenhum token salvo';

                await ensureAuth();
                await api('PUT', `/orgs/${ORG_ID}/settings`, {
                    auto_analyze: $('autoToggle').classList.contains('active'),
                    min_score_threshold: parseInt($('settingsMinScore').value) || 75,
                    notification_email: $('settingsEmail').value,
                    slack_webhook_url: $('settingsSlack').value,
                    discord_webhook_url: $('settingsDiscord').value,
                });
                toast('Configurações salvas!');
            } catch (e) { toast(e.message || 'Erro ao salvar', 'error'); }
            btn.disabled = false; btn.innerHTML = icon('save') + ' Salvar Configurações';
        });
    }

    // ================================================================
    //  UPLOAD PAGE (P0) — analyze without GitHub/GitLab
    // ================================================================
    function renderUploadPage() {
        pageContent.innerHTML = `
            <h1 class="page-title">Análise Rápida</h1>
            <p class="page-subtitle">Envie um arquivo .patch, .zip ou cole o diff diretamente — sem conectar GitHub/GitLab</p>

            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title">Upload de Código</span></div>
                <div class="card-body" style="padding:24px">
                    ${formRow('Título', 'Descreva brevemente o que foi alterado', '<input class="input" id="upTitle" placeholder="Ex: Refatorar módulo de pagamentos">')}
                    ${formRow('Descrição', 'Opcional', '<textarea class="input" id="upDesc" rows="2" placeholder="Detalhes adicionais..." style="resize:vertical"></textarea>')}
                    <div id="upDropZone" class="upload-dropzone">
                        <div class="upload-dropzone-icon">${icon('upload-cloud', 40)}</div>
                        <div class="upload-dropzone-title">Arraste seu arquivo aqui</div>
                        <div class="upload-dropzone-sub">ou clique para selecionar</div>
                        <div class="upload-dropzone-formats">.py .js .ts .java .go .zip .patch</div>
                        <input type="file" id="upFile" accept=".py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.patch,.diff,.txt,.zip,.json,.yaml,.yml,.html,.css,.sql,.sh" style="display:none">
                        <div id="upFileName" class="upload-dropzone-file"></div>
                    </div>
                    <div style="text-align:center;color:var(--text-tertiary);margin:12px 0;font-weight:600">— OU —</div>
                    ${formRow('Diff inline', 'Cole o diff diretamente aqui', '<textarea class="input" id="upDiff" rows="8" style="width:100%;font-family:JetBrains Mono,monospace;font-size:0.82rem;resize:vertical" placeholder="diff --git a/file.py b/file.py\n--- a/file.py\n+++ b/file.py\n@@ -1,3 +1,4 @@\n+import os\n ..."></textarea>')}
                    <div style="margin-top:16px;display:flex;gap:12px;align-items:center">
                        <button class="btn btn-primary" id="upSubmit">${icon('sparkles')} Analisar com IA</button>
                        <span id="upStatus" style="color:var(--text-tertiary);font-size:0.9rem"></span>
                    </div>
                </div>
            </div>

            <!-- SSE Progress -->
            <div id="upProgress" style="display:none;margin-top:16px">
                <div class="card">
                    <div class="card-header"><span class="card-title">Progresso da Análise</span></div>
                    <div class="card-body" style="padding:24px;display:flex;flex-direction:column;align-items:center">
                        <div class="circle-progress" id="upCircle">
                            <svg viewBox="0 0 180 180"><circle class="track" cx="90" cy="90" r="80"/><circle class="fill" id="upCircleFill" cx="90" cy="90" r="80"/></svg>
                            <div class="center-text"><div class="pct" id="upPct">5%</div><div class="label" id="upStepLabel">Aguardando...</div></div>
                        </div>
                        <div class="progress-steps" id="upSteps" style="margin-top:20px">
                            <div class="progress-step active" id="upStep1"><div class="progress-step-icon">${icon('clock',14)}</div><span>Fila</span></div>
                            <div class="progress-step-line"></div>
                            <div class="progress-step" id="upStep2"><div class="progress-step-icon">${icon('code',14)}</div><span>Preparando</span></div>
                            <div class="progress-step-line"></div>
                            <div class="progress-step" id="upStep3"><div class="progress-step-icon">${icon('brain',14)}</div><span>IA Analisando</span></div>
                            <div class="progress-step-line"></div>
                            <div class="progress-step" id="upStep4"><div class="progress-step-icon">${icon('save',14)}</div><span>Salvando</span></div>
                            <div class="progress-step-line"></div>
                            <div class="progress-step" id="upStep5"><div class="progress-step-icon">${icon('check-circle',14)}</div><span>Pronto</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Result -->
            <div id="upResult" style="margin-top:16px"></div>`;

        $('upSubmit').addEventListener('click', handleUploadSubmit);

        const upDrop = $('upDropZone'), upFileIn = $('upFile');
        upDrop.addEventListener('click', () => upFileIn.click());
        upDrop.addEventListener('dragover', e => { e.preventDefault(); upDrop.classList.add('dragover'); });
        upDrop.addEventListener('dragleave', () => { upDrop.classList.remove('dragover'); });
        upDrop.addEventListener('drop', e => { e.preventDefault(); upDrop.classList.remove('dragover'); if (e.dataTransfer.files.length) { upFileIn.files = e.dataTransfer.files; showUpFileName(e.dataTransfer.files[0].name); } });
        upFileIn.addEventListener('change', () => { if (upFileIn.files.length) showUpFileName(upFileIn.files[0].name); });

        function showUpFileName(name) {
            const el = $('upFileName');
            el.classList.add('show');
            el.innerHTML = icon('check-circle', 16) + ' ' + esc(name);
        }
    }

    async function handleUploadSubmit() {
        const btn = $('upSubmit');
        const title = $('upTitle').value.trim();
        const desc = $('upDesc').value.trim();
        const diffText = $('upDiff').value.trim();
        const fileInput = $('upFile');
        const file = fileInput.files && fileInput.files[0];

        if (!title) { toast('Preencha o titulo', 'error'); return; }
        if (!file && !diffText) { toast('Envie um arquivo ou cole o diff', 'error'); return; }

        btn.disabled = true; btn.textContent = 'Enviando...';
        $('upStatus').textContent = '';

        try {
            await ensureAuth();

            const formData = new FormData();
            formData.append('mr_title', title);
            formData.append('mr_description', desc);
            if (diffText) formData.append('diff_text', diffText);
            if (file) formData.append('file', file);

            const r = await fetch(API + `/orgs/${ORG_ID}/upload-analysis`, {
                method: 'POST',
                headers: { ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
                body: formData,
            });
            const data = await r.json();
            if (!r.ok) throw data;

            toast('Análise iniciada!');
            $('upProgress').style.display = 'block';

            // Start SSE to track progress
            trackAnalysisSSE(data.analysis_id);

        } catch (e) {
            toast(e.message || e.detail || 'Erro ao enviar', 'error');
            btn.disabled = false; btn.textContent = 'Analisar com IA';
        }
    }

    function trackAnalysisSSE(analysisId) {
        const evtSource = new EventSource(API + `/analyses/${analysisId}/stream`);
        let pct = 0;
        let done = false;
        const labels = ['Preparando análise...', 'Lendo arquivo...', 'Carregando regras...', 'Enviando para IA...', 'IA analisando código...', 'Processando resultados...', 'Finalizando...'];
        let labelIdx = 0;

        // Contagem rápida autônoma: sobe até 90% sozinho
        const countInterval = setInterval(() => {
            if (done) return;
            if (pct < 30) pct += 2;
            else if (pct < 60) pct += 1;
            else if (pct < 80) pct += 0.5;
            else if (pct < 90) pct += 0.2;
            _updateProgressBar(Math.round(pct));
        }, 150);

        const labelInterval = setInterval(() => {
            if (done) return;
            if (labelIdx < labels.length - 1) labelIdx++;
            const el = $('upStepLabel');
            if (el) el.textContent = labels[labelIdx];
        }, 4000);

        function _updateProgressBar(val) {
            const fill = $('upCircleFill');
            const pctEl = $('upPct');
            if (fill) fill.style.strokeDashoffset = 502 - (502 * val / 100);
            if (pctEl) pctEl.textContent = val + '%';
            if (val >= 5) _activateStep('upStep1');
            if (val >= 20) _activateStep('upStep2');
            if (val >= 45) _activateStep('upStep3');
            if (val >= 85) _activateStep('upStep4');
            if (val >= 100) _activateStep('upStep5');
        }

        function _activateStep(id) {
            const el = $(id);
            if (el) el.classList.add('active');
        }

        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const label = $('upStepLabel');
            const fill = $('upCircleFill');

            if (data.progress_label && label) label.textContent = data.progress_label;

            if (data.status === 'completed') {
                done = true;
                clearInterval(countInterval);
                clearInterval(labelInterval);
                evtSource.close();
                _updateProgressBar(100);
                if (fill) fill.classList.add('done');
                if (label) label.textContent = 'Concluída!';

                setTimeout(() => {
                    $('upSubmit').disabled = false;
                    $('upSubmit').textContent = 'Analisar com IA';
                    toast('Análise concluída! Score: ' + data.ai_score);

                    const g = AnalysisEngine.getScoreGrade(data.ai_score);
                    $('upResult').innerHTML = `
                        <div class="card stagger-in">
                            <div class="card-header"><span class="card-title">Resultado</span><span class="card-badge" style="background:${g.color}20;color:${g.color}">${g.label}</span></div>
                            <div class="card-body" style="padding:24px;text-align:center">
                                <div class="score-circle" style="--score-color:${g.color};--score-pct:${data.ai_score};color:${g.color};margin:0 auto 16px">${data.ai_score}</div>
                                <p style="color:var(--text-secondary)">${g.description}</p>
                                <button class="btn btn-primary" style="margin-top:16px" onclick="document.querySelector('[data-page=merge-requests]').click()">Ver Detalhes</button>
                            </div>
                        </div>`;
                }, 1000);
            } else if (data.status === 'failed') {
                done = true;
                clearInterval(countInterval);
                clearInterval(labelInterval);
                evtSource.close();
                if (fill) fill.style.stroke = 'var(--accent-danger)';
                if (label) label.textContent = 'Erro';
                $('upSubmit').disabled = false;
                $('upSubmit').textContent = 'Analisar com IA';
                toast('Análise falhou', 'error');
            }
        };
        evtSource.onerror = () => { done = true; clearInterval(countInterval); clearInterval(labelInterval); evtSource.close(); };
    }

    // ================================================================
    //  ANALYTICS PAGE (P1) — historical analytics
    // ================================================================
    async function renderAnalyticsPage() {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div>
                    <h1 class="page-title">Analytics</h1>
                    <p class="page-subtitle">Métricas históricas, ranking de devs e evolução do score</p>
                </div>
            </div>
            <div id="analyticsContainer">${showLoading()}</div>`;

        try {
            await ensureAuth();
            const data = await api('GET', `/orgs/${ORG_ID}/dashboard/analytics`);
            renderAnalyticsData(data);
        } catch (e) {
            $('analyticsContainer').innerHTML = `<div class="empty-state-card"><h3>Sem dados</h3><p>${e.message || 'Adicione repositórios e análise MRs para ver analytics'}</p></div>`;
        }
    }

    function renderAnalyticsData(data) {
        const { dev_ranking = [], issue_heatmap = {}, score_evolution = [] } = data;

        let devRows = '';
        dev_ranking.forEach((d, i) => {
            const medal = i === 0 ? icon('crown', 18) : i === 1 ? icon('medal', 18) : i === 2 ? icon('award', 18) : `#${i+1}`;
            const g = d.avg_score > 0 ? AnalysisEngine.getScoreGrade(d.avg_score) : { color: 'var(--text-tertiary)' };
            devRows += `<tr>
                <td style="font-weight:700">${medal}</td>
                <td>${esc(d.author)}</td>
                <td style="color:${g.color};font-weight:700">${d.avg_score}</td>
                <td>${d.total_mrs}</td>
                <td style="color:var(--accent-success)">${d.approved}</td>
                <td style="color:var(--accent-danger)">${d.issues}</td>
            </tr>`;
        });

        const heatTotal = Object.values(issue_heatmap).reduce((a, b) => a + b, 0) || 1;

        const evolutionBars = score_evolution.map(s => {
            const val = s.avg_score || 0;
            const color = val >= 75 ? 'var(--accent-success)' : val >= 60 ? 'var(--accent-warning)' : val > 0 ? 'var(--accent-danger)' : 'var(--bg-tertiary)';
            return `<div class="chart-bar-group"><div class="chart-bar" style="height:${val > 0 ? (val/100)*120 : 5}px;background:${color}" data-value="${val || '-'}"></div><span class="chart-label">${s.week}</span></div>`;
        }).join('');

        $('analyticsContainer').innerHTML = `
            <!-- Dev Ranking -->
            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title"><span class="icon-bounce">${icon('trophy')}</span> Ranking de Desenvolvedores</span><span class="card-badge">${dev_ranking.length} devs</span></div>
                <div class="card-body">${dev_ranking.length ? `
                    <table class="mr-table"><thead><tr><th style="width:50px">#</th><th>Desenvolvedor</th><th>Score Médio</th><th>Total MRs</th><th>Aprovados</th><th>Issues</th></tr></thead>
                    <tbody>${devRows}</tbody></table>
                ` : '<div class="empty-state"><h3>Nenhum dado</h3></div>'}</div>
            </div>

            <div class="dashboard-grid" style="margin-top:16px">
                <!-- Issue Heatmap -->
                <div class="card stagger-in" style="animation-delay:0.2s">
                    <div class="card-header"><span class="card-title"><span class="icon-pulse">${icon('flame')}</span> Heatmap de Issues</span></div>
                    <div class="card-body" style="padding:24px">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-danger)">${issue_heatmap.critical || 0}</div>
                                <div style="color:var(--text-primary);font-size:0.85rem;font-weight:600;margin-top:4px">Críticas</div>
                                <div style="margin-top:6px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.critical||0)/heatTotal)*100}%;background:var(--accent-danger);border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-warning)">${issue_heatmap.warning || 0}</div>
                                <div style="color:var(--text-primary);font-size:0.85rem;font-weight:600;margin-top:4px">Avisos</div>
                                <div style="margin-top:6px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.warning||0)/heatTotal)*100}%;background:var(--accent-warning);border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:#60a5fa">${issue_heatmap.info || 0}</div>
                                <div style="color:var(--text-primary);font-size:0.85rem;font-weight:600;margin-top:4px">Informativas</div>
                                <div style="margin-top:6px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.info||0)/heatTotal)*100}%;background:#60a5fa;border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-success)">${issue_heatmap.suggestion || 0}</div>
                                <div style="color:var(--text-primary);font-size:0.85rem;font-weight:600;margin-top:4px">Sugestões</div>
                                <div style="margin-top:4px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.suggestion||0)/heatTotal)*100}%;background:var(--accent-success);border-radius:2px"></div></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Score Evolution -->
                <div class="card stagger-in" style="animation-delay:0.3s">
                    <div class="card-header"><span class="card-title"><span class="icon-bounce">${icon('trending-up')}</span> Evolução do Score</span><span class="card-badge">Últimas 8 semanas</span></div>
                    <div class="card-body"><div class="chart-container">${evolutionBars || '<div style="padding:20px;color:var(--text-tertiary)">Sem dados</div>'}</div></div>
                </div>
            </div>`;
    }

    // ================================================================
    //  BILLING PAGE (P2) — Plans + Usage
    // ================================================================
    async function renderBillingPage() {
        pageContent.innerHTML = `
            <h1 class="page-title">Planos & Cobranca</h1>
            <p class="page-subtitle">Gerencie seu plano e acompanhe o uso</p>
            <div id="billingContainer">${showLoading()}</div>`;

        try {
            await ensureAuth();
            const [plans, sub] = await Promise.all([
                api('GET', `/orgs/${ORG_ID}/billing/plans`),
                api('GET', `/orgs/${ORG_ID}/billing/subscription`),
            ]);
            renderBillingUI(plans, sub);
        } catch (e) {
            $('billingContainer').innerHTML = `<div class="empty-state-card"><h3>Erro</h3><p>${e.message || e.detail || 'Execute a migracao 003_billing_plans.sql no Supabase'}</p></div>`;
        }
    }

    function renderBillingUI(plans, sub) {
        const currentSlug = sub.plan?.slug || 'free';
        const usage = sub.usage || {};
        const plan = sub.plan || {};

        const usageBar = (label, current, max) => {
            const pct = max === -1 ? 5 : Math.min((current / max) * 100, 100);
            const color = pct >= 90 ? 'var(--accent-danger)' : pct >= 70 ? 'var(--accent-warning)' : 'var(--accent-success)';
            return `<div style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:4px">
                    <span style="color:var(--text-secondary)">${label}</span>
                    <span style="font-weight:700;color:${color}">${current} / ${max === -1 ? '∞' : max}</span>
                </div>
                <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.3s"></div>
                </div>
            </div>`;
        };

        const planCard = (p) => {
            const isCurrent = p.slug === currentSlug;
            const price = p.price_monthly === 0 ? 'Gratis' : `$${(p.price_monthly / 100).toFixed(0)}/mes`;
            return `<div class="rule-config-card" style="border:${isCurrent ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)'};position:relative">
                ${isCurrent ? '<div style="position:absolute;top:-10px;right:12px;background:var(--accent-primary);color:white;padding:2px 10px;border-radius:10px;font-size:0.75rem;font-weight:700">ATUAL</div>' : ''}
                <div style="font-size:1.2rem;font-weight:800;color:var(--text-primary);margin-bottom:4px">${esc(p.name)}</div>
                <div style="font-size:1.6rem;font-weight:800;color:var(--accent-primary);margin-bottom:12px">${price}</div>
                <div style="font-size:0.85rem;color:var(--text-secondary);line-height:1.8">
                    <div>${icon('folder-git-2', 14)} ${p.max_repos === -1 ? 'Repos ilimitados' : p.max_repos + ' repos'}</div>
                    <div>${icon('search', 14)} ${p.max_analyses === -1 ? 'Análises ilimitadas' : p.max_analyses + ' análises/mes'}</div>
                    <div>${icon('users', 14)} ${p.max_members === -1 ? 'Membros ilimitados' : p.max_members + ' membros'}</div>
                    <div>${icon('message-circle', 14)} ${p.max_chat_msgs === -1 ? 'Chat ilimitado' : p.max_chat_msgs + ' msgs chat/mes'}</div>
                </div>
                ${!isCurrent ? `<button class="btn ${p.price_monthly > 0 ? 'btn-primary' : 'btn-secondary'}" style="width:100%;margin-top:16px" data-change-plan="${p.slug}">${p.price_monthly > 0 ? 'Upgrade' : 'Selecionar'}</button>` : '<div style="margin-top:16px;text-align:center;color:var(--accent-success);font-weight:600">Plano ativo</div>'}
            </div>`;
        };

        $('billingContainer').innerHTML = `
            <!-- Current Usage -->
            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title">Uso Atual — ${esc(plan.name || 'Free')}</span></div>
                <div class="card-body" style="padding:24px">
                    ${usageBar('Análises IA', usage.analyses || 0, plan.max_analyses || 50)}
                    ${usageBar('Mensagens Chat', usage.chat_msgs || 0, plan.max_chat_msgs || 20)}
                    ${usageBar('Chamadas API', usage.api_calls || 0, plan.max_analyses || 50)}
                </div>
            </div>

            <!-- Plans Grid -->
            <h3 style="margin:24px 0 16px;font-weight:700;color:var(--text-primary)">Escolha seu plano</h3>
            <div class="rules-page-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
                ${plans.map(planCard).join('')}
            </div>

            <!-- API Key section -->
            <div class="card stagger-in" style="animation-delay:0.3s;margin-top:24px">
                <div class="card-header"><span class="card-title">${icon('key')} API Key (para CLI / CI/CD)</span></div>
                <div class="card-body" style="padding:24px">
                    <p style="color:var(--text-secondary);margin-bottom:12px">Crie uma API key para usar no CLI ou CI/CD. A key sera exibida apenas uma vez.</p>
                    <div style="display:flex;gap:8px">
                        <input class="input" id="apiKeyName" placeholder="Nome da key (ex: CI Pipeline)" style="flex:1">
                        <button class="btn btn-primary" id="btnCreateKey">Criar Key</button>
                    </div>
                    <div id="apiKeyResult" style="margin-top:12px"></div>
                    <div style="margin-top:16px;padding:12px;background:var(--bg-tertiary);border-radius:var(--radius-md);font-family:JetBrains Mono,monospace;font-size:0.82rem;color:var(--text-secondary)">
                        <strong>Uso no CLI:</strong><br>
                        <code>curl -X POST ${window.location.origin}/api/v1/public/analyze \\<br>
                        &nbsp;&nbsp;-H "Authorization: Bearer cg_live_xxx" \\<br>
                        &nbsp;&nbsp;-F "title=Meu PR" \\<br>
                        &nbsp;&nbsp;-F "file=@changes.patch" \\<br>
                        &nbsp;&nbsp;-F "wait=true"</code>
                    </div>
                </div>
            </div>`;

        // Plan change handlers
        $('billingContainer').querySelectorAll('[data-change-plan]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const slug = btn.dataset.changePlan;
                btn.disabled = true; btn.textContent = 'Processando...';
                try {
                    await ensureAuth();
                    const res = await api('POST', `/orgs/${ORG_ID}/billing/change-plan`, { plan: slug });
                    if (res.checkout_url) {
                        window.open(res.checkout_url, '_blank');
                        toast('Redirecionando para pagamento...');
                    } else {
                        toast('Plano alterado para ' + slug + '!');
                        renderBillingPage();
                    }
                } catch (e) {
                    toast(e.message || 'Erro ao alterar plano', 'error');
                    btn.disabled = false; btn.textContent = 'Upgrade';
                }
            });
        });

        // API Key creation
        $('btnCreateKey').addEventListener('click', async () => {
            const name = $('apiKeyName').value.trim();
            if (!name) { toast('Preencha o nome da key', 'error'); return; }
            const btn = $('btnCreateKey'); btn.disabled = true;
            try {
                await ensureAuth();
                const res = await api('POST', '/auth/api-keys', { name });
                $('apiKeyResult').innerHTML = `
                    <div style="padding:12px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);border-radius:var(--radius-md)">
                        <div style="font-weight:700;color:var(--accent-success);margin-bottom:4px">Key criada! Copie agora — ela nao sera exibida novamente.</div>
                        <code style="font-size:0.9rem;word-break:break-all;color:var(--text-primary)">${esc(res.plain_key)}</code>
                    </div>`;
                $('apiKeyName').value = '';
            } catch (e) { $('apiKeyResult').innerHTML = `<div class="form-error">${e.message || e.detail || 'Erro'}</div>`; }
            btn.disabled = false;
        });
    }

    // ================================================================
    //  LOGS PAGE
    // ================================================================
    const LOG_ICONS = {
        analysis_completed: 'search', mr_created: 'git-pull-request', mr_merged: 'git-merge',
        mr_rejected: 'x-circle', repo_added: 'folder-plus', repo_synced: 'refresh-cw',
        member_invited: 'user-plus', member_removed: 'user-minus', rule_changed: 'settings',
        login: 'log-in', default: 'activity',
    };

    async function renderLogsPage() {
        pageContent.innerHTML = `<h1 class="page-title">Logs de Atividade</h1><p class="page-subtitle">Histórico de ações do sistema</p>
            <div id="logsContainer">${showLoading()}</div>`;

        let logs = [];
        try {
            await ensureAuth();
            logs = await api('GET', `/orgs/${ORG_ID}/dashboard/activity?limit=50`);
        } catch (_) {}

        const c = $('logsContainer');
        if (!logs.length) {
            c.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><h3>Nenhum log registrado</h3><p>As atividades aparecerão aqui conforme você usa o sistema</p></div></div></div>';
            return;
        }

        c.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">${icon('activity')} Logs</span><span class="card-badge">${logs.length}</span></div>
            <div class="card-body"><table class="mr-table"><thead><tr><th></th><th>Ação</th><th>Detalhes</th><th>Usuário</th><th>Data</th></tr></thead><tbody>${logs.map(l => {
                const evType = l.event_type || 'default';
                const lucideIcon = LOG_ICONS[evType] || LOG_ICONS.default;
                const desc = l.description || evType.replace(/_/g, ' ');
                const user = l.user_name || l.user_email || 'Sistema';
                const date = l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '';
                return `<tr><td><i data-lucide="${lucideIcon}" style="width:18px;height:18px;color:var(--accent-tertiary)"></i></td><td><strong>${esc(desc)}</strong></td><td style="color:var(--text-secondary)">${esc(l.metadata || l.detail || '')}</td><td>${esc(user)}</td><td style="white-space:nowrap;color:var(--text-tertiary)">${date}</td></tr>`;
            }).join('')}</tbody></table></div></div>`;
    }

    // ── Init ─────────────────────────────────────────────────
    renderPage();
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeActionModal(); } });

})();
