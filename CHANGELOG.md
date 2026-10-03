# Changelog

Todas as mudanças relevantes deste projeto devem ser documentadas aqui.

O formato segue a ideia do [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e versionamento semântico.

## [Unreleased]

### Added

- README profissional para apresentação em GitHub/LinkedIn.
- documentação técnica em `docs/API.md`, `docs/ARCHITECTURE.md` e `docs/DEPLOY.md`.
- arquivos de governança: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`.
- fallback de persistência local e flush explícito no logout para reduzir perda de estado.

### Changed

- reorganização da documentação principal do projeto.
- MCF segue a Tabela 3.1 do IPCC 2006 (1,0 / 0,8 / 0,4 / 0,6); rótulos antigos continuam aceitos.
- captação de biogás (`captacaoBiogasPct`) passa a reduzir o metano disponível para geração (`metanoRecuperadoTAno`).
- casas atendidas e comparação de geradores usam a energia gerada (limitada pela potência nominal).
- período padrão unificado em 2000–2060 em todas as telas; modelo do aterro centralizado em `client/src/utils/landfillModel.js`.

- campo "Temperatura na região anaeróbica" substituído por "Zona climática (IPCC)", que preenche o k padrão da Tab. 3.3 do IPCC 2006 (tropical úmido 0,17; tropical seco 0,065; temperado úmido 0,09; temperado seco 0,05).
- gráficos: anos em múltiplos de 5, eixos em formato compacto pt-BR, tooltips com separador de milhar, linha de encerramento do aterro no gráfico de metano e CH₄ também em m³.
- tabela de RSU mostra a geração per capita usada em cada ano; Lo exibido também em m³/t.

### Fixed

- decaimento de primeira ordem do metano usava o ano inicial do aterro em vez do ano de deposição, subestimando a produção.
- telas de Metano e Energia descartavam `gerenciamento`, fazendo o MCF ser sempre 1,0.
