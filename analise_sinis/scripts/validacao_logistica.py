"""Validação para frente das curvas logísticas regionais.

Ajusta cada região só com dados até 2016 (nível de referência 2012–2016) e compara as
previsões para 2017–2021 com a coleta per capita observada (Σ Co119 / Σ Co164 do ano).
Alternativas: equações atuais da plataforma (ABRELPE 2020), valor constante 2012–2016 e
reta ajustada às razões anuais 2011–2016.

Uso: python validacao_logistica.py painel.csv pasta_saida
"""
import sys

import numpy as np
import pandas as pd

import ajuste_logistico as al

ABRELPE = {"Norte": (-7753.0, 4.0), "Nordeste": (-4588.33, 2.44), "Centro-Oeste": (1258.333, -0.444),
           "Sudeste": (-10093.667, 5.222), "Sul": (-3985.333, 2.111)}
NIVEL_TREINO = (2012, 2016)
TESTE = range(2017, 2022)


def main(panel, out):
    p = pd.read_csv(panel, dtype={"cod": str})
    v = p[p.valid].copy()
    rows = []
    for reg in al.REG:
        g = v[v.regiao == reg]
        tr = g[g.year <= 2016]
        L = al.ratio(tr[tr.year.between(*NIVEL_TREINO)])
        serie, w = al.serie_ajustada(tr, L, NIVEL_TREINO)
        G0, r, K, _ = al.fit_map(serie, w, L, al.PRIOR_REG)
        anual = tr[tr.year >= 2011].groupby("year").apply(al.ratio)
        reta = np.polyfit(anual.index, anual.values, 1)
        for y in TESTE:
            obs = al.ratio(g[g.year == y])
            rows.append(dict(regiao=reg, ano=y, observado=obs,
                             logistica_rk4=al.rk4(G0, r, K, y),
                             constante_2012_2016=L,
                             reta_2011_2016=np.polyval(reta, y),
                             abrelpe_atual=ABRELPE[reg][0] + ABRELPE[reg][1] * y))
    d = pd.DataFrame(rows)
    modelos = ["logistica_rk4", "constante_2012_2016", "reta_2011_2016", "abrelpe_atual"]
    erro = pd.DataFrame({m: 100 * (d[m] / d.observado - 1) for m in modelos})
    resumo = pd.DataFrame({
        "erro_abs_medio_%": erro.abs().mean(),
        "vies_medio_%": erro.mean(),
        "erro_abs_nivel_5anos_%": [
            (100 * (d.groupby("regiao")[m].mean() / d.groupby("regiao").observado.mean() - 1)).abs().mean() for m in modelos],
    })
    pd.set_option("display.width", 200)
    print("Treino ≤ 2016, teste 2017–2021, 5 regiões × 5 anos")
    print(resumo.round(1).to_string())
    print("\nErro do nível médio 2017–2021 por região (%):")
    print((100 * (d.groupby("regiao")[modelos].mean().div(d.groupby("regiao").observado.mean(), axis=0) - 1)).round(1).to_string())
    d.to_csv(f"{out}/validacao_logistica_2017_2021.csv", index=False)
    resumo.to_csv(f"{out}/validacao_logistica_resumo.csv")


if __name__ == "__main__":
    main(*sys.argv[1:3])
