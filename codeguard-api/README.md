# CodeGuard API

API Python (FastAPI) para análise automatizada de Merge Requests com IA.

## Stack

- **Python 3.12** + **FastAPI** — API assíncrona
- **Supabase** (PostgreSQL) — banco de dados
- **Claude API** (Anthropic) — análise de código com IA
- **GitHub & GitLab** — integração com plataformas Git

---

## Setup rápido

### 1. Clone e crie o ambiente

```bash
cd codeguard-api
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
# Edite o .env com suas chaves
```

Variáveis obrigatórias:
| Variável | Descrição |
|---|---|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service-role do Supabase |
| `ANTHROPIC_API_KEY` | Chave da API da Anthropic (Claude) |
| `SECRET_KEY` | String aleatória para JWT |
| `PUBLIC_API_URL` | URL pública da API (para registrar webhooks) |

### 3. Crie o banco de dados

No SQL Editor do Supabase, execute em ordem:

```sql
-- Execute os arquivos de migração:
app/db/migrations/001_initial_schema.sql
app/db/migrations/002_builtin_rules.sql
```

### 4. Inicie a API

```bash
uvicorn app.main:app --reload --port 8000
```

Acesse a documentação: http://localhost:8000/docs

---

## Endpoints principais

### Autenticação
```
POST /api/v1/auth/login          → JWT access + refresh token
POST /api/v1/auth/refresh        → Renovar token
POST /api/v1/auth/api-keys       → Criar API key (para CI/CD)
```

### Repositórios
```
POST   /api/v1/orgs/{org_id}/repos           → Adicionar 1 repositório
POST   /api/v1/orgs/{org_id}/repos/bulk      → Adicionar VÁRIOS repositórios de uma vez
GET    /api/v1/orgs/{org_id}/repos           → Listar repositórios
DELETE /api/v1/orgs/{org_id}/repos/{id}      → Remover repositório
POST   /api/v1/orgs/{org_id}/repos/{id}/sync → Sincronizar MRs manualmente
```

### Merge Requests
```
GET  /api/v1/orgs/{org_id}/repos/{repo_id}/mrs              → Listar MRs
GET  /api/v1/orgs/{org_id}/repos/{repo_id}/mrs/{mr_id}      → Detalhe completo + análise
POST /api/v1/orgs/{org_id}/repos/{repo_id}/mrs/{mr_id}/analyze → Disparar análise IA
```

### Dashboard
```
GET /api/v1/orgs/{org_id}/dashboard/metrics  → Contadores para os cards
GET /api/v1/orgs/{org_id}/dashboard/activity → Feed de atividade recente
GET /api/v1/orgs/{org_id}/dashboard/chart    → Dados do gráfico semanal
```

### Webhooks (chamados automaticamente pelo GitHub/GitLab)
```
POST /api/v1/webhooks/github   → Recebe eventos de Pull Request
POST /api/v1/webhooks/gitlab   → Recebe eventos de Merge Request
```

---

## Adicionando repositórios em bulk

Para empresas com muitos repositórios, use o endpoint bulk:

```python
import httpx

repos = [
    {"platform": "github", "full_name": "empresa/backend",  "access_token": "ghp_..."},
    {"platform": "github", "full_name": "empresa/frontend", "access_token": "ghp_..."},
    {"platform": "gitlab", "full_name": "empresa/mobile",   "access_token": "glpat_..."},
    # ... quantos quiser
]

resp = httpx.post(
    "http://localhost:8000/api/v1/orgs/{org_id}/repos/bulk",
    json={"repositories": repos},
    headers={"Authorization": "Bearer {seu_token}"},
)

result = resp.json()
print(f"Adicionados: {len(result['succeeded'])}")
print(f"Falhas: {len(result['failed'])}")
for f in result['failed']:
    print(f"  ✗ {f['full_name']}: {f['error']}")
```

---

## Autenticação

### Via JWT (dashboard web)
```
Authorization: Bearer eyJ...
```

### Via API Key (CI/CD, scripts)
```
Authorization: Bearer cg_live_abc123...
```

Crie uma API key no endpoint `POST /api/v1/auth/api-keys`.

---

## Como funciona a análise

1. MR é criado/atualizado no GitHub/GitLab → webhook dispara
2. API cria um registro de análise com `status: queued`
3. Background task busca o diff completo da plataforma Git
4. Regras ativas do repositório são carregadas
5. Claude recebe o diff + regras e retorna JSON estruturado
6. Resultados são salvos (score, issues, anotações no diff, resultados de regras)
7. Status do MR é atualizado: `approved` (score ≥ min_score) ou `issues`

**Pesos do score:**
- Segurança: 35%
- Performance: 20%
- Legibilidade: 20%
- Regras de Negócio: 25%

---

## Testes

```bash
pytest tests/ -v
```

---

## Estrutura do projeto

```
codeguard-api/
├── app/
│   ├── main.py                  # FastAPI app
│   ├── config.py                # Configurações via .env
│   ├── dependencies.py          # Injeção de dependências (auth)
│   ├── api/v1/                  # Endpoints
│   │   ├── auth.py
│   │   ├── organizations.py
│   │   ├── repositories.py      ← bulk add aqui
│   │   ├── merge_requests.py
│   │   ├── analyses.py
│   │   ├── rules.py
│   │   ├── webhooks.py
│   │   └── dashboard.py
│   ├── services/
│   │   ├── claude_service.py    ← integração Claude
│   │   ├── github_service.py    ← integração GitHub
│   │   ├── gitlab_service.py    ← integração GitLab
│   │   ├── analysis_service.py  ← pipeline de análise
│   │   └── rule_service.py
│   ├── db/
│   │   ├── client.py            ← cliente Supabase
│   │   └── migrations/          ← SQL para criar o banco
│   └── schemas/
│       └── claude_prompts.py    ← prompts para o Claude
└── tests/
```
