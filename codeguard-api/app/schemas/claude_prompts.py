"""Claude prompt templates for MR analysis."""


SYSTEM_PROMPT = """You are CodeGuard AI, an expert code reviewer specializing in security, performance, readability, and software engineering best practices.

You analyze merge request diffs and return structured JSON — never plain text.

Your JSON output MUST conform exactly to the schema described in each user message.
Be thorough, precise, and actionable. When flagging issues, always suggest concrete fixes."""


def build_analysis_prompt(
    mr_title: str,
    mr_description: str,
    files_diff: list[dict],   # [{file, diff_text}]
    rules: list[dict],        # [{name, description, severity, prompt_hint}]
) -> str:
    rules_block = "\n".join(
        f"- [{r['severity'].upper()}] {r['name']}: {r.get('description', '')}. "
        f"{'Hint: ' + r['prompt_hint'] if r.get('prompt_hint') else ''}"
        for r in rules
    )

    diffs_block = ""
    for f in files_diff:
        diffs_block += f"\n\n### File: {f['file']}\n```diff\n{f['diff_text']}\n```"

    return f"""# Merge Request Analysis

## MR Title
{mr_title}

## MR Description
{mr_description or 'No description provided.'}

## Rules to Enforce
{rules_block}

## Code Changes (unified diff)
{diffs_block}

---

## Required Output Format

Respond ONLY with a valid JSON object matching this exact schema:

```json
{{
  "ai_score": <integer 0-100, overall quality>,
  "score_security": <integer 0-100>,
  "score_performance": <integer 0-100>,
  "score_readability": <integer 0-100>,
  "score_business_rules": <integer 0-100>,
  "issues": [
    {{
      "severity": "critical|warning|info|suggestion",
      "title": "<short title>",
      "description": "<detailed explanation>",
      "file_path": "<file path or null>",
      "line_ref": "<line number or range, e.g. '23' or '20-29', or null>",
      "suggestion": "<concrete fix suggestion>"
    }}
  ],
  "diff_annotations": [
    {{
      "file_path": "<file path>",
      "after_line": <integer line number>,
      "type": "danger|warning|info",
      "text": "<brief annotation shown inline in the diff>"
    }}
  ],
  "rule_results": [
    {{
      "rule_name": "<exact rule name from the list above>",
      "status": "pass|fail|warn",
      "description": "<explanation of why it passed or failed>"
    }}
  ]
}}
```

Score rubric:
- 90-100: Excellent — production ready
- 75-89: Good — minor issues
- 60-74: Regular — needs attention
- 0-59: Critical — must fix before merge

The overall ai_score should be the weighted average: security×0.35 + performance×0.20 + readability×0.20 + business_rules×0.25.

Return ONLY the JSON object, no markdown fences, no extra text."""
