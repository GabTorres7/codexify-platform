/* ================================================
   CodeGuard AI - Analysis Engine (Simulated)
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
        if (score >= 90) return { label: 'Excelente', class: 'high', color: '#34d399', description: 'O código atende a todos os padrões de qualidade. Aprovado para merge.' };
        if (score >= 75) return { label: 'Bom', class: 'medium', color: '#fbbf24', description: 'O código é aceitável com pequenos pontos de melhoria. Considerar as sugestões da IA.' };
        if (score >= 60) return { label: 'Regular', class: 'medium', color: '#fb923c', description: 'O código possui issues que devem ser resolvidas antes do merge. Revisão necessária.' };
        return { label: 'Crítico', class: 'low', color: '#f87171', description: 'O código possui problemas críticos que impedem o merge. Correções obrigatórias.' };
    },

    /**
     * Get status info 
     */
    getStatusInfo(status) {
        const map = {
            approved: { label: 'Aprovado', class: 'badge-approved', icon: '✓' },
            pending: { label: 'Pendente', class: 'badge-pending', icon: '⏳' },
            issues: { label: 'Issues', class: 'badge-issues', icon: '!' },
            analyzing: { label: 'Analisando', class: 'badge-analyzing', icon: '⚙' },
            merged: { label: 'Merged', class: 'badge-merged', icon: '⎇' },
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
     * Format time ago
     */
    timeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date('2026-03-06T11:20:00');
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffH = Math.floor(diffMin / 60);
        const diffD = Math.floor(diffH / 24);

        if (diffMin < 1) return 'agora';
        if (diffMin < 60) return `${diffMin}min atrás`;
        if (diffH < 24) return `${diffH}h atrás`;
        if (diffD === 1) return 'ontem';
        return `${diffD}d atrás`;
    },

    /**
     * Get category label
     */
    getCategoryLabel(key) {
        const map = {
            security: '🔒 Segurança',
            performance: '⚡ Performance',
            readability: '📖 Legibilidade',
            businessRules: '📋 Regras de Negócio',
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
    }
};
