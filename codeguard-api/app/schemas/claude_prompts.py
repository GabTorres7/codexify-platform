"""Prompt templates para analise de MR com IA."""


SYSTEM_PROMPT = """Voce e o Codexfy AI, um especialista em code review focado em seguranca, performance, legibilidade e boas praticas de engenharia de software.

Voce analisa diffs de merge requests e retorna JSON estruturado — nunca texto puro.

IMPORTANTE: Todas as suas respostas (titles, descriptions, suggestions, annotations) devem ser escritas em PORTUGUES BRASILEIRO. Termos tecnicos como SQL Injection, XSS, hardcoded, token, etc. podem permanecer em ingles.

Seu JSON DEVE seguir exatamente o schema descrito em cada mensagem do usuario.
Seja detalhado, preciso e pratico. Ao apontar problemas, sempre sugira correcoes concretas."""


DEFAULT_RULES = [
    {"name": "Segurança de Dados", "severity": "critical", "description": "Verificar se há exposição de dados sensíveis, secrets hardcoded, SQL injection ou XSS"},
    {"name": "Tratamento de Erros", "severity": "high", "description": "Verificar se exceções são tratadas corretamente, sem swallow silencioso ou exposição de stack traces"},
    {"name": "Validação de Input", "severity": "high", "description": "Verificar se inputs do usuário são validados e sanitizados antes do uso"},
    {"name": "Boas Práticas", "severity": "medium", "description": "Verificar aderência a padrões do projeto, código duplicado, complexidade ciclomática e princípios SOLID"},
    {"name": "Performance", "severity": "medium", "description": "Verificar queries N+1, loops desnecessários, falta de paginação e operações bloqueantes"},
    {"name": "Legibilidade", "severity": "low", "description": "Verificar nomes descritivos, funções curtas, organização lógica e comentários úteis"},
]


def build_analysis_prompt(
    mr_title: str,
    mr_description: str,
    files_diff: list[dict],   # [{file, diff_text}]
    rules: list[dict],        # [{name, description, severity, prompt_hint}]
) -> str:
    effective_rules = rules if rules else DEFAULT_RULES
    rules_block = "\n".join(
        f"- [{r['severity'].upper()}] {r['name']}: {r.get('description', '')}. "
        f"{'Dica: ' + r['prompt_hint'] if r.get('prompt_hint') else ''}"
        for r in effective_rules
    )

    diffs_block = ""
    for f in files_diff:
        diffs_block += f"\n\n### Arquivo: {f['file']}\n```diff\n{f['diff_text']}\n```"

    return f"""# Analise de Merge Request

## Titulo do MR
{mr_title}

## Descricao do MR
{mr_description or 'Sem descricao fornecida.'}

## Regras a Verificar
{rules_block}

## Alteracoes no Codigo (unified diff)
{diffs_block}

---

## Formato de Saida Obrigatorio

Responda APENAS com um JSON valido seguindo exatamente este schema:

```json
{{
  "ai_score": <inteiro 0-100, qualidade geral>,
  "score_security": <inteiro 0-100>,
  "score_performance": <inteiro 0-100>,
  "score_readability": <inteiro 0-100>,
  "score_business_rules": <inteiro 0-100>,
  "issues": [
    {{
      "severity": "critical|warning|info|suggestion",
      "title": "<titulo curto em portugues>",
      "description": "<explicacao detalhada em portugues>",
      "file_path": "<caminho do arquivo ou null>",
      "line_ref": "<numero da linha ou intervalo, ex: '23' ou '20-29', ou null>",
      "suggestion": "<sugestao concreta de correcao em portugues>"
    }}
  ],
  "diff_annotations": [
    {{
      "file_path": "<caminho do arquivo>",
      "after_line": <numero inteiro da linha>,
      "type": "danger|warning|info",
      "text": "<anotacao breve em portugues exibida inline no diff>"
    }}
  ],
  "rule_results": [
    {{
      "rule_name": "<nome exato da regra da lista acima>",
      "status": "pass|fail|warn",
      "description": "<explicacao em portugues de por que passou ou falhou>"
    }}
  ]
}}
```

INSTRUCOES CRITICAS DE PONTUACAO — LEIA COM ATENCAO:

NÃO de scores padrao. NÃO de o mesmo valor para todas as categorias. Cada categoria DEVE ser avaliada INDEPENDENTEMENTE com base em evidencias concretas no codigo.

## Criterios por categoria (score 0-100):

### score_security:
- 0-20: Vulnerabilidades criticas (SQL injection, eval(), secrets hardcoded, XSS, execucao arbitraria)
- 21-40: Falhas graves (autenticacao fraca, hash MD5/SHA1 pra senhas, exposicao de dados sensiveis)
- 41-60: Problemas moderados (falta de validacao de input, CORS permissivo demais)
- 61-80: Poucos problemas menores (headers de seguranca faltando, log excessivo)
- 81-100: Codigo seguro, sem vulnerabilidades encontradas

### score_performance:
- 0-20: Problemas criticos (queries N+1, loops infinitos, falta de paginacao em datasets grandes)
- 21-40: Ineficiencias graves (queries sem indice, carregamento desnecessario de dados)
- 41-60: Pode melhorar (caching ausente, queries repetidas)
- 61-80: Aceitavel com melhorias menores
- 81-100: Codigo performatico, bem otimizado

### score_readability:
- 0-20: Ilegivel (sem nomes descritivos, funcoes gigantes, sem estrutura)
- 21-40: Dificil de manter (logica confusa, duplicacao excessiva)
- 41-60: Razoavel mas precisa refatorar
- 61-80: Bom com ajustes menores
- 81-100: Limpo, bem organizado, facil de entender

### score_business_rules:
- 0-20: Regras de negocio ignoradas ou implementadas errado
- 21-40: Falhas significativas na logica de negocio
- 41-60: Implementacao parcial
- 61-80: Funcional com ressalvas
- 81-100: Regras bem implementadas e validadas

EXEMPLOS de diferenciacao:
- Codigo com SQL injection + secrets expostos: score_security=15, mas score_readability pode ser 70 se estiver bem organizado
- Codigo limpo e legivel mas sem paginacao: score_readability=85, score_performance=35
- Os scores DEVEM variar. Se voce retornar todos os 4 scores iguais ou proximos, voce FALHOU na analise.

O ai_score deve ser a media ponderada: seguranca×0.35 + performance×0.20 + legibilidade×0.20 + regras_negocio×0.25.

Responda APENAS com o JSON, sem markdown fences, sem texto extra."""
