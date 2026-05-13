/* ================================================
   Codexfy AI - Main Application
   ================================================ */

(function () {
    'use strict';

    // ── API ──────────────────────────────────────────────────
    const API = window.location.origin + '/api/v1';
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
    async function api(method, path, body) {
        syncTokens();
        let r = await fetch(API + path, { method, headers: hdrs(), ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r.status === 204) return null;

        // On 401, try to refresh the token once
        if (r.status === 401 && window.CodexfyRefreshToken) {
            const refreshed = await window.CodexfyRefreshToken();
            if (refreshed) {
                syncTokens();
                r = await fetch(API + path, { method, headers: hdrs(), ...(body ? { body: JSON.stringify(body) } : {}) });
                if (r.status === 204) return null;
            } else {
                // Refresh failed — force logout
                if (window.CodexfyForceLogout) window.CodexfyForceLogout();
                throw { message: 'Sessão expirada. Faça login novamente.' };
            }
        }

        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw d;
        return d;
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
                const allMrs = [];
                for (const repo of cachedRepos) {
                    try {
                        const resp = await api('GET', `/orgs/${ORG_ID}/repos/${repo.id}/mrs?limit=100`);
                        const items = resp.items || resp || [];
                        items.forEach(mr => { mr._repo_id = repo.id; mr._repo_name = repo.full_name; });
                        allMrs.push(...items);
                    } catch (_) {}
                }
                if (allMrs.length) { cachedMRs = allMrs; useMockData = false; return allMrs; }
            } catch (_) {}
        }
        // Fallback to mock
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
    function closeActionModal() { actionOverlay.classList.remove('active'); document.body.style.overflow = ''; }
    function closeModal() { modalOverlay.classList.remove('active'); document.body.style.overflow = ''; currentMR = null; }

    function toast(msg, type) {
        const t = document.createElement('div');
        t.className = 'toast toast-' + (type || 'success');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

    function formRow(label, desc, inputHtml) {
        return `<div class="form-row"><div class="form-row-info"><h4>${label}</h4>${desc ? '<p>' + desc + '</p>' : ''}</div><div class="form-row-input">${inputHtml}</div></div>`;
    }

    function showLoading() {
        return `<div class="card"><div class="card-body" style="padding:40px;text-align:center;color:var(--text-tertiary)">
            <div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Carregando...</div>
        </div></div>`;
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
        pageContent.style.animation = 'fadeIn 0.3s ease';
        (r[currentPage] || r.dashboard)();
    }

    // ================================================================
    //  DASHBOARD
    // ================================================================
    async function renderDashboard(q) {
        pageContent.innerHTML = `
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Visão geral das análises de merge requests — Codexfy AI</p>
            <div style="display:flex;gap:10px;margin-bottom:20px"><button class="export-btn" id="exportCsvBtn">📊 Exportar CSV</button></div>
            <div class="metrics-grid" id="metricsGrid">
                ${metricCard('purple', '📋', '...', 'MRs Pendentes', '', 0)}
                ${metricCard('green', '✓', '...', 'Aprovados / Merged', '', 0.1)}
                ${metricCard('red', '⚠', '...', 'Com Problemas', '', 0.2)}
                ${metricCard('yellow', '⭐', '...', 'Score Medio IA', '', 0.3)}
            </div>

            <!-- Quick Actions -->
            <div class="quick-actions stagger-in" style="animation-delay:0.32s">
                <button class="quick-action-btn" id="qaBtnAddRepo">
                    <div class="qa-icon">📦</div>
                    <div><strong>Adicionar Repositorio</strong><span>Conectar GitHub ou GitLab</span></div>
                </button>
                <button class="quick-action-btn" id="qaBtnInvite">
                    <div class="qa-icon">👤</div>
                    <div><strong>Convidar Membro</strong><span>Adicionar alguem a equipe</span></div>
                </button>
                <button class="quick-action-btn" id="qaBtnBulk">
                    <div class="qa-icon">🚀</div>
                    <div><strong>Importar em Massa</strong><span>Vários repos de uma vez</span></div>
                </button>
            </div>

            <div class="dashboard-grid">
                <div class="card stagger-in" style="animation-delay:0.35s">
                    <div class="card-header"><span class="card-title">Atividade Semanal</span><span class="card-badge">Ultimos 7 dias</span></div>
                    <div class="card-body"><div class="chart-container" id="chartContainer">Carregando...</div></div>
                </div>
                <div class="card stagger-in" style="animation-delay:0.45s">
                    <div class="card-header"><span class="card-title">Atividade Recente</span></div>
                    <div class="card-body"><div class="activity-list" id="activityList">Carregando...</div></div>
                </div>
            </div>
            <div class="card stagger-in" style="animation-delay:0.55s">
                <div class="card-header"><span class="card-title">Merge Requests Recentes</span><span class="card-badge" id="mrCountBadge">...</span></div>
                <div class="mr-table-container" id="mrTableContainer">Carregando...</div>
            </div>`;

        $('qaBtnAddRepo').addEventListener('click', openAddRepoModal);
        $('qaBtnInvite').addEventListener('click', openInviteMemberModal);
        $('qaBtnBulk').addEventListener('click', openBulkAddModal);
        $('exportCsvBtn').addEventListener('click', () => {
            const mrs = cachedMRs.map(normalizeMR);
            AnalysisEngine.exportCSV(mrs);
            toast('CSV exportado com sucesso!');
        });

        // Load real data
        await ensureAuth();

        // Metrics
        try {
            const metrics = await api('GET', `/orgs/${ORG_ID}/dashboard/metrics`);
            $('metricsGrid').innerHTML = `
                ${metricCard('purple', '📋', metrics.pending + (metrics.analyzing || 0), 'MRs Pendentes', '', 0)}
                ${metricCard('green', '✓', metrics.approved + (metrics.merged || 0), 'Aprovados / Merged', '', 0.1)}
                ${metricCard('red', '⚠', metrics.issues, 'Com Problemas', '', 0.2)}
                ${metricCard('yellow', '⭐', metrics.avg_score + '<span style="font-size:1rem;color:var(--text-tertiary)">/100</span>', 'Score Medio IA', '', 0.3)}
            `;
        } catch (_) {
            // Fallback to mock
            if (typeof MERGE_REQUESTS !== 'undefined') {
                const metrics = AnalysisEngine.getMetrics(MERGE_REQUESTS);
                $('metricsGrid').innerHTML = `
                    ${metricCard('purple', '📋', metrics.pending, 'MRs Pendentes', '', 0)}
                    ${metricCard('green', '✓', metrics.approved, 'Aprovados / Merged', '', 0.1)}
                    ${metricCard('red', '⚠', metrics.withIssues, 'Com Problemas', '', 0.2)}
                    ${metricCard('yellow', '⭐', metrics.avgScore + '<span style="font-size:1rem;color:var(--text-tertiary)">/100</span>', 'Score Medio IA', '', 0.3)}
                `;
            }
        }

        // Chart
        try {
            const chartData = await api('GET', `/orgs/${ORG_ID}/dashboard/chart`);
            if (chartData && chartData.length) {
                const max = Math.max(...chartData.map(d => d.opened || d.value || 1));
                $('chartContainer').innerHTML = chartData.map(d => `<div class="chart-bar-group"><div class="chart-bar" style="height:${((d.opened || d.value || 0)/Math.max(max,1))*170}px" data-value="${d.opened || d.value || 0}"></div><span class="chart-label">${d.day || d.label}</span></div>`).join('');
            } else {
                $('chartContainer').innerHTML = '<div style="padding:20px;color:var(--text-tertiary)">Nenhuma atividade esta semana</div>';
            }
        } catch (_) {
            if (typeof CHART_DATA !== 'undefined') {
                $('chartContainer').innerHTML = CHART_DATA.map(d => `<div class="chart-bar-group"><div class="chart-bar" style="height:${(d.value/24)*170}px" data-value="${d.value}"></div><span class="chart-label">${d.label}</span></div>`).join('');
            }
        }

        // Activity
        try {
            const activity = await api('GET', `/orgs/${ORG_ID}/dashboard/activity?limit=10`);
            if (activity && activity.length) {
                $('activityList').innerHTML = activity.map(a => {
                    const typeClass = a.event_type === 'analysis_completed' ? 'success' : a.event_type === 'mr_rejected' ? 'danger' : 'info';
                    const time = AnalysisEngine.timeAgo(a.created_at);
                    return `<div class="activity-item"><div class="activity-dot ${typeClass}"></div><div class="activity-info"><div class="activity-text">${esc(a.description)}</div><div class="activity-time">${time}</div></div></div>`;
                }).join('');
            } else {
                $('activityList').innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">Nenhuma atividade recente</div>';
            }
        } catch (_) {
            if (typeof RECENT_ACTIVITY !== 'undefined') {
                $('activityList').innerHTML = RECENT_ACTIVITY.map(a => `<div class="activity-item"><div class="activity-dot ${a.type}"></div><div class="activity-info"><div class="activity-text">${a.text}</div><div class="activity-time">${a.time}</div></div></div>`).join('');
            }
        }

        // MR Table
        try {
            const mrs = await loadAllMRs();
            const normalized = mrs.map(normalizeMR);
            const filtered = q ? normalized.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q)) : normalized;
            $('mrCountBadge').textContent = filtered.length + ' total';
            $('mrTableContainer').innerHTML = renderMRTable(filtered);
            attachTableListeners();
        } catch (_) {
            if (typeof MERGE_REQUESTS !== 'undefined') {
                const mrs = q ? MERGE_REQUESTS.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q)) : MERGE_REQUESTS;
                $('mrCountBadge').textContent = mrs.length + ' total';
                $('mrTableContainer').innerHTML = renderMRTable(mrs);
                attachTableListeners();
            }
        }
    }

    function metricCard(color, icon, value, label, trend, delay) {
        return `<div class="metric-card stagger-in" style="animation-delay:${delay}s"><div class="metric-card-header"><div class="metric-icon ${color}">${icon}</div>${trend ? `<span class="metric-trend up">${trend}</span>` : ''}</div><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>`;
    }

    // ================================================================
    //  REPOSITORIES PAGE
    // ================================================================
    const EXAMPLE_REPOS = [
        { platform: 'github', full_name: 'facebook/react', desc: 'Biblioteca UI do Facebook — PRs frequentes com alto volume', lang: 'JavaScript', stars: '230k' },
        { platform: 'github', full_name: 'tiangolo/fastapi', desc: 'Framework web Python — PRs com boa qualidade de codigo', lang: 'Python', stars: '80k' },
        { platform: 'github', full_name: 'microsoft/vscode', desc: 'Editor de codigo da Microsoft — PRs complexos e variados', lang: 'TypeScript', stars: '168k' },
        { platform: 'github', full_name: 'pallets/flask', desc: 'Micro-framework Python — PRs menores, bom para testar', lang: 'Python', stars: '68k' },
        { platform: 'github', full_name: 'expressjs/express', desc: 'Framework Node.js minimalista — PRs concisos', lang: 'JavaScript', stars: '66k' },
        { platform: 'github', full_name: 'django/django', desc: 'Framework web Python completo — PRs com regras de negocio', lang: 'Python', stars: '82k' },
    ];

    function renderExampleRepos() {
        return EXAMPLE_REPOS.map(r => `
            <div class="example-repo-card">
                <div class="example-repo-top">
                    <div class="repo-platform-badge github">⬡ GitHub</div>
                    <span style="font-size:0.78rem;color:var(--text-tertiary)">⭐ ${r.stars}</span>
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
                openActionModal('Adicionar ' + fullName, `
                    <div class="form-card">
                        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border-color)">
                            <div style="font-size:2rem">⬡</div>
                            <div>
                                <div style="font-weight:700;font-size:1.1rem;color:var(--text-primary)">${esc(fullName)}</div>
                                <div style="color:var(--text-tertiary);font-size:0.85rem">Repositorio publico — ${platform}</div>
                            </div>
                        </div>
                        <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:16px">
                            Para analisar PRs deste repo, voce precisa de um <strong>GitHub Personal Access Token</strong>.<br>
                            <a href="https://github.com/settings/tokens/new?scopes=public_repo&description=Codexfy" target="_blank" style="color:var(--accent-primary);font-weight:600">Criar token no GitHub →</a>
                        </p>
                        ${formRow('Access Token', 'Cole o token aqui', '<input class="input" id="exToken" type="password" placeholder="ghp_xxxxxxxxxxxx">')}
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
                        await api('POST', `/orgs/${ORG_ID}/repos`, { platform, full_name: fullName, access_token: $('exToken').value });
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
                <div><h1 class="page-title">Repositorios</h1><p class="page-subtitle">Gerencie os repositorios monitorados pela IA</p></div>
                ${isAdmin() ? `<div class="page-actions">
                    <button class="btn btn-secondary" id="btnBulkAdd">Importar em Massa</button>
                    <button class="btn btn-primary" id="btnAddRepo">+ Adicionar Repositorio</button>
                </div>` : ''}
            </div>

            <!-- How to add -->
            <div class="info-banner stagger-in" style="animation-delay:0.1s">
                <div class="info-icon">💡</div>
                <div>
                    <strong>Como adicionar repositorios?</strong>
                    <p>Clique em <em>"+ Adicionar Repositorio"</em> para adicionar um por um, ou <em>"Importar em Massa"</em> para enviar varios de uma vez (ideal para empresas). Voce precisa do <strong>access token</strong> da plataforma (GitHub ou GitLab).</p>
                </div>
            </div>

            <!-- Example repos for testing -->
            <div class="card stagger-in" style="animation-delay:0.2s;margin-top:16px">
                <div class="card-header">
                    <span class="card-title">🧪 Repositorios de Exemplo</span>
                    <span class="card-badge">Teste rapido</span>
                </div>
                <div class="card-body" style="padding:16px">
                    <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:16px">
                        Quer testar a analise de MR sem configurar um repo? Use um desses repositorios publicos populares. Basta criar um <strong>Personal Access Token</strong> no GitHub (<a href="https://github.com/settings/tokens/new" target="_blank" style="color:var(--accent-primary)">criar token</a>) com permissao <code>public_repo</code> e colar abaixo.
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
        if ($('btnBulkAdd')) $('btnBulkAdd').addEventListener('click', openBulkAddModal);
        attachExampleRepoListeners();
        loadRepos();
    }

    async function loadRepos() {
        const c = $('reposListContainer');
        try {
            await ensureAuth();
            const repos = await api('GET', `/orgs/${ORG_ID}/repos`);
            if (!repos.length) {
                c.innerHTML = `<div class="empty-state-card"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><h3>Nenhum repositorio cadastrado</h3><p>Comece adicionando seus repositorios GitHub ou GitLab</p><button class="btn btn-primary" onclick="document.getElementById('btnAddRepo').click()" style="margin-top:16px">+ Adicionar Primeiro Repositorio</button></div>`;
                return;
            }
            c.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Repositorios Cadastrados</span><span class="card-badge">${repos.length}</span></div>
                <div class="repos-grid">${repos.map(r => `
                    <div class="repo-card">
                        <div class="repo-card-top">
                            <div class="repo-platform-badge ${r.platform}">${r.platform === 'github' ? '⬡ GitHub' : '🦊 GitLab'}</div>
                            ${isAdmin() ? `<div class="repo-actions">
                                <button class="btn-icon" title="Sincronizar" data-sync="${r.id}">🔄</button>
                                <button class="btn-icon btn-danger" title="Remover" data-del="${r.id}">🗑</button>
                            </div>` : ''}
                        </div>
                        <div class="repo-card-name">${esc(r.full_name)}</div>
                        <div class="repo-card-branch">Branch: ${r.default_branch}</div>
                        <div class="repo-card-footer">
                            <span style="color:${r.auto_analyze ? 'var(--accent-success)' : 'var(--text-tertiary)'}">${r.auto_analyze ? '● Auto-Analise' : '○ Manual'}</span>
                            <span>Score min: ${r.min_score}</span>
                        </div>
                    </div>
                `).join('')}</div></div>`;

            c.querySelectorAll('[data-sync]').forEach(b => b.addEventListener('click', async () => {
                b.disabled = true; try { await api('POST', `/orgs/${ORG_ID}/repos/${b.dataset.sync}/sync`); toast('Sync iniciada!'); } catch (e) { toast(e.message || 'Erro', 'error'); } b.disabled = false;
            }));
            c.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
                if (!confirm('Remover este repositorio e todos os seus dados?')) return;
                try { await api('DELETE', `/orgs/${ORG_ID}/repos/${b.dataset.del}`); toast('Removido!'); loadRepos(); } catch (e) { toast(e.message || 'Erro', 'error'); }
            }));
        } catch (e) { c.innerHTML = `<div class="empty-state-card"><h3>Erro ao carregar</h3><p>${e.message || e.detail || 'Verifique a API'}</p></div>`; }
    }

    function openAddRepoModal() {
        openActionModal('Adicionar Repositorio', `
            <div class="form-card">
                ${formRow('Plataforma', '', '<select class="input" id="fPlatform"><option value="github">⬡ GitHub</option><option value="gitlab">🦊 GitLab</option></select>')}
                ${formRow('Repositorio', 'Formato: owner/repo', '<input class="input" id="fFullName" placeholder="empresa/backend-api">')}
                ${formRow('Access Token', 'Token com permissao de leitura', '<input class="input" id="fToken" type="password" placeholder="ghp_... ou glpat-...">')}
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
                await api('POST', `/orgs/${ORG_ID}/repos`, { platform: $('fPlatform').value, full_name: $('fFullName').value, access_token: $('fToken').value, default_branch: $('fBranch').value });
                toast('Repositorio adicionado!'); closeActionModal(); if (currentPage === 'repositories') loadRepos();
            } catch (e) { $('fResult').innerHTML = `<div class="form-error">✗ ${e.message || e.detail || JSON.stringify(e)}</div>`; btn.disabled = false; btn.textContent = 'Adicionar'; }
        });
    }

    function openBulkAddModal() {
        openActionModal('Importar Repositorios em Massa', `
            <div class="form-card">
                <p style="color:var(--text-secondary);margin-bottom:12px">Cole a lista de repositorios, um por linha.<br>Formato: <code>plataforma,owner/repo,token</code></p>
                <textarea id="fBulk" class="input" rows="8" style="width:100%;font-family:'JetBrains Mono',monospace;font-size:0.85rem;resize:vertical" placeholder="github,empresa/backend,ghp_abc123
github,empresa/frontend,ghp_abc123
gitlab,empresa/mobile,glpat-xyz789"></textarea>
                <div class="form-actions"><button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button><button class="btn btn-primary" id="fBulkSubmit">Importar Todos</button></div>
                <div id="fBulkResult"></div>
            </div>`);
        $('fBulkSubmit').addEventListener('click', async () => {
            const btn = $('fBulkSubmit'); const text = $('fBulk').value.trim(); if (!text) return;
            const repos = text.split('\n').filter(l => l.trim()).map(l => { const p = l.split(',').map(s => s.trim()); return { platform: p[0], full_name: p[1], access_token: p[2] || '' }; });
            btn.disabled = true; btn.textContent = `Importando ${repos.length}...`;
            try {
                await ensureAuth();
                const res = await api('POST', `/orgs/${ORG_ID}/repos/bulk`, { repositories: repos });
                let h = `<div class="form-success">✓ ${res.succeeded.length} adicionados</div>`;
                if (res.failed.length) h += `<div class="form-error">✗ ${res.failed.length} falharam:<br>${res.failed.map(f => '  • ' + f.full_name + ': ' + f.error).join('<br>')}</div>`;
                $('fBulkResult').innerHTML = h;
                if (res.succeeded.length) { toast(`${res.succeeded.length} repos importados!`); setTimeout(() => { closeActionModal(); if (currentPage === 'repositories') loadRepos(); }, 1200); }
            } catch (e) { $('fBulkResult').innerHTML = `<div class="form-error">✗ ${e.message || JSON.stringify(e)}</div>`; }
            btn.disabled = false; btn.textContent = 'Importar Todos';
        });
    }

    // ================================================================
    //  TEAM PAGE
    // ================================================================
    function renderTeamPage() {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div><h1 class="page-title">Equipe</h1><p class="page-subtitle">Gerencie os membros da organizacao</p></div>
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
                c.innerHTML = `<div class="empty-state-card"><h3>Nenhum membro</h3><p>Convide membros para sua organizacao</p>
                    ${isAdmin() ? '<button class="btn btn-primary" onclick="document.getElementById(\'btnInvite\').click()" style="margin-top:16px">+ Convidar Primeiro Membro</button>' : ''}</div>`;
                return;
            }
            c.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Membros da Organizacao</span><span class="card-badge">${members.length}</span></div>
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
        const confirmed = confirm(`Tem certeza que deseja remover "${userName}" da organizacao?\n\nEle perdera acesso ao sistema.`);
        if (!confirmed) return;
        try {
            await ensureAuth();
            await api('DELETE', `/orgs/${ORG_ID}/members/${userId}`);
            toast(`${userName} removido da organizacao`);
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
                ${formRow('Cargo', 'Permissoes no sistema', `<select class="input" id="fRole">
                    <option value="member">Membro — visualiza MRs e analises</option>
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
    async function renderMergeRequests(q) {
        pageContent.innerHTML = `<h1 class="page-title">Merge Requests</h1><p class="page-subtitle">Todos os merge requests com analise detalhada da IA</p>
            <div class="card"><div class="card-header"><span class="card-title">Todos os MRs</span><span class="card-badge" id="mrPageCount">...</span></div><div class="mr-table-container" id="mrPageTable">${showLoading()}</div></div>`;

        try {
            const mrs = await loadAllMRs();
            const normalized = mrs.map(normalizeMR);
            const filtered = q ? normalized.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q)) : normalized;
            $('mrPageCount').textContent = filtered.length;
            $('mrPageTable').innerHTML = renderMRTable(filtered);
            attachTableListeners();
        } catch (_) {
            if (typeof MERGE_REQUESTS !== 'undefined') {
                const mrs = q ? MERGE_REQUESTS.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q)) : MERGE_REQUESTS;
                $('mrPageCount').textContent = mrs.length;
                $('mrPageTable').innerHTML = renderMRTable(mrs);
                attachTableListeners();
            }
        }
    }

    function renderMRTable(mrs) {
        if (!mrs.length) return `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><h3>Nenhum MR encontrado</h3></div>`;
        return `<table class="mr-table"><thead><tr><th>Merge Request</th><th>Autor</th><th>Status</th><th>Score</th><th>Alteracoes</th><th>Tempo</th></tr></thead><tbody>${mrs.map(mr => {
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
        modalBody.innerHTML = `<div class="overview-grid"><div class="overview-item"><span class="overview-label">Autor</span><div class="mr-author" style="margin-top:4px"><div class="mr-author-avatar" style="background:${mr.author.color}">${mr.author.initials}</div><span class="overview-value">${esc(mr.author.name)}</span></div></div><div class="overview-item"><span class="overview-label">Status</span><span class="badge ${s.class}" style="margin-top:4px">${s.icon} ${s.label}</span></div><div class="overview-item"><span class="overview-label">Branch</span><span class="overview-value" style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">${esc(mr.branch)} → ${esc(mr.targetBranch)}</span></div><div class="overview-item"><span class="overview-label">Criado em</span><span class="overview-value">${new Date(mr.createdAt).toLocaleString('pt-BR')}</span></div><div class="overview-item" style="grid-column:1/-1"><span class="overview-label">Descricao</span><span class="overview-value">${esc(mr.description || 'Sem descricao')}</span></div></div><div class="overview-stats"><div class="overview-stat"><div class="overview-stat-value green">+${mr.additions}</div><div class="overview-stat-label">Adicoes</div></div><div class="overview-stat"><div class="overview-stat-value red">-${mr.deletions}</div><div class="overview-stat-label">Remocoes</div></div><div class="overview-stat"><div class="overview-stat-value blue">${mr.filesChanged}</div><div class="overview-stat-label">Arquivos</div></div></div>${mr.files && mr.files.length ? '<h3 style="margin-top:24px;margin-bottom:12px;font-size:1rem;font-weight:700">Arquivos Alterados</h3>' + mr.files.map(f => `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm);margin-bottom:4px;font-family:'JetBrains Mono',monospace;font-size:0.82rem"><span>📄 ${esc(f.name || f.file_path || '')}</span><span><span style="color:var(--accent-success)">+${f.additions}</span> <span style="color:var(--accent-danger)">-${f.deletions}</span></span></div>`).join('') : ''}
        ${mr._repo_id ? `<div style="margin-top:20px"><button class="btn btn-primary" id="btnTriggerAnalysis">🔄 Disparar Analise IA</button></div>` : ''}`;

        if (mr._repo_id && $('btnTriggerAnalysis')) {
            $('btnTriggerAnalysis').addEventListener('click', async () => {
                const btn = $('btnTriggerAnalysis'); btn.disabled = true; btn.textContent = 'Iniciando...';
                try {
                    await api('POST', `/orgs/${ORG_ID}/repos/${mr._repo_id}/mrs/${mr.id}/analyze`);
                    toast('Analise iniciada! Aguarde...'); btn.textContent = 'Analise em andamento...';
                } catch (e) { toast(e.message || 'Erro ao iniciar analise', 'error'); btn.disabled = false; btn.textContent = '🔄 Disparar Analise IA'; }
            });
        }
    }

    function renderAnalysisTab() {
        const mr = currentMR;
        if (mr.aiScore === null || mr.aiScore === undefined) { modalBody.innerHTML = '<div class="empty-state"><div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px;margin-bottom:16px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Analise em andamento</div><h3>A IA esta analisando este MR</h3></div>'; return; }
        const g = AnalysisEngine.getScoreGrade(mr.aiScore);
        const cats = mr.analysisCategories || {};
        const hasCats = Object.keys(cats).length > 0;
        modalBody.innerHTML = `<div class="analysis-score-section"><div class="score-circle" style="--score-color:${g.color};--score-pct:${mr.aiScore};color:${g.color}">${mr.aiScore}</div><div class="score-details"><div class="score-title">${g.label}</div><div class="score-description">${g.description}</div></div></div>${hasCats ? `<div class="analysis-categories">${Object.entries(cats).map(([k,v]) => `<div class="category-card"><div class="category-header"><span class="category-name">${AnalysisEngine.getCategoryLabel(k)}</span><span class="category-score" style="color:${AnalysisEngine.getCategoryColor(v)}">${v}/100</span></div><div class="category-bar"><div class="category-bar-fill" style="width:${v}%;background:${AnalysisEngine.getCategoryColor(v)}"></div></div></div>`).join('')}</div>` : ''}${mr.issues.length ? `<div class="issues-section"><h3>🔴 Issues (${mr.issues.length})</h3>${mr.issues.map(i => {
            const sev = i.severity || 'info';
            const title = i.title || '';
            const file = i.file || i.file_path || '';
            const desc = i.description || '';
            const sug = i.suggestion || '';
            return `<div class="issue-card ${sev}"><div class="issue-header"><span class="issue-title">${esc(title)}</span><span class="issue-severity ${sev}">${sev.toUpperCase()}</span></div>${file ? `<div class="issue-file">${esc(file)}${i.line_ref ? ':' + i.line_ref : ''}</div>` : ''}<div class="issue-description">${esc(desc)}</div>${sug ? `<div class="issue-suggestion"><strong>💡 Sugestao</strong> ${esc(sug)}</div>` : ''}</div>`;
        }).join('')}</div>` : '<div class="empty-state" style="padding:30px"><h3>Sem issues! 🎉</h3></div>'}`;
    }

    function renderDiffTab() {
        const mr = currentMR;
        if (!mr.diff || !mr.diff.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Diff nao disponivel</h3><p>O diff sera carregado apos a analise da IA</p></div>'; return; }
        modalBody.innerHTML = mr.diff.map(f => {
            let h = '';
            if (f.lines && f.lines.length) {
                f.lines.forEach(l => {
                    h += `<div class="diff-line ${l.type}"><span class="diff-line-number">${l.num}</span><span class="diff-line-content">${esc(l.content)}</span></div>`;
                    if (f.annotations) { const a = f.annotations.find(a => a.afterLine === l.num || a.after_line === l.num); if (a) h += `<div class="diff-annotation ${a.type === 'danger' ? 'danger-annotation' : a.type === 'warning' ? 'warning-annotation' : ''}"><div class="diff-annotation-icon">IA</div><div class="diff-annotation-text">${esc(a.text)}</div></div>`; }
                });
            } else if (f.annotations && f.annotations.length) {
                f.annotations.forEach(a => {
                    h += `<div class="diff-annotation ${a.type === 'danger' ? 'danger-annotation' : a.type === 'warning' ? 'warning-annotation' : ''}"><div class="diff-annotation-icon">IA</div><div class="diff-annotation-text">${esc(a.text)}</div></div>`;
                });
            }
            return `<div class="diff-file"><div class="diff-file-header"><span>📄 ${esc(f.file)}</span></div><div class="diff-content">${h || '<div style="padding:12px;color:var(--text-tertiary)">Anotacoes da IA disponiveis acima</div>'}</div></div>`;
        }).join('');
    }

    function renderRulesTab() {
        const mr = currentMR;
        if (!mr.rules || !mr.rules.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Regras pendentes</h3><p>As regras serao avaliadas apos a analise da IA</p></div>'; return; }
        const rules = mr.rules.map(r => ({
            name: r.name || r.rule_name || '',
            status: r.status || 'warn',
            desc: r.desc || r.description || '',
        }));
        const c = AnalysisEngine.countRules(rules), icons = { pass: '✓', fail: '✗', warn: '⚠' };
        modalBody.innerHTML = `<div class="rules-summary"><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-success)">${c.pass}</div><div class="rules-summary-label">Aprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-danger)">${c.fail}</div><div class="rules-summary-label">Reprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-warning)">${c.warn}</div><div class="rules-summary-label">Atencao</div></div></div>${rules.map(r => `<div class="rule-item"><div class="rule-status-icon ${r.status}">${icons[r.status]}</div><div class="rule-info"><div class="rule-name">${esc(r.name)}</div><div class="rule-desc">${esc(r.desc)}</div></div></div>`).join('')}`;
    }

    // ── Chat Tab (P1) ──────────────────────────────────────────
    function renderChatTab() {
        const mr = currentMR;
        const suggestions = [
            'Quais sao os principais riscos de seguranca?',
            'Gere testes unitarios para este codigo',
            'Como melhorar a performance?',
            'Explique o que esse MR faz em resumo',
            'Tem algum bug potencial?',
        ];
        modalBody.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;min-height:400px">
                <div id="chatMessages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
                    <div style="padding:16px;background:var(--bg-tertiary);border-radius:var(--radius-md);color:var(--text-secondary)">
                        <div style="font-weight:700;margin-bottom:8px">💬 Chat com IA sobre "${esc(mr.title || 'este MR')}"</div>
                        <div style="font-size:0.85rem;color:var(--text-tertiary);margin-bottom:12px">Pergunte qualquer coisa sobre o codigo, issues, seguranca ou melhorias.</div>
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
                    secIssues.map((i, idx) => `<strong>${idx+1}. ${esc(i.title)}</strong><br>${esc(i.description || '')}<br>${i.suggestion ? '<em>💡 ' + esc(i.suggestion) + '</em>' : ''}<br>`).join('<br>') +
                    `<br>Score de seguranca: <strong>${cats.security || 'N/A'}/100</strong>`;
            }
            return `Score de seguranca: <strong>${cats.security || 'N/A'}/100</strong>. Nenhum risco critico encontrado neste MR.`;
        }
        if (q.includes('teste') || q.includes('test')) {
            const fileNames = files.map(f => f.name || '').filter(Boolean);
            return `<strong>🧪 Sugestao de Testes para "${esc(title)}":</strong><br><br>` +
                `<code style="display:block;padding:12px;background:var(--bg-secondary);border-radius:8px;font-size:0.82rem;line-height:1.6;white-space:pre-wrap">` +
                `describe('${esc(title.split(' ').slice(0,3).join(' '))}', () => {\n` +
                fileNames.slice(0, 3).map(f => `  it('deve validar ${esc(f.split('/').pop())}', () => {\n    // Arrange\n    // Act\n    // Assert\n    expect(result).toBeDefined();\n  });\n`).join('\n') +
                `  it('deve tratar erros corretamente', () => {\n    expect(() => execute(null)).toThrow();\n  });\n` +
                `});</code><br>` +
                `Adapte os nomes e imports conforme a estrutura real do projeto.`;
        }
        if (q.includes('performance') || q.includes('otimiz')) {
            return `<strong>⚡ Analise de Performance:</strong><br><br>` +
                `Score de performance: <strong>${cats.performance || 'N/A'}/100</strong><br><br>` +
                (issues.filter(i => i.title && i.title.toLowerCase().includes('perform')).length ?
                    issues.filter(i => i.title && i.title.toLowerCase().includes('perform')).map(i => `• ${esc(i.title)}: ${esc(i.description || '')}`).join('<br>') :
                    `Nenhum issue especifico de performance. Verifique:<br>• Uso de cache para dados repetidos<br>• Queries N+1 em loops<br>• Lazy loading de componentes pesados<br>• Indices no banco de dados`);
        }
        if (q.includes('resum') || q.includes('o que') || q.includes('expliq')) {
            return `<strong>📋 Resumo do MR "${esc(title)}":</strong><br><br>` +
                `• <strong>Branch:</strong> ${esc(mr.branch || '')} → ${esc(mr.targetBranch || '')}<br>` +
                `• <strong>Arquivos alterados:</strong> ${mr.filesChanged || files.length}<br>` +
                `• <strong>Adicoes:</strong> +${mr.additions || 0} / Remocoes: -${mr.deletions || 0}<br>` +
                `• <strong>Score IA:</strong> ${mr.aiScore || 'N/A'}/100<br><br>` +
                (mr.description ? `<strong>Descricao:</strong> ${esc(mr.description)}<br><br>` : '') +
                (issues.length ? `<strong>Issues encontradas:</strong> ${issues.length} (${issues.filter(i=>i.severity==='critical').length} criticas, ${issues.filter(i=>i.severity==='warning').length} warnings)` : 'Nenhuma issue encontrada.');
        }
        if (q.includes('bug') || q.includes('erro') || q.includes('problem')) {
            const criticals = issues.filter(i => i.severity === 'critical');
            if (criticals.length) {
                return `<strong>🐛 Bugs Potenciais Encontrados:</strong><br><br>` +
                    criticals.map((i, idx) => `<strong>${idx+1}. ${esc(i.title)}</strong><br>Arquivo: <code>${esc(i.file || i.file_path || 'N/A')}</code><br>${esc(i.description || '')}<br>${i.suggestion ? '<em>💡 Fix: ' + esc(i.suggestion) + '</em>' : ''}<br>`).join('<br>');
            }
            return `Nenhum bug critico encontrado pela analise. Score geral: <strong>${mr.aiScore || 'N/A'}/100</strong>. Revise warnings menores nas abas Analise e Regras.`;
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
                    <h1 class="page-title">Regras de Negocio</h1>
                    <p class="page-subtitle">Configure as regras que a IA verifica em cada merge request</p>
                </div>
                ${isAdmin() ? '<button class="btn btn-primary" id="btnNewRule">+ Nova Regra</button>' : ''}
            </div>
            <div id="rulesPageContainer">${showLoading()}</div>`;

        if ($('btnNewRule')) $('btnNewRule').addEventListener('click', () => openRuleForm());

        try {
            await ensureAuth();
            _rulesCache = await api('GET', `/orgs/${ORG_ID}/rules`);
            renderRulesGrid(_rulesCache);
        } catch (_) {
            if (typeof CONFIGURABLE_RULES !== 'undefined') {
                _rulesCache = CONFIGURABLE_RULES.map(r => ({
                    id: r.id, name: r.name, description: r.desc,
                    severity: r.severity, is_active: r.active, is_builtin: false,
                }));
                renderRulesGrid(_rulesCache);
            }
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
                    <label style="font-weight:600;margin-bottom:4px;display:block">Descricao</label>
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

            if (!name) { toast('Nome e obrigatorio', 'error'); return; }

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
        const confirmed = confirm(`Tem certeza que deseja excluir a regra "${ruleName}"?\n\nEssa acao nao pode ser desfeita.`);
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
        pageContent.innerHTML = `<h1 class="page-title">Configurações</h1><p class="page-subtitle">Integrações e preferências — Codexfy AI</p>
            <div id="settingsContainer">${showLoading()}</div>`;

        let settings = { auto_analyze: true, min_score_threshold: 75, notification_email: '', slack_webhook_url: '', discord_webhook_url: '' };
        try {
            await ensureAuth();
            const s = await api('GET', `/orgs/${ORG_ID}/settings`);
            if (s) settings = { ...settings, ...s };
        } catch (_) { /* use defaults */ }

        $('settingsContainer').innerHTML = `
            <div class="settings-section stagger-in"><h3 class="settings-section-title">🔗 Integracao Git</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>Plataforma</h4><p>Plataforma de versionamento</p></div><select class="settings-input" style="min-width:180px"><option>GitHub</option><option>GitLab</option><option>Bitbucket</option></select></div><div class="settings-row"><div class="settings-row-info"><h4>Access Token</h4><p>Token com permissao de leitura</p></div><input class="settings-input" type="password" placeholder="ghp_xxx"></div></div></div>
            <div class="settings-section stagger-in" style="animation-delay:0.15s"><h3 class="settings-section-title">🤖 IA</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>Modelo</h4><p>Modelo de IA para analise</p></div><select class="settings-input" style="min-width:180px"><option>Claude Sonnet 4.6</option><option>Claude Opus 4.6</option><option>GPT-4o</option></select></div><div class="settings-row"><div class="settings-row-info"><h4>Analise Automatica</h4><p>Analisar novos MRs automaticamente</p></div><button class="rule-toggle ${settings.auto_analyze ? 'active' : ''}" id="autoToggle"></button></div><div class="settings-row"><div class="settings-row-info"><h4>Score Minimo</h4><p>MRs abaixo serao sinalizados</p></div><input class="settings-input" type="number" min="0" max="100" value="${settings.min_score_threshold}" id="settingsMinScore" style="min-width:100px;text-align:center"></div></div></div>
            <div class="settings-section stagger-in" style="animation-delay:0.3s"><h3 class="settings-section-title">🔔 Notificacoes</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>E-mail</h4><p>E-mail para notificacoes</p></div><input class="settings-input" type="email" value="${esc(settings.notification_email || '')}" id="settingsEmail" placeholder="equipe@empresa.com"></div><div class="settings-row"><div class="settings-row-info"><h4>Webhook Slack</h4></div><input class="settings-input" type="text" value="${esc(settings.slack_webhook_url || '')}" id="settingsSlack" placeholder="https://hooks.slack.com/..."></div><div class="settings-row"><div class="settings-row-info"><h4>Webhook Discord</h4></div><input class="settings-input" type="text" value="${esc(settings.discord_webhook_url || '')}" id="settingsDiscord" placeholder="https://discord.com/api/webhooks/..."></div></div></div>
            <div style="margin-top:20px"><button class="btn btn-primary" id="btnSaveSettings">💾 Salvar Configuracoes</button></div>`;

        const at = $('autoToggle'); if (at) at.addEventListener('click', () => at.classList.toggle('active'));

        $('btnSaveSettings').addEventListener('click', async () => {
            const btn = $('btnSaveSettings'); btn.disabled = true; btn.textContent = 'Salvando...';
            try {
                await ensureAuth();
                await api('PUT', `/orgs/${ORG_ID}/settings`, {
                    auto_analyze: $('autoToggle').classList.contains('active'),
                    min_score_threshold: parseInt($('settingsMinScore').value) || 75,
                    notification_email: $('settingsEmail').value,
                    slack_webhook_url: $('settingsSlack').value,
                    discord_webhook_url: $('settingsDiscord').value,
                });
                toast('Configuracoes salvas!');
            } catch (e) { toast(e.message || 'Erro ao salvar', 'error'); }
            btn.disabled = false; btn.textContent = '💾 Salvar Configuracoes';
        });
    }

    // ================================================================
    //  UPLOAD PAGE (P0) — analyze without GitHub/GitLab
    // ================================================================
    function renderUploadPage() {
        pageContent.innerHTML = `
            <h1 class="page-title">Analise Rapida</h1>
            <p class="page-subtitle">Envie um arquivo .patch, .zip ou cole o diff diretamente — sem conectar GitHub/GitLab</p>

            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title">Upload de Codigo</span></div>
                <div class="card-body" style="padding:24px">
                    ${formRow('Titulo', 'Descreva brevemente o que foi alterado', '<input class="input" id="upTitle" placeholder="Ex: Refatorar módulo de pagamentos">')}
                    ${formRow('Descricao', 'Opcional', '<textarea class="input" id="upDesc" rows="2" placeholder="Detalhes adicionais..." style="resize:vertical"></textarea>')}
                    ${formRow('Arquivo', '.patch, .diff, .txt ou .zip', '<input type="file" id="upFile" accept=".patch,.diff,.txt,.zip" class="input">')}
                    <div style="text-align:center;color:var(--text-tertiary);margin:12px 0;font-weight:600">— OU —</div>
                    ${formRow('Diff inline', 'Cole o diff diretamente aqui', '<textarea class="input" id="upDiff" rows="8" style="width:100%;font-family:JetBrains Mono,monospace;font-size:0.82rem;resize:vertical" placeholder="diff --git a/file.py b/file.py\n--- a/file.py\n+++ b/file.py\n@@ -1,3 +1,4 @@\n+import os\n ..."></textarea>')}
                    <div style="margin-top:16px;display:flex;gap:12px;align-items:center">
                        <button class="btn btn-primary" id="upSubmit">🚀 Analisar com IA</button>
                        <span id="upStatus" style="color:var(--text-tertiary);font-size:0.9rem"></span>
                    </div>
                </div>
            </div>

            <!-- SSE Progress -->
            <div id="upProgress" style="display:none;margin-top:16px">
                <div class="card">
                    <div class="card-header"><span class="card-title">Progresso da Analise</span></div>
                    <div class="card-body" style="padding:24px">
                        <div style="display:flex;gap:20px;margin-bottom:16px" id="upSteps">
                            <div class="up-step" id="upStep1"><div class="up-step-dot active"></div><span>Na fila</span></div>
                            <div class="up-step" id="upStep2"><div class="up-step-dot"></div><span>Analisando</span></div>
                            <div class="up-step" id="upStep3"><div class="up-step-dot"></div><span>Concluido</span></div>
                        </div>
                        <div class="up-bar"><div class="up-bar-fill" id="upBarFill" style="width:33%"></div></div>
                        <div id="upStepLabel" style="margin-top:12px;color:var(--text-secondary);font-size:0.9rem">Aguardando na fila...</div>
                    </div>
                </div>
            </div>

            <!-- Result -->
            <div id="upResult" style="margin-top:16px"></div>`;

        $('upSubmit').addEventListener('click', handleUploadSubmit);
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

            toast('Analise iniciada!');
            $('upProgress').style.display = 'block';

            // Start SSE to track progress
            trackAnalysisSSE(data.analysis_id);

        } catch (e) {
            toast(e.message || e.detail || 'Erro ao enviar', 'error');
            btn.disabled = false; btn.textContent = '🚀 Analisar com IA';
        }
    }

    function trackAnalysisSSE(analysisId) {
        const evtSource = new EventSource(API + `/analyses/${analysisId}/stream`);
        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const fill = $('upBarFill');
            const label = $('upStepLabel');

            // Update steps
            if (data.step >= 1) $('upStep1').querySelector('.up-step-dot').classList.add('active');
            if (data.step >= 2) $('upStep2').querySelector('.up-step-dot').classList.add('active');
            if (data.step >= 3) $('upStep3').querySelector('.up-step-dot').classList.add('active');

            fill.style.width = (data.step / 3 * 100) + '%';
            if (data.step_label) label.textContent = data.step_label;

            if (data.status === 'completed') {
                evtSource.close();
                fill.style.background = 'var(--accent-success)';
                $('upSubmit').disabled = false;
                $('upSubmit').textContent = '🚀 Analisar com IA';
                toast('Analise concluida! Score: ' + data.ai_score);

                // Show result card
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
            } else if (data.status === 'failed') {
                evtSource.close();
                fill.style.background = 'var(--accent-danger)';
                label.textContent = 'Erro: ' + (data.error_message || 'Falha na analise');
                $('upSubmit').disabled = false;
                $('upSubmit').textContent = '🚀 Analisar com IA';
                toast('Analise falhou', 'error');
            }
        };
        evtSource.onerror = () => { evtSource.close(); };
    }

    // ================================================================
    //  ANALYTICS PAGE (P1) — historical analytics
    // ================================================================
    async function renderAnalyticsPage() {
        pageContent.innerHTML = `
            <h1 class="page-title">Analytics</h1>
            <p class="page-subtitle">Metricas historicas, ranking de devs e evolucao do score</p>
            <div id="analyticsContainer">${showLoading()}</div>`;

        try {
            await ensureAuth();
            const data = await api('GET', `/orgs/${ORG_ID}/dashboard/analytics`);
            renderAnalyticsData(data);
        } catch (e) {
            $('analyticsContainer').innerHTML = `<div class="empty-state-card"><h3>Sem dados</h3><p>${e.message || 'Adicione repositorios e analise MRs para ver analytics'}</p></div>`;
        }
    }

    function renderAnalyticsData(data) {
        const { dev_ranking = [], issue_heatmap = {}, score_evolution = [] } = data;

        let devRows = '';
        dev_ranking.forEach((d, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
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
            return `<div class="chart-bar-group"><div class="chart-bar" style="height:${val > 0 ? (val/100)*170 : 5}px;background:${color}" data-value="${val || '-'}"></div><span class="chart-label">${s.week}</span></div>`;
        }).join('');

        $('analyticsContainer').innerHTML = `
            <!-- Dev Ranking -->
            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title">🏆 Ranking de Desenvolvedores</span><span class="card-badge">${dev_ranking.length} devs</span></div>
                <div class="card-body">${dev_ranking.length ? `
                    <table class="mr-table"><thead><tr><th>#</th><th>Dev</th><th>Score Medio</th><th>Total MRs</th><th>Aprovados</th><th>Issues</th></tr></thead>
                    <tbody>${devRows}</tbody></table>
                ` : '<div class="empty-state"><h3>Nenhum dado</h3></div>'}</div>
            </div>

            <div class="dashboard-grid" style="margin-top:16px">
                <!-- Issue Heatmap -->
                <div class="card stagger-in" style="animation-delay:0.2s">
                    <div class="card-header"><span class="card-title">🔥 Heatmap de Issues</span></div>
                    <div class="card-body" style="padding:24px">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-danger)">${issue_heatmap.critical || 0}</div>
                                <div style="color:var(--text-secondary);font-size:0.85rem">Criticas</div>
                                <div style="margin-top:4px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.critical||0)/heatTotal)*100}%;background:var(--accent-danger);border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-warning)">${issue_heatmap.warning || 0}</div>
                                <div style="color:var(--text-secondary);font-size:0.85rem">Warnings</div>
                                <div style="margin-top:4px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.warning||0)/heatTotal)*100}%;background:var(--accent-warning);border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:#60a5fa">${issue_heatmap.info || 0}</div>
                                <div style="color:var(--text-secondary);font-size:0.85rem">Info</div>
                                <div style="margin-top:4px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.info||0)/heatTotal)*100}%;background:#60a5fa;border-radius:2px"></div></div>
                            </div>
                            <div style="padding:16px;border-radius:var(--radius-md);background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2)">
                                <div style="font-size:1.8rem;font-weight:800;color:var(--accent-success)">${issue_heatmap.suggestion || 0}</div>
                                <div style="color:var(--text-secondary);font-size:0.85rem">Sugestoes</div>
                                <div style="margin-top:4px;height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:${((issue_heatmap.suggestion||0)/heatTotal)*100}%;background:var(--accent-success);border-radius:2px"></div></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Score Evolution -->
                <div class="card stagger-in" style="animation-delay:0.3s">
                    <div class="card-header"><span class="card-title">📈 Evolucao do Score</span><span class="card-badge">Ultimas 8 semanas</span></div>
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
                    <div>📦 ${p.max_repos === -1 ? 'Repos ilimitados' : p.max_repos + ' repos'}</div>
                    <div>🔍 ${p.max_analyses === -1 ? 'Analises ilimitadas' : p.max_analyses + ' analises/mes'}</div>
                    <div>👥 ${p.max_members === -1 ? 'Membros ilimitados' : p.max_members + ' membros'}</div>
                    <div>💬 ${p.max_chat_msgs === -1 ? 'Chat ilimitado' : p.max_chat_msgs + ' msgs chat/mes'}</div>
                </div>
                ${!isCurrent ? `<button class="btn ${p.price_monthly > 0 ? 'btn-primary' : 'btn-secondary'}" style="width:100%;margin-top:16px" data-change-plan="${p.slug}">${p.price_monthly > 0 ? 'Upgrade' : 'Selecionar'}</button>` : '<div style="margin-top:16px;text-align:center;color:var(--accent-success);font-weight:600">Plano ativo</div>'}
            </div>`;
        };

        $('billingContainer').innerHTML = `
            <!-- Current Usage -->
            <div class="card stagger-in" style="animation-delay:0.1s">
                <div class="card-header"><span class="card-title">Uso Atual — ${esc(plan.name || 'Free')}</span></div>
                <div class="card-body" style="padding:24px">
                    ${usageBar('Analises IA', usage.analyses || 0, plan.max_analyses || 50)}
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
                <div class="card-header"><span class="card-title">🔑 API Key (para CLI / CI/CD)</span></div>
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
    function renderLogsPage() {
        const logs = window.CodexfyLogs || [];
        pageContent.innerHTML = `<h1 class="page-title">Logs de Atividade</h1><p class="page-subtitle">Historico de acoes do sistema</p>
            <div class="card"><div class="card-header"><span class="card-title">Logs</span><span class="card-badge">${logs.length}</span></div>
            <div class="card-body">${logs.length ? `<table class="mr-table"><thead><tr><th></th><th>Acao</th><th>Detalhes</th><th>Usuario</th><th>Data</th></tr></thead><tbody>${logs.map(l => `<tr><td>${l.icon || ''}</td><td>${esc(l.action)}</td><td style="color:var(--text-secondary)">${esc(l.detail)}</td><td>${esc(l.user)}</td><td style="white-space:nowrap;color:var(--text-tertiary)">${new Date(l.time).toLocaleString('pt-BR')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state"><h3>Nenhum log</h3></div>'}</div></div>`;
    }

    // ── Init ─────────────────────────────────────────────────
    renderPage();
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeActionModal(); } });

})();
