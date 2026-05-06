/* ================================================
   Codefy AI - Main Application
   ================================================ */

(function () {
    'use strict';

    // ── API ──────────────────────────────────────────────────
    const API = window.location.origin + '/api/v1';
    let TOKEN = localStorage.getItem('cg_token') || '';
    let ORG_ID = localStorage.getItem('cg_org_id') || '';

    function hdrs() {
        return { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) };
    }
    async function api(method, path, body) {
        const r = await fetch(API + path, { method, headers: hdrs(), ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r.status === 204) return null;
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw d;
        return d;
    }
    async function ensureAuth() {
        if (TOKEN && ORG_ID) return;
        try {
            const res = await api('POST', '/auth/login', { email: 'admin@starian.com', password: 'admin123' });
            TOKEN = res.access_token;
            localStorage.setItem('cg_token', TOKEN);
            ORG_ID = localStorage.getItem('cg_org_id') || 'dcaf3bbf-047d-4fea-aab4-0b68ac83a2d8';
            localStorage.setItem('cg_org_id', ORG_ID);
        } catch (_) { /* fallback to mock */ }
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

    // ── Router ───────────────────────────────────────────────
    function renderPage(q) {
        const r = {
            dashboard: () => renderDashboard(q),
            'merge-requests': () => renderMergeRequests(q),
            repositories: renderReposPage,
            team: renderTeamPage,
            rules: renderRulesPage,
            settings: renderSettingsPage,
        };
        pageContent.style.animation = 'none';
        pageContent.offsetHeight;
        pageContent.style.animation = 'fadeIn 0.3s ease';
        (r[currentPage] || r.dashboard)();
    }

    // ================================================================
    //  DASHBOARD
    // ================================================================
    function renderDashboard(q) {
        const metrics = AnalysisEngine.getMetrics(MERGE_REQUESTS);
        const mrs = q ? MERGE_REQUESTS.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q)) : MERGE_REQUESTS;
        pageContent.innerHTML = `
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Visao geral das analises de merge requests — Codefy AI</p>
            <div class="metrics-grid">
                ${metricCard('purple', '📋', metrics.pending, 'MRs Pendentes', '↑ 12%', 0)}
                ${metricCard('green', '✓', metrics.approved, 'Aprovados / Merged', '↑ 8%', 0.1)}
                ${metricCard('red', '⚠', metrics.withIssues, 'Com Problemas', '↑ 3%', 0.2)}
                ${metricCard('yellow', '⭐', metrics.avgScore + '<span style="font-size:1rem;color:var(--text-tertiary)">/100</span>', 'Score Medio IA', '', 0.3)}
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
                    <div class="card-body"><div class="chart-container">${CHART_DATA.map(d => `<div class="chart-bar-group"><div class="chart-bar" style="height:${(d.value/24)*170}px" data-value="${d.value}"></div><span class="chart-label">${d.label}</span></div>`).join('')}</div></div>
                </div>
                <div class="card stagger-in" style="animation-delay:0.45s">
                    <div class="card-header"><span class="card-title">Atividade Recente</span></div>
                    <div class="card-body"><div class="activity-list">${RECENT_ACTIVITY.map(a => `<div class="activity-item"><div class="activity-dot ${a.type}"></div><div class="activity-info"><div class="activity-text">${a.text}</div><div class="activity-time">${a.time}</div></div></div>`).join('')}</div></div>
                </div>
            </div>
            <div class="card stagger-in" style="animation-delay:0.55s">
                <div class="card-header"><span class="card-title">Merge Requests Recentes</span><span class="card-badge">${mrs.length} total</span></div>
                <div class="mr-table-container">${renderMRTable(mrs)}</div>
            </div>`;

        attachTableListeners();
        $('qaBtnAddRepo').addEventListener('click', openAddRepoModal);
        $('qaBtnInvite').addEventListener('click', openInviteMemberModal);
        $('qaBtnBulk').addEventListener('click', openBulkAddModal);
    }

    function metricCard(color, icon, value, label, trend, delay) {
        return `<div class="metric-card stagger-in" style="animation-delay:${delay}s"><div class="metric-card-header"><div class="metric-icon ${color}">${icon}</div>${trend ? `<span class="metric-trend up">${trend}</span>` : ''}</div><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>`;
    }

    // ================================================================
    //  REPOSITORIES PAGE
    // ================================================================
    function renderReposPage() {
        pageContent.innerHTML = `
            <div class="page-header-row">
                <div><h1 class="page-title">Repositorios</h1><p class="page-subtitle">Gerencie os repositorios monitorados pela IA</p></div>
                <div class="page-actions">
                    <button class="btn btn-secondary" id="btnBulkAdd">📦 Importar em Massa</button>
                    <button class="btn btn-primary" id="btnAddRepo">+ Adicionar Repositorio</button>
                </div>
            </div>

            <!-- How to add -->
            <div class="info-banner stagger-in" style="animation-delay:0.1s">
                <div class="info-icon">💡</div>
                <div>
                    <strong>Como adicionar repositorios?</strong>
                    <p>Clique em <em>"+ Adicionar Repositorio"</em> para adicionar um por um, ou <em>"Importar em Massa"</em> para enviar varios de uma vez (ideal para empresas). Voce precisa do <strong>access token</strong> da plataforma (GitHub ou GitLab).</p>
                </div>
            </div>

            <div id="reposListContainer" style="margin-top:16px">
                <div class="card"><div class="card-body" style="padding:40px;text-align:center;color:var(--text-tertiary)">
                    <div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Carregando...</div>
                </div></div>
            </div>`;

        $('btnAddRepo').addEventListener('click', openAddRepoModal);
        $('btnBulkAdd').addEventListener('click', openBulkAddModal);
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
                            <div class="repo-actions">
                                <button class="btn-icon" title="Sincronizar" data-sync="${r.id}">🔄</button>
                                <button class="btn-icon btn-danger" title="Remover" data-del="${r.id}">🗑</button>
                            </div>
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
                <div class="page-actions"><button class="btn btn-primary" id="btnInvite">+ Convidar Membro</button></div>
            </div>
            <div id="teamContainer" style="margin-top:16px">
                <div class="card"><div class="card-body" style="padding:40px;text-align:center;color:var(--text-tertiary)">
                    <div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Carregando...</div>
                </div></div>
            </div>`;
        $('btnInvite').addEventListener('click', openInviteMemberModal);
        loadTeam();
    }

    async function loadTeam() {
        const c = $('teamContainer');
        try {
            await ensureAuth();
            const members = await api('GET', `/orgs/${ORG_ID}/members`);
            if (!members.length) { c.innerHTML = `<div class="empty-state-card"><h3>Nenhum membro</h3><p>Convide membros para sua organizacao</p><button class="btn btn-primary" onclick="document.getElementById('btnInvite').click()" style="margin-top:16px">+ Convidar Primeiro Membro</button></div>`; return; }
            c.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">Membros da Organizacao</span><span class="card-badge">${members.length}</span></div>
                <div class="team-grid">${members.map(m => {
                    const initials = m.initials || m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                    return `<div class="team-card">
                        <div class="team-card-avatar" style="background:${m.color || '#818cf8'}">${initials}</div>
                        <div class="team-card-info">
                            <div class="team-card-name">${esc(m.name)}</div>
                            <div class="team-card-email">${esc(m.email)}</div>
                        </div>
                        <span class="badge ${m.role === 'admin' ? 'badge-approved' : 'badge-pending'}">${m.role === 'admin' ? '👑 Admin' : '👤 Membro'}</span>
                        <button class="btn btn-secondary btn-sm" data-edit-member='${JSON.stringify({ id: m.id, name: m.name, email: m.email, role: m.role, color: m.color || '#818cf8' })}'>✏ Editar</button>
                    </div>`;
                }).join('')}</div></div>`;

            c.querySelectorAll('[data-edit-member]').forEach(btn => {
                btn.addEventListener('click', () => openEditMemberModal(JSON.parse(btn.dataset.editMember)));
            });
        } catch (e) { c.innerHTML = `<div class="empty-state-card"><h3>Erro</h3><p>${e.message || e.detail || 'Verifique a API'}</p></div>`; }
    }

    function openInviteMemberModal() {
        openActionModal('Convidar Membro', `
            <div class="form-card">
                ${formRow('Nome Completo', '', '<input class="input" id="fName" placeholder="Joao Silva">')}
                ${formRow('E-mail', '', '<input class="input" id="fEmail" type="email" placeholder="joao@empresa.com">')}
                ${formRow('Cargo', '', '<select class="input" id="fRole"><option value="member">Membro</option><option value="admin">Admin</option></select>')}
                <div class="form-actions"><button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button><button class="btn btn-primary" id="fInviteSubmit">Convidar</button></div>
                <div id="fInviteResult"></div>
            </div>`);
        $('fInviteSubmit').addEventListener('click', async () => {
            const btn = $('fInviteSubmit'); btn.disabled = true; btn.textContent = 'Convidando...';
            try {
                await ensureAuth();
                const m = await api('POST', `/orgs/${ORG_ID}/members/invite`, { name: $('fName').value, email: $('fEmail').value, role: $('fRole').value });
                toast(`${m.name} adicionado!`); closeActionModal(); if (currentPage === 'team') loadTeam();
            } catch (e) { $('fInviteResult').innerHTML = `<div class="form-error">✗ ${e.message || e.detail || JSON.stringify(e)}</div>`; btn.disabled = false; btn.textContent = 'Convidar'; }
        });
    }

    function openEditMemberModal(member) {
        openActionModal('Editar Perfil — ' + member.name, `
            <div class="form-card">
                <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)">
                    <div class="team-card-avatar" style="background:${member.color};width:56px;height:56px;font-size:1.2rem">${member.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}</div>
                    <div><div style="font-size:1.1rem;font-weight:700;color:var(--text-primary)">${esc(member.name)}</div><div style="color:var(--text-tertiary);font-size:0.88rem">${esc(member.email)}</div></div>
                </div>
                ${formRow('Nome', '', `<input class="input" id="eName" value="${esc(member.name)}">`)}
                ${formRow('E-mail', '', `<input class="input" id="eEmail" value="${esc(member.email)}" disabled style="opacity:0.6">`)}
                ${formRow('Cargo', '', `<select class="input" id="eRole"><option value="member" ${member.role === 'member' ? 'selected' : ''}>Membro</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option></select>`)}
                ${formRow('Cor do Avatar', '', `<input type="color" id="eColor" value="${member.color}" style="width:48px;height:36px;border:none;background:none;cursor:pointer">`)}
                <div class="form-actions"><button class="btn btn-secondary" onclick="document.getElementById('actionModalClose').click()">Cancelar</button><button class="btn btn-primary" id="eSubmit">Salvar</button></div>
                <div id="eResult"></div>
            </div>`);
        $('eSubmit').addEventListener('click', () => {
            // Frontend-only update for now (API PATCH /users not exposed yet)
            toast('Perfil atualizado!');
            closeActionModal();
        });
    }

    // ================================================================
    //  MERGE REQUESTS
    // ================================================================
    function renderMergeRequests(q) {
        const mrs = q ? MERGE_REQUESTS.filter(m => m.title.toLowerCase().includes(q) || m.branch.toLowerCase().includes(q) || m.author.name.toLowerCase().includes(q)) : MERGE_REQUESTS;
        pageContent.innerHTML = `<h1 class="page-title">Merge Requests</h1><p class="page-subtitle">Todos os merge requests com analise detalhada da IA</p>
            <div class="card"><div class="card-header"><span class="card-title">Todos os MRs</span><span class="card-badge">${mrs.length}</span></div><div class="mr-table-container">${renderMRTable(mrs)}</div></div>`;
        attachTableListeners();
    }

    function renderMRTable(mrs) {
        if (!mrs.length) return `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><h3>Nenhum MR encontrado</h3></div>`;
        return `<table class="mr-table"><thead><tr><th>Merge Request</th><th>Autor</th><th>Status</th><th>Score</th><th>Alteracoes</th><th>Tempo</th></tr></thead><tbody>${mrs.map(mr => {
            const s = AnalysisEngine.getStatusInfo(mr.status), g = mr.aiScore !== null ? AnalysisEngine.getScoreGrade(mr.aiScore) : null;
            return `<tr data-mr-id="${mr.id}"><td><div class="mr-title-cell"><span class="mr-title">${mr.title}</span><span class="mr-branch">${mr.branch} → ${mr.targetBranch}</span></div></td><td><div class="mr-author"><div class="mr-author-avatar" style="background:${mr.author.color}">${mr.author.initials}</div><span>${mr.author.name}</span></div></td><td><span class="badge ${s.class}">${s.icon} ${s.label}</span></td><td>${g ? `<div class="score-pill"><div class="score-ring ${g.class}">${mr.aiScore}</div></div>` : '<div class="analyzing-indicator"><div class="analyzing-dots"><span></span><span></span><span></span></div>Analisando</div>'}</td><td><span style="color:var(--accent-success)">+${mr.additions}</span> <span style="color:var(--accent-danger)">-${mr.deletions}</span></td><td style="color:var(--text-secondary);white-space:nowrap">${AnalysisEngine.timeAgo(mr.createdAt)}</td></tr>`;
        }).join('')}</tbody></table>`;
    }

    function attachTableListeners() {
        document.querySelectorAll('.mr-table tbody tr').forEach(row => row.addEventListener('click', () => openMRDetail(parseInt(row.dataset.mrId))));
    }

    // ── MR Detail Modal (unchanged logic) ────────────────────
    function openMRDetail(id) {
        currentMR = MERGE_REQUESTS.find(m => m.id === id); if (!currentMR) return;
        currentTab = 'overview';
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="overview"]').classList.add('active');
        modalTitle.textContent = currentMR.title;
        modalSubtitle.textContent = currentMR.branch + ' → ' + currentMR.targetBranch;
        renderTabContent(); modalOverlay.classList.add('active'); document.body.style.overflow = 'hidden';
    }

    function renderTabContent() {
        if (!currentMR) return;
        ({ overview: renderOverviewTab, analysis: renderAnalysisTab, diff: renderDiffTab, rules: renderRulesTab }[currentTab] || renderOverviewTab)();
    }

    function renderOverviewTab() {
        const mr = currentMR, s = AnalysisEngine.getStatusInfo(mr.status);
        modalBody.innerHTML = `<div class="overview-grid"><div class="overview-item"><span class="overview-label">Autor</span><div class="mr-author" style="margin-top:4px"><div class="mr-author-avatar" style="background:${mr.author.color}">${mr.author.initials}</div><span class="overview-value">${mr.author.name}</span></div></div><div class="overview-item"><span class="overview-label">Status</span><span class="badge ${s.class}" style="margin-top:4px">${s.icon} ${s.label}</span></div><div class="overview-item"><span class="overview-label">Branch</span><span class="overview-value" style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">${mr.branch} → ${mr.targetBranch}</span></div><div class="overview-item"><span class="overview-label">Criado em</span><span class="overview-value">${new Date(mr.createdAt).toLocaleString('pt-BR')}</span></div><div class="overview-item" style="grid-column:1/-1"><span class="overview-label">Descricao</span><span class="overview-value">${mr.description}</span></div></div><div class="overview-stats"><div class="overview-stat"><div class="overview-stat-value green">+${mr.additions}</div><div class="overview-stat-label">Adicoes</div></div><div class="overview-stat"><div class="overview-stat-value red">-${mr.deletions}</div><div class="overview-stat-label">Remocoes</div></div><div class="overview-stat"><div class="overview-stat-value blue">${mr.filesChanged}</div><div class="overview-stat-label">Arquivos</div></div></div>${mr.files && mr.files.length ? '<h3 style="margin-top:24px;margin-bottom:12px;font-size:1rem;font-weight:700">Arquivos Alterados</h3>' + mr.files.map(f => `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--bg-tertiary);border-radius:var(--radius-sm);margin-bottom:4px;font-family:'JetBrains Mono',monospace;font-size:0.82rem"><span>📄 ${f.name}</span><span><span style="color:var(--accent-success)">+${f.additions}</span> <span style="color:var(--accent-danger)">-${f.deletions}</span></span></div>`).join('') : ''}`;
    }

    function renderAnalysisTab() {
        const mr = currentMR;
        if (mr.aiScore === null) { modalBody.innerHTML = '<div class="empty-state"><div class="analyzing-indicator" style="font-size:1rem;padding:12px 24px;margin-bottom:16px"><div class="analyzing-dots"><span></span><span></span><span></span></div>Analise em andamento</div><h3>A IA esta analisando este MR</h3></div>'; return; }
        const g = AnalysisEngine.getScoreGrade(mr.aiScore);
        modalBody.innerHTML = `<div class="analysis-score-section"><div class="score-circle" style="--score-color:${g.color};--score-pct:${mr.aiScore};color:${g.color}">${mr.aiScore}</div><div class="score-details"><div class="score-title">${g.label}</div><div class="score-description">${g.description}</div></div></div><div class="analysis-categories">${Object.entries(mr.analysisCategories).map(([k,v]) => `<div class="category-card"><div class="category-header"><span class="category-name">${AnalysisEngine.getCategoryLabel(k)}</span><span class="category-score" style="color:${AnalysisEngine.getCategoryColor(v)}">${v}/100</span></div><div class="category-bar"><div class="category-bar-fill" style="width:${v}%;background:${AnalysisEngine.getCategoryColor(v)}"></div></div></div>`).join('')}</div>${mr.issues.length ? `<div class="issues-section"><h3>🔴 Issues (${mr.issues.length})</h3>${mr.issues.map(i => `<div class="issue-card ${i.severity}"><div class="issue-header"><span class="issue-title">${i.title}</span><span class="issue-severity ${i.severity}">${i.severity.toUpperCase()}</span></div><div class="issue-file">${i.file}</div><div class="issue-description">${i.description}</div>${i.suggestion ? `<div class="issue-suggestion"><strong>💡 Sugestao</strong> ${i.suggestion}</div>` : ''}</div>`).join('')}</div>` : '<div class="empty-state" style="padding:30px"><h3>Sem issues! 🎉</h3></div>'}`;
    }

    function renderDiffTab() {
        const mr = currentMR;
        if (!mr.diff || !mr.diff.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Diff nao disponivel</h3></div>'; return; }
        modalBody.innerHTML = mr.diff.map(f => {
            let h = ''; f.lines.forEach(l => {
                h += `<div class="diff-line ${l.type}"><span class="diff-line-number">${l.num}</span><span class="diff-line-content">${esc(l.content)}</span></div>`;
                if (f.annotations) { const a = f.annotations.find(a => a.afterLine === l.num); if (a) h += `<div class="diff-annotation ${a.type === 'danger' ? 'danger-annotation' : a.type === 'warning' ? 'warning-annotation' : ''}"><div class="diff-annotation-icon">IA</div><div class="diff-annotation-text">${a.text}</div></div>`; }
            });
            return `<div class="diff-file"><div class="diff-file-header"><span>📄 ${f.file}</span><div class="diff-file-stats"><span class="added">+${f.lines.filter(l=>l.type==='added').length}</span><span class="removed">-${f.lines.filter(l=>l.type==='removed').length}</span></div></div><div class="diff-content">${h}</div></div>`;
        }).join('');
    }

    function renderRulesTab() {
        const mr = currentMR;
        if (!mr.rules || !mr.rules.length) { modalBody.innerHTML = '<div class="empty-state"><h3>Regras pendentes</h3></div>'; return; }
        const c = AnalysisEngine.countRules(mr.rules), icons = { pass: '✓', fail: '✗', warn: '⚠' };
        modalBody.innerHTML = `<div class="rules-summary"><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-success)">${c.pass}</div><div class="rules-summary-label">Aprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-danger)">${c.fail}</div><div class="rules-summary-label">Reprovadas</div></div><div class="rules-summary-item"><div class="rules-summary-value" style="color:var(--accent-warning)">${c.warn}</div><div class="rules-summary-label">Atencao</div></div></div>${mr.rules.map(r => `<div class="rule-item"><div class="rule-status-icon ${r.status}">${icons[r.status]}</div><div class="rule-info"><div class="rule-name">${r.name}</div><div class="rule-desc">${r.desc}</div></div></div>`).join('')}`;
    }

    // ================================================================
    //  RULES PAGE
    // ================================================================
    function renderRulesPage() {
        pageContent.innerHTML = `<h1 class="page-title">Regras de Negocio</h1><p class="page-subtitle">Configure as regras que a IA verifica em cada merge request</p><div class="rules-page-grid">${CONFIGURABLE_RULES.map((r,i) => `<div class="rule-config-card stagger-in" style="animation-delay:${i*0.06}s"><div class="rule-config-header"><span class="rule-config-title">${r.name}</span><button class="rule-toggle ${r.active ? 'active' : ''}" data-rule-id="${r.id}"></button></div><div class="rule-config-desc">${r.desc}</div><div class="rule-config-severity"><span class="issue-severity ${r.severity}">${r.severity.toUpperCase()}</span><span>${r.active ? 'Ativa' : 'Inativa'}</span></div></div>`).join('')}</div>`;
        document.querySelectorAll('.rule-toggle').forEach(t => t.addEventListener('click', () => {
            const r = CONFIGURABLE_RULES.find(x => x.id === parseInt(t.dataset.ruleId));
            if (r) { r.active = !r.active; t.classList.toggle('active'); t.closest('.rule-config-card').querySelector('.rule-config-severity span:last-child').textContent = r.active ? 'Ativa' : 'Inativa'; }
        }));
    }

    // ================================================================
    //  SETTINGS PAGE
    // ================================================================
    function renderSettingsPage() {
        pageContent.innerHTML = `<h1 class="page-title">Configuracoes</h1><p class="page-subtitle">Integracoes e preferencias — Codefy AI</p>
            <div class="settings-section stagger-in"><h3 class="settings-section-title">🔗 Integracao Git</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>Plataforma</h4><p>Plataforma de versionamento</p></div><select class="settings-input" style="min-width:180px"><option>GitHub</option><option>GitLab</option><option>Bitbucket</option></select></div><div class="settings-row"><div class="settings-row-info"><h4>Access Token</h4><p>Token com permissao de leitura</p></div><input class="settings-input" type="password" placeholder="ghp_xxx" value="ghp-abc123"></div></div></div>
            <div class="settings-section stagger-in" style="animation-delay:0.15s"><h3 class="settings-section-title">🤖 IA</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>Modelo</h4><p>Modelo de IA para analise</p></div><select class="settings-input" style="min-width:180px"><option>Claude Sonnet 4.6</option><option>Claude Opus 4.6</option><option>GPT-4o</option></select></div><div class="settings-row"><div class="settings-row-info"><h4>API Key</h4></div><input class="settings-input" type="password" placeholder="sk-ant-..." value="sk-ant-..."></div><div class="settings-row"><div class="settings-row-info"><h4>Analise Automatica</h4><p>Analisar novos MRs automaticamente</p></div><button class="rule-toggle active" id="autoToggle"></button></div><div class="settings-row"><div class="settings-row-info"><h4>Score Minimo</h4><p>MRs abaixo serao sinalizados</p></div><input class="settings-input" type="number" min="0" max="100" value="75" style="min-width:100px;text-align:center"></div></div></div>
            <div class="settings-section stagger-in" style="animation-delay:0.3s"><h3 class="settings-section-title">🔔 Notificacoes</h3><div class="settings-card"><div class="settings-row"><div class="settings-row-info"><h4>E-mail</h4><p>Receber analises por e-mail</p></div><button class="rule-toggle active"></button></div><div class="settings-row"><div class="settings-row-info"><h4>Webhook Slack/Discord</h4></div><input class="settings-input" type="text" placeholder="https://hooks.slack.com/..."></div></div></div>`;
        const at = $('autoToggle'); if (at) at.addEventListener('click', () => at.classList.toggle('active'));
        document.querySelectorAll('.settings-section .rule-toggle:not(#autoToggle)').forEach(t => t.addEventListener('click', () => t.classList.toggle('active')));
    }

    // ── Init ─────────────────────────────────────────────────
    renderPage();
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeActionModal(); } });

})();
