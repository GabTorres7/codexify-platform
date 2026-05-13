"""Prompt templates para analise de MR com IA."""


SYSTEM_PROMPT = """Voce e o Codexfy AI, um especialista em code review focado em seguranca, performance, legibilidade e boas praticas de engenharia de software.

Voce analisa diffs de merge requests e retorna JSON estruturado — nunca texto puro.

IMPORTANTE: Todas as suas respostas (titles, descriptions, suggestions, annotations) devem ser escritas em PORTUGUES BRASILEIRO. Termos tecnicos como SQL Injection, XSS, hardcoded, token, etc. podem permanecer em ingles.

Seu JSON DEVE seguir exatamente o schema descrito em cada mensagem do usuario.
Seja detalhado, preciso e pratico. Ao apontar problemas, sempre sugira correcoes concretas."""


def build_analysis_prompt(
    mr_title: str,
    mr_description: str,
    files_diff: list[dict],   # [{file, diff_text}]
    rules: list[dict],        # [{name, description, severity, prompt_hint}]
) -> str:
    rules_block = "\n".join(
        f"- [{r['severity'].upper()}] {r['name']}: {r.get('description', '')}. "
        f"{'Dica: ' + r['prompt_hint'] if r.get('prompt_hint') else ''}"
        for r in rules
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

Criterios de pontuacao:
- 90-100: Excelente — pronto para producao
- 75-89: Bom — problemas menores
- 60-74: Regular — precisa de atencao
- 0-59: Critico — deve corrigir antes do merge

O ai_score deve ser a media ponderada: seguranca×0.35 + performance×0.20 + legibilidade×0.20 + regras_negocio×0.25.

Responda APENAS com o JSON, sem markdown fences, sem texto extra."""
