/* ================================================
   Codexfy AI - Analysis Engine
   ================================================ */

const AnalysisEngine = {
    /**
     * Calculate overall quality score
     */
    calculateOverallScore(categories) {
        const weights = {
            security: 0.35,
            performance: 0.20,
            readability: 0.20,
            businessRules: 0.25,
        };
        let score = 0;
        let totalWeight = 0;
        for (const [key, weight] of Object.entries(weights)) {
            if (categories[key] > 0) {
                score += categories[key] * weight;
                totalWeight += weight;
            }
        }
        return totalWeight > 0 ? Math.round(score / totalWeight * (totalWeight / Object.values(weights).reduce((a, b) => a + b, 0))) : 0;
    },

    /**
     * Get score grade label
     */
    getScoreGrade(score) {
        if (score >= 65) return { label: 'Excelente', class: 'high', color: '#34d399', description: 'O código atende aos padrões de qualidade. Aprovado para merge.' };
        if (score >= 50) return { label: 'Regular', class: 'medium', color: '#fbbf24', description: 'O código possui pontos de melhoria. Considerar as sugestões da IA.' };
        return { label: 'Crítico', class: 'low', color: '#f87171', description: 'O código possui problemas críticos que impedem o merge. Correções obrigatórias.' };
    },

    /**
     * Get status info 
     */
    getStatusInfo(status) {
        const map = {
            approved: { label: 'Aprovado', class: 'badge-approved', icon: '<i data-lucide="check-circle" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></i>' },
            pending: { label: 'Pendente', class: 'badge-pending', icon: '<i data-lucide="clock" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></i>' },
            issues: { label: 'Issues', class: 'badge-issues', icon: '<i data-lucide="alert-triangle" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></i>' },
            analyzing: { label: 'Analisando', class: 'badge-analyzing', icon: '<i data-lucide="loader" style="width:14px;height:14px;display:inline-block;vertical-align:middle" class="icon-spin"></i>' },
            merged: { label: 'Merged', class: 'badge-merged', icon: '<i data-lucide="git-merge" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></i>' },
        };
        return map[status] || map.pending;
    },

    /**
     * Count rules by status 
     */
    countRules(rules) {
        return {
            pass: rules.filter(r => r.status === 'pass').length,
            fail: rules.filter(r => r.status === 'fail').length,
            warn: rules.filter(r => r.status === 'warn').length,
        };
    },

    /**
     * Get severity icon
     */
    getSeverityIcon(severity) {
        const map = {
            critical: '🔴',
            warning: '🟡',
            info: '🔵',
            suggestion: '🟢',
        };
        return map[severity] || '⚪';
    },

    /**
     * Format time ago — now uses real current time
     */
    timeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffH = Math.floor(diffMin / 60);
        const diffD = Math.floor(diffH / 24);

        if (diffMin < 1) return 'agora';
        if (diffMin < 60) return `${diffMin}min atrás`;
        if (diffH < 24) return `${diffH}h atrás`;
        if (diffD === 1) return 'ontem';
        if (diffD < 30) return `${diffD}d atrás`;
        return `${Math.floor(diffD / 30)}m atrás`;
    },

    /**
     * Get category label
     */
    getCategoryLabel(key) {
        const map = {
            security: '🔒 Segurança',
            performance: '⚡ Performance',
            readability: '📖 Legibilidade',
            businessRules: 'Regras de Negócio',
        };
        return map[key] || key;
    },

    /**
     * Get category bar color
     */
    getCategoryColor(score) {
        if (score >= 85) return 'var(--accent-success)';
        if (score >= 65) return 'var(--accent-warning)';
        return 'var(--accent-danger)';
    },

    /**
     * Get metrics from MRs
     */
    getMetrics(mrs) {
        const pending = mrs.filter(m => m.status === 'pending' || m.status === 'analyzing').length;
        const approved = mrs.filter(m => m.status === 'approved' || m.status === 'merged').length;
        const withIssues = mrs.filter(m => m.status === 'issues').length;
        const total = mrs.filter(m => m.aiScore !== null).length;
        const avgScore = total > 0 ? Math.round(mrs.filter(m => m.aiScore !== null).reduce((s, m) => s + m.aiScore, 0) / total) : 0;
        return { pending, approved, withIssues, avgScore, total };
    },

    /**
     * Export MRs to CSV
     */
    exportCSV(mrs) {
        const headers = ['ID', 'Título', 'Branch', 'Branch Alvo', 'Autor', 'Status', 'Score IA', 'Adições', 'Remoções', 'Arquivos Alterados', 'Criado Em'];
        const rows = mrs.map(mr => [
            mr.id,
            `"${mr.title.replace(/"/g, '""')}"`,
            mr.branch,
            mr.targetBranch,
            mr.author.name,
            mr.status,
            mr.aiScore ?? 'Analisando',
            mr.additions,
            mr.deletions,
            mr.filesChanged,
            new Date(mr.createdAt).toLocaleString('pt-BR')
        ]);
        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `codexfy_merge_requests_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }
};
