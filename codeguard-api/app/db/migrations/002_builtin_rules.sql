-- Built-in default rules (org_id = NULL means global defaults, copied per org on creation)
-- These match the 12 rules shown in the frontend Rules page

INSERT INTO rules (name, description, severity, is_active, is_builtin, prompt_hint)
VALUES
  ('Tratamento de Erros',
   'Verifica se blocos try/catch adequados são usados em chamadas assíncronas',
   'critical', true, true,
   'Check every async/await or Promise chain for proper try/catch error handling. Flag any unhandled rejections.'),

  ('Armazenamento Seguro',
   'Evita armazenar tokens ou dados sensíveis em localStorage ou sessionStorage',
   'critical', true, true,
   'Flag any use of localStorage or sessionStorage to store tokens, passwords, or PII. Suggest secure alternatives like httpOnly cookies or in-memory storage.'),

  ('Sem Credenciais Hardcoded',
   'Detecta senhas, chaves de API ou segredos escritos diretamente no código',
   'critical', true, true,
   'Scan for hardcoded passwords, API keys, secrets, private keys, or connection strings embedded in source code. Flag any string that looks like a credential.'),

  ('Nomenclatura de Classes',
   'Verifica se nomes de classes seguem PascalCase',
   'warning', true, true,
   'Ensure all class declarations use PascalCase naming convention.'),

  ('Paginação em Listagens',
   'Garante que endpoints de listagem implementem paginação',
   'warning', true, true,
   'Check that any endpoint or function that returns a list of records implements pagination (limit/offset or cursor-based). Flag queries that could return unbounded result sets.'),

  ('Rate Limiting',
   'Verifica se endpoints críticos possuem proteção contra abuso por rate limiting',
   'warning', true, true,
   'Check that public-facing endpoints, especially auth endpoints and expensive operations, have rate limiting applied.'),

  ('Validação de Input',
   'Verifica se dados de entrada do usuário são validados antes de processamento',
   'critical', true, true,
   'Ensure all user-supplied input is validated and sanitized before use. Flag missing validation on request bodies, query params, and path params.'),

  ('Injeção SQL',
   'Detecta possíveis vulnerabilidades de SQL injection',
   'critical', true, true,
   'Flag any SQL query built by string concatenation or f-string with user input. Require parameterized queries or ORM use.'),

  ('Logs de Auditoria',
   'Verifica se operações sensíveis geram registros de auditoria',
   'warning', true, true,
   'Check that sensitive operations (auth, payments, data deletion, privilege changes) emit audit log entries.'),

  ('Testes Unitários',
   'Verifica se novos módulos possuem cobertura de testes',
   'info', true, true,
   'Check if new service classes or utility functions have corresponding test files. Warn if coverage appears missing.'),

  ('Documentação de API',
   'Verifica se novos endpoints possuem docstrings ou comentários explicativos',
   'info', true, true,
   'Ensure new API route handlers have docstrings describing their purpose, parameters, and return values.'),

  ('Complexidade Ciclomática',
   'Detecta funções com alta complexidade que devem ser refatoradas',
   'warning', true, true,
   'Flag functions with deeply nested conditionals (more than 3 levels) or excessive branching. Suggest refactoring into smaller functions.')
ON CONFLICT DO NOTHING;
