# Coleta per capita de RSU a partir do SNIS-RS (2003–2021)

Origem das curvas de geração per capita da plataforma (`metodoPerCapita = "snis"`,
`client/src/utils/rsuProduction.js` e `server/controllers/PerCapita.cpp`).

Dados de entrada: `../DADOS SINIS/` (diagnósticos e planilhas municipais do SNIS-RS).
Variáveis: Co119 (RDO+RPU coletado, t/ano), Co164 (pop. atendida declarada; Co050+Co147 até 2010),
POP_TOT/Ge001, POP_URB/Ge002. Per capita = Co119 / pop. atendida (equivale ao IN028 do SNIS, em kg/hab/ano).
Filtros: Co119 > 0, 0,2–3,0 kg/hab/dia, pop. atendida ≤ 1,05 × pop. total.

## Curvas da plataforma

Modelo logístico `dg/dt = r·g·(1 − g/K)`, `g(2016) = G0`, integrado por Runge-Kutta 4 (passo de 0,25 ano)
de 2000 a 2065. Detalhes no cabeçalho de `scripts/ajuste_logistico.py`:

- **Região:** ajuste penalizado (MAP) à série 2003–2021 ajustada por composição (efeito fixo de município,
  ponderado pela população), no nível de 2017–2021.
- **UF com dados confiáveis** (≥ 30 municípios, ≥ 60% da população coberta, IC95% do nível ≤ ±15%): logística
  da região reescalada para o nível da UF (mesmo r; G0 e K proporcionais). 15 UFs: AM, BA, ES, GO, MG, MT, PA,
  PB, PR, RJ, RN, RS, SC, SE, SP.
- **Demais UFs** (AC, AL, AP, CE, DF, MA, MS, PE, PI, RO, RR, TO): curva da região.

Depois de reajustar, `scripts/gerar_codigo.py` grava os parâmetros no cliente e no servidor (entre os
marcadores `<gerado:snis-logistica>`).

## Execução

Python com pandas, numpy, scipy, statsmodels, xlrd e openpyxl, na ordem:

    python scripts/extract.py "../DADOS SINIS" raw_long.csv
    python scripts/panel.py raw_long.csv resultados/painel_municipal_snis_2003_2021.csv
    python scripts/models.py resultados/painel_municipal_snis_2003_2021.csv resultados
    python scripts/validate.py resultados/painel_municipal_snis_2003_2021.csv resultados
    python scripts/tabela_uf.py resultados/painel_municipal_snis_2003_2021.csv ../server/Dados/POP.csv resultados
    python scripts/ajuste_logistico.py resultados/painel_municipal_snis_2003_2021.csv ../server/Dados/POP.csv resultados
    (cd scripts && python -c "import validacao_logistica as v; v.main('../resultados/painel_municipal_snis_2003_2021.csv', '../resultados')")
    python scripts/gerar_codigo.py resultados/logistica_parametros.csv ..

## Resultados

- `resultados/logistica_parametros.csv` / `.json` — G0, r, K por região e UF, nível 2017–2021, IC95%, critérios de confiabilidade
- `resultados/logistica_curvas_2000_2065.csv` — per capita anual (kg/hab/ano) de cada curva, 2000–2065
- `resultados/logistica_curva_vs_serie.csv` — curva × série observada ajustada por composição
- `resultados/validacao_logistica_2017_2021.csv` e `_resumo.csv` — ajuste até 2016, teste 2017–2021
- `resultados/percapita_uf_regiao_2017_2021.csv` — valor por UF e região (2017–2021), IC95% bootstrap, tendência, elasticidade ao porte
- `resultados/tendencia_efeito_fixo.csv` — tendência anual dentro do município (efeito fixo), simples e ponderada pela população
- `resultados/validacao_fora_da_amostra.csv` — modelos de nível: treino 2011–2017, teste 2018–2021
- `resultados/serie_regional_snis_2003_2021.csv` — série regional SNIS × retas ABRELPE 2020

## Limitações

- SNIS mede massa **coletada** declarada pelos municípios (por habitante atendido), não a geração total;
  a taxa de coleta da plataforma deve ser a cobertura (Co164 / população total).
- Sem dados antes de 2003; 2000–2002 e 2022–2065 são extrapolação da curva.
- Validação para frente (ajuste até 2016): erro médio de 8% em 2017–2021, contra 5% de um valor constante
  e 15% das retas ABRELPE 2020.
