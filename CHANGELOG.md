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
- resumo do aterro no topo de todas as telas: nome do cenário, linha do tempo da operação, municípios, região, população e resíduo previsto.
- rodapé nas telas internas com a marca, o crédito do Laboratório de Microengenharia do CEAR (UFPB) e as fontes de dados.
- geração per capita do SNIS: curvas logísticas integradas por Runge-Kutta 4 de 2000 a 2065, ajustadas à coleta per capita de 2003–2021 (Co119/Co164). Cada município usa a curva da sua UF quando os dados do estado são confiáveis (15 UFs) e a da região nos demais casos. Ajuste, critérios e validação em `analise_sinis/`.

### Changed

- reorganização da documentação principal do projeto.
- indicadores sem repetir o resumo do aterro: Início mostra população inicial e final; Metano mostra metano gerado e recuperado.
- interface revista: tipografia Barlow, painéis com contorno em vez de sombra, laranja só para metano e energia, textos com acentos e em linguagem direta; tela "Gráficos" passa a se chamar "Metano"; login sem elementos decorativos nem links sem função.
- README reescrito com banner, capturas de tela (desktop e celular), ícones, modelo de cálculo e arquitetura; imagens em `docs/readme/`.
- MCF segue a Tabela 3.1 do IPCC 2006 (1,0 / 0,8 / 0,4 / 0,6); rótulos antigos continuam aceitos.
- captação de biogás (`captacaoBiogasPct`) passa a reduzir o metano disponível para geração (`metanoRecuperadoTAno`).
- casas atendidas e comparação de geradores usam a energia gerada (limitada pela potência nominal).
- período padrão unificado em 2000–2060 em todas as telas; modelo do aterro centralizado em `client/src/utils/landfillModel.js`.

- campo "Temperatura na região anaeróbica" substituído por "Zona climática (IPCC)", que preenche o k padrão da Tab. 3.3 do IPCC 2006 (tropical úmido 0,17; tropical seco 0,065; temperado úmido 0,09; temperado seco 0,05).
- gráficos: anos em múltiplos de 5, eixos em formato compacto pt-BR, tooltips com separador de milhar, linha de encerramento do aterro no gráfico de metano e CH₄ também em m³.
- tabela de RSU mostra a geração per capita usada em cada ano; Lo exibido também em m³/t.
- massa de RSU do cenário passa a ser a soma dos municípios, cada um com a per capita da sua UF; as linhas do cálculo trazem `perCapita`. As retas regionais anteriores (ABRELPE 2020) foram removidas; o campo `metodoPerCapita` de cenários salvos é ignorado.

- DOC de metal, vidro e "outros" passa de 0,01 para 0 (inertes, IPCC 2006 Tab. 2.4).
- zona climática "Temperado seco" (k 0,05) passa a indicar que não ocorre no Brasil.

### Fixed

- barra lateral: o botão do usuário aparecia ativo na tela Início e desalinhado; os ícones mudavam de posição durante a expansão. A expansão agora só anima a largura, abre com um pequeno atraso e também pelo teclado.
- gráfico de metano e mapas da tela de Energia vazavam para a direita em telas com menos de ~1.500 px (a grade de 12 colunas era sobrescrita por `.home-grid`).
- tela de Resíduos transbordava na horizontal no celular.
- CSS do login alterava a cor do texto e a margem de formulários no app inteiro.

- decaimento de primeira ordem sem o fator de normalização `(1 − e^−k)/k` do IPCC GPG 2000 (Eq. 5.1): cada lote gerava `k/(1 − e^−k)` vezes `L0 · M` (+2,5% com k = 0,05). O novo campo `metodoFod` escolhe entre `ipcc2000` (padrão), `ipcc2006` (atraso de 6 meses) e `legado`, que reproduz os resultados anteriores.
- k negativo gerava metano negativo; agora é tratado como 0.
- decaimento de primeira ordem do metano usava o ano inicial do aterro em vez do ano de deposição, subestimando a produção.
- telas de Metano e Energia descartavam `gerenciamento`, fazendo o MCF ser sempre 1,0.
