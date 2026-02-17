# Análise de melhorias estruturais e de segurança — Assinatura eletrônica de PDFs

## Diagnóstico geral

O código atual funciona como **protótipo local** (single-page, client-side), mas não atende requisitos de segurança para um serviço de assinatura eletrônica confiável em produção. Os principais riscos são:

- autenticação fraca (credenciais hardcoded no front-end);
- ausência de assinatura criptográfica com certificado ICP-Brasil/eIDAS;
- cadeia de suprimentos insegura (scripts/fontes CDN sem pinning e sem SRI);
- dados sensíveis persistidos em `localStorage` (inclusive PDFs em base64);
- ausência de trilha de auditoria e não repúdio;
- falta de separação arquitetural entre UI, domínio e infraestrutura.

---

## Melhorias significativas (prioridade alta)

## 1) Mudar de “assinatura visual” para assinatura digital criptográfica (PAdES)

Hoje o sistema desenha texto/imagem no PDF. Isso **não garante integridade, autenticidade e não repúdio**.

- Implementar assinatura PAdES (CMS/PKCS#7) no PDF, com:
  - certificado do assinante;
  - carimbo de tempo (TSA);
  - validação de cadeia e revogação (CRL/OCSP);
  - LTV (Long Term Validation) quando aplicável.
- Separar “rubrica visual” (opcional) da assinatura criptográfica (obrigatória).

Impacto: elimina o principal risco jurídico/técnico do produto.

## 2) Remover autenticação no cliente e adotar backend seguro

As credenciais `USER='HSE'` e `PASS='Silver'` no JavaScript tornam o login trivialmente quebrável.

- Criar backend (ex.: Node/Java/.NET) com:
  - autenticação real (OIDC/SAML/AD, ou ao menos JWT com refresh);
  - MFA para perfis privilegiados;
  - controle de sessão no servidor;
  - autorização por papéis (admin editor, assinante, auditor).
- Nunca expor segredo no front-end.

Impacto: reduz comprometimento total por inspeção do código.

## 3) Eliminar armazenamento sensível em `localStorage`

`localStorage` guarda template, fila assinada e PDFs base64. Isso facilita exfiltração em caso de XSS/dispositivo comprometido.

- Migrar persistência para backend com criptografia em repouso;
- no cliente, manter apenas estado efêmero em memória;
- se cache local for inevitável, usar dados minimizados e com expiração curta.

Impacto: reduz vazamento de documentos/PII.

## 4) Fortalecer segurança de supply chain do front-end

Bibliotecas e fonte são carregadas por CDN sem Subresource Integrity.

- Fixar versões + hash SRI + `crossorigin`;
- preferir assets versionados no próprio domínio;
- ativar CSP estrita (`script-src 'self'` + nonces/hashes);
- bloquear inline script/`eval`;
- remover `@font-face` remota durante geração sensível.

Impacto: mitiga comprometimento por terceiros.

## 5) Implementar trilha de auditoria imutável

Para confiabilidade de assinatura eletrônica, é essencial auditoria completa.

- Registrar eventos: upload, posicionamento, pré-visualização, assinatura, download;
- metadados: usuário, IP, user-agent, hash SHA-256 do documento antes/depois, timestamp UTC;
- armazenar logs append-only (WORM ou imutabilidade lógica);
- gerar relatório de evidências por documento.

Impacto: suporta perícia, compliance e contestação.

---

## Melhorias estruturais de arquitetura (médio prazo)

## 6) Modularizar a aplicação

Hoje todo o sistema está em um único arquivo HTML com JS inline.

- Separar em camadas/módulos:
  - `ui/` (views, componentes);
  - `application/` (casos de uso);
  - `domain/` (entidades: documento, assinatura, template);
  - `infrastructure/` (pdf engine, storage, auth client).
- Introduzir TypeScript para tipagem de estado/DTOs;
- usar bundler e lint/format/test pipeline.

Impacto: aumenta manutenibilidade, testabilidade e evolução segura.

## 7) Estado explícito e máquina de estados de fluxo

Fluxo atual usa toggles de display e estado global mutável.

- Modelar estados (`login`, `menu`, `edição`, `assinatura`, `preview`, `finalizado`);
- impedir transições inválidas (ex.: finalizar sem PDF válido);
- centralizar validações de pré-condição.

Impacto: menos bugs de fluxo e inconsistências.

## 8) Estratégia de validação de entrada e normalização

Campos críticos (CPF, datas, telefone) têm máscara, mas sem validação robusta.

- validar CPF (dígitos verificadores), datas reais e limites;
- sanitizar/normalizar texto com whitelist por campo;
- impor tamanho máximo e rejeitar entradas malformadas;
- validar tipo/tamanho do PDF (MIME + magic bytes + limite MB).

Impacto: reduz falhas de qualidade e superfícies de ataque.

---

## Segurança de aplicação (hardening)

## 9) Proteções web essenciais

- CSP restritiva;
- `X-Frame-Options`/`frame-ancestors` para evitar clickjacking;
- `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy`;
- cookies `HttpOnly`, `Secure`, `SameSite=Strict` (quando houver backend);
- proteção CSRF para ações autenticadas.

## 10) Gestão segura de arquivos PDF

- processar PDFs em sandbox/server isolado;
- limite de páginas/tamanho/tempo de processamento;
- varredura antimalware;
- timeout/circuit breaker para documentos maliciosos.

## 11) Privacidade e LGPD

- minimização de PII;
- política de retenção e descarte automático;
- consentimento/base legal e registro de tratamento;
- pseudonimização em logs sempre que possível.

---

## Confiabilidade e operações

## 12) Observabilidade e qualidade

- testes unitários (regras de posição/validação);
- testes de integração (pipeline de assinatura);
- testes E2E do fluxo do usuário;
- monitoramento de erro e métricas (latência, taxa de falha por etapa);
- SLOs para geração/assinatura/download.

## 13) Controle de versões de template

Templates de campos por página devem ser versionados.

- armazenar template com versão, autor e data;
- permitir rollback;
- vincular assinatura à versão exata do template usada.

Impacto: rastreabilidade e governança operacional.

---

## Roadmap sugerido (executável)

1. **Sprint 1 (segurança crítica):** backend auth + remoção de credenciais hardcoded + remoção de dados sensíveis do `localStorage`.
2. **Sprint 2 (jurídico-técnico):** assinatura PAdES + TSA + validação cadeia/OCSP/CRL.
3. **Sprint 3 (hardening):** CSP/SRI/headers + pipeline CI com SAST/Dependabot.
4. **Sprint 4 (arquitetura):** modularização em TypeScript + testes automatizados.
5. **Sprint 5 (compliance):** auditoria imutável + política LGPD + relatório de evidências.

---

## Conclusão

Para ser um site de assinatura eletrônica **segura e confiável**, a mudança mais importante é sair de uma lógica de “preenchimento visual de PDF” para uma plataforma com **assinatura criptográfica verificável, backend de confiança, auditoria e controles de segurança de aplicação**.
