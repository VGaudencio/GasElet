"""Curvas logísticas de coleta per capita (SNIS) por região e UF, integradas por Runge-Kutta 4.

Modelo:  dg/dt = r · g · (1 − g/K),  g(T0) = G0,  T0 = 2016,  g em kg/hab. atendido/ano.
Integração: RK4 com passo de 0,25 ano, para frente e para trás a partir de T0 (mesmo
algoritmo usado em client/src/utils/rsuProduction.js e server/controllers/PerCapita.cpp).

Série-alvo de cada grupo (região ou UF), 2003–2021:
    S_t = L · I_t
    L   = Σ Co119 / Σ Co164 nos municípios válidos de 2017–2021 (nível recente)
    I_t = índice anual ajustado por composição: efeito de ano de uma regressão de log(g)
          com efeito fixo de município, ponderada pela população (normalizado: média 2017–2021 = 1).
Peso de cada ano: √(nº de municípios), normalizado para média 1.

Região: estimativa penalizada (MAP) de (G0, r, K), minimizando
    Σ w_t·[ln S_t − ln g(t)]² / σ²  +  [(ln r − ln 0,05)/1,0]²  +  [ln(K/L)/0,30]²,   σ = 0,05
(prioris fracas: dinâmica lenta e teto perto do nível observado, salvo se os dados indicarem o contrário).
Restrições: 0,005 ≤ r ≤ 0,5; 0,5·L ≤ K ≤ 2,5·L; 0,5·L < g(t) < 2·L em 2000–2065.

UF com dados confiáveis (≥ 30 municípios em 2017–2021, ≥ 60% da população da UF
nos municípios válidos em 2019 e IC95% do nível com semiamplitude ≤ 15%): logística da
região reescalada para o nível da UF, isto é, mesmo r e G0, K multiplicados por
c = L_UF / média 2017–2021 da curva regional (um múltiplo de uma logística é uma logística).
A dinâmica própria de cada UF não é estimada: com séries de 11–19 anos e ruído de 3–12%,
ela produz extrapolações implausíveis (ex.: AM com 825 kg/hab/ano em 2000).
As demais UFs usam a curva da sua região.

Uso: python ajuste_logistico.py painel.csv POP.csv pasta_saida
"""
import json
import sys
import warnings

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.optimize import least_squares
from scipy.sparse.linalg import lsqr

warnings.filterwarnings("ignore")

T0, H, Y_MIN, Y_MAX = 2016, 0.25, 2000, 2065
NIVEL = (2017, 2021)
CRIT = dict(min_munic=30, min_cobertura=0.60, max_semi_ic=0.15)
PRIOR_REG = dict(sigma=0.05, mu_r=np.log(0.05), tau_r=1.0, mu_k=0.0, tau_k=0.30)  # ver docstring
REG = {
    "Norte": ["RO", "AC", "AM", "RR", "PA", "AP", "TO"],
    "Nordeste": ["MA", "PI", "CE", "RN", "PB", "PE", "AL", "SE", "BA"],
    "Sudeste": ["MG", "ES", "RJ", "SP"],
    "Sul": ["PR", "SC", "RS"],
    "Centro-Oeste": ["MS", "MT", "GO", "DF"],
}
UF2REG = {u: r for r, us in REG.items() for u in us}


def rk4(G0, r, K, t):
    """g(t) por RK4 a partir de g(T0) = G0 (passo 0,25 ano)."""
    n = int(round(abs(t - T0) / H))
    if n == 0:
        return G0
    h = (t - T0) / n
    g = G0
    f = lambda x: r * x * (1.0 - x / K)
    for _ in range(n):
        k1 = f(g)
        k2 = f(g + 0.5 * h * k1)
        k3 = f(g + 0.5 * h * k2)
        k4 = f(g + h * k3)
        g += h / 6.0 * (k1 + 2 * k2 + 2 * k3 + k4)
        if not (0.0 < g < 1e7):
            return float("inf")
    return g


def analytic(G0, r, K, t):
    return K / (1.0 + (K / G0 - 1.0) * np.exp(-r * (t - T0)))


def ratio(g):
    return g.CO119.sum() * 1000 / g.pop_atd.sum()


def fe_index(g, nivel=NIVEL):
    g = g[g.groupby("cod").cod.transform("size") >= 2]
    years = sorted(g.year.unique())
    cods = g.cod.unique()
    yi = {y: i for i, y in enumerate(years)}
    ci = {c: i for i, c in enumerate(cods)}
    n = len(g)
    w = np.sqrt(g.POP_TOT.values)
    rows = np.arange(n)
    Xc = sp.csr_matrix((np.ones(n), (rows, g.cod.map(ci).values)), shape=(n, len(cods)))
    yidx = g.year.map(yi).values
    m = yidx > 0
    Xy = sp.csr_matrix((np.ones(m.sum()), (rows[m], yidx[m] - 1)), shape=(n, len(years) - 1))
    X = sp.hstack([Xc, Xy]).tocsr()
    sol = lsqr(sp.diags(w) @ X, w * np.log(g.g_atd.values), atol=1e-12, btol=1e-12, iter_lim=50000)[0]
    idx = pd.Series(np.exp(np.concatenate([[0.0], sol[len(cods):]])), index=years)
    return idx / idx[[y for y in years if nivel[0] <= y <= nivel[1]]].mean()


rng = np.random.default_rng(42)


def boot_ci(g, B=400):
    cods = g.cod.unique()
    idx = {c: g.index[g.cod == c] for c in cods}
    vals = []
    for _ in range(B):
        s = rng.choice(cods, len(cods), replace=True)
        vals.append(ratio(g.loc[np.concatenate([idx[c] for c in s])]))
    return np.percentile(vals, [2.5, 97.5])


def serie_ajustada(g, L, nivel=NIVEL):
    idx = fe_index(g, nivel)
    n_t = g.groupby("year").cod.nunique().reindex(idx.index)
    keep = n_t >= 5
    w = np.sqrt(n_t[keep].astype(float))
    return (L * idx)[keep], (w / w.mean()).values


def fit_map(serie, w, L, prior):
    t = np.array(serie.index, float)
    y = np.log(serie.values)

    def resid(th):
        G0, r, K = np.exp(th)
        pred = np.array([rk4(G0, r, K, ti) for ti in t])
        pred = np.where(np.isfinite(pred), pred, 1e7)
        res = np.sqrt(w) * (y - np.log(np.maximum(pred, 1e-9))) / prior["sigma"]
        ends = np.array([rk4(G0, r, K, ti) for ti in range(Y_MIN, Y_MAX + 1, 5)] + [rk4(G0, r, K, Y_MAX)])
        ok = np.all(np.isfinite(ends)) and ends.min() > 0.5 * L and ends.max() < 2.0 * L
        pen = [(np.log(r) - prior["mu_r"]) / prior["tau_r"], (np.log(K / L) - prior["mu_k"]) / prior["tau_k"]]
        return np.concatenate([res, pen, [0.0 if ok else 1e3]])

    lb = np.log([0.5 * L, 0.005, 0.5 * L])
    ub = np.log([2.0 * L, 0.5, 2.5 * L])
    best = None
    for r0 in (0.02, 0.05, 0.15):
        for k0 in (0.8, 1.0, 1.2, 1.6):
            th0 = np.clip(np.log([L, r0, k0 * L]), lb + 1e-6, ub - 1e-6)
            s = least_squares(resid, th0, bounds=(lb, ub), method="trf", x_scale="jac")
            if s.fun[-1] == 0 and (best is None or s.cost < best.cost):
                best = s
    G0, r, K = np.exp(best.x)
    e = y - np.log([rk4(G0, r, K, ti) for ti in t])
    return G0, r, K, float(np.sqrt(np.average(e**2, weights=w)))


def stats(g, nivel, nome, popuf):
    gl = g[g.year.between(*NIVEL)]
    L = ratio(gl)
    lo, hi = boot_ci(gl)
    base_pop = popuf[nome] if nivel == "uf" else popuf[REG[nome]].sum()
    cob = gl[gl.year == 2019].POP_TOT.sum() / base_pop
    return L, lo, hi, cob, gl.cod.nunique()


def main(panel, popcsv, out):
    p = pd.read_csv(panel, dtype={"cod": str})
    v = p[p.valid].copy()
    pop = pd.read_csv(popcsv, sep=";", header=None, names=["ano", "uf", "nome", "pop"], encoding="utf-8-sig")
    popuf = pop[pop.ano == 2019].groupby("uf")["pop"].sum()
    rows, series_out = [], {}
    reg_fit = {}
    for nome in REG:
        g = v[v.regiao == nome]
        L, lo, hi, cob, n_mun = stats(g, "regiao", nome, popuf)
        serie, w = serie_ajustada(g, L)
        G0, r, K, rmse = fit_map(serie, w, L, PRIOR_REG)
        reg_fit[nome] = (G0, r, K, L)
        series_out[nome] = {int(k): float(x) for k, x in serie.items()}
        rows.append(dict(nivel="regiao", grupo=nome, regiao=nome, base="região", nivel_2017_2021=L, ic95_lo=lo, ic95_hi=hi,
                         semi_ic_pct=100 * (hi - lo) / 2 / L, munic=n_mun, cobertura_pop_2019_pct=100 * cob,
                         anos=f"{serie.index.min()}–{serie.index.max()}", G0=G0, r=r, K=K, c=1.0, rmse_log=rmse, confiavel=True, motivo=""))

    for uf in sorted(UF2REG):
        reg = UF2REG[uf]
        g = v[v.uf == uf]
        L, lo, hi, cob, n_mun = stats(g, "uf", uf, popuf)
        semi = (hi - lo) / 2 / L
        motivo = [m for m, cond in [
            (f"{n_mun} município(s) (<{CRIT['min_munic']})", n_mun < CRIT["min_munic"]),
            (f"cobertura {cob:.0%} (<{CRIT['min_cobertura']:.0%})", cob < CRIT["min_cobertura"]),
            (f"IC95% ±{semi:.0%} (>{CRIT['max_semi_ic']:.0%})", semi > CRIT["max_semi_ic"])] if cond]
        confiavel = not motivo
        G0r, rr, Kr, Lr = reg_fit[reg]
        c = L / np.mean([rk4(G0r, rr, Kr, y) for y in range(NIVEL[0], NIVEL[1] + 1)])
        rmse, anos = np.nan, ""
        try:  # aderência da curva escalada à série da própria UF (diagnóstico)
            serie, w = serie_ajustada(g, L)
            if len(serie) >= 5:
                e = np.log(serie.values) - np.log([c * rk4(G0r, rr, Kr, ti) for ti in serie.index])
                rmse, anos = float(np.sqrt(np.average(e**2, weights=w))), f"{serie.index.min()}–{serie.index.max()}"
                series_out[uf] = {int(k): float(x) for k, x in serie.items()}
        except Exception:
            pass
        if not confiavel:
            c = 1.0
        G0, r, K = c * G0r, rr, c * Kr
        rows.append(dict(nivel="uf", grupo=uf, regiao=reg, base="UF" if confiavel else f"região {reg}", nivel_2017_2021=L,
                         ic95_lo=lo, ic95_hi=hi, semi_ic_pct=100 * semi, munic=n_mun, cobertura_pop_2019_pct=100 * cob,
                         anos=anos, G0=G0, r=r, K=K, c=c, rmse_log=rmse, confiavel=confiavel, motivo="; ".join(motivo)))

    res = pd.DataFrame(rows)
    for y in (2000, 2005, 2010, 2021, 2030, 2045, 2065):
        res[f"g{y}"] = [rk4(a, b, c, y) for a, b, c in zip(res.G0, res.r, res.K)]
    err = max(abs(rk4(a, b, c, t) / analytic(a, b, c, t) - 1)
              for a, b, c in zip(res.G0, res.r, res.K) for t in range(Y_MIN, Y_MAX + 1))
    print(f"Erro relativo máximo RK4 (h = 0,25) × solução analítica, 2000–2065: {err:.1e}")
    pd.set_option("display.width", 260)
    pd.set_option("display.max_columns", 40)
    cols = ["nivel", "grupo", "base", "nivel_2017_2021", "semi_ic_pct", "munic", "cobertura_pop_2019_pct", "anos",
            "G0", "r", "K", "c", "rmse_log", "g2000", "g2010", "g2021", "g2045", "g2065", "motivo"]
    print(res[cols].round(3).to_string(index=False))

    # Curva × série observada (ajustada por composição), por região
    chk = []
    for nome, s in series_out.items():
        a, b, c = res.loc[res.grupo == nome, ["G0", "r", "K"]].iloc[0]
        for y, val in s.items():
            chk.append(dict(grupo=nome, ano=y, serie=val, curva=rk4(a, b, c, y)))
    chk = pd.DataFrame(chk)
    chk["erro_pct"] = 100 * (chk.curva / chk.serie - 1)
    print("\nErro da curva por região e ano (%):")
    print(chk[chk.grupo.isin(REG)].pivot(index="ano", columns="grupo", values="erro_pct").round(1).to_string())

    res.to_csv(f"{out}/logistica_parametros.csv", index=False)
    chk.to_csv(f"{out}/logistica_curva_vs_serie.csv", index=False)
    anos = list(range(Y_MIN, Y_MAX + 1))
    tab = pd.DataFrame({row.grupo: [rk4(row.G0, row.r, row.K, y) for y in anos] for row in res.itertuples()}, index=anos)
    tab.index.name = "ano"
    tab.round(2).to_csv(f"{out}/logistica_curvas_2000_2065.csv")
    json.dump({row.grupo: dict(G0=row.G0, r=row.r, K=row.K, base=row.base) for row in res.itertuples()},
              open(f"{out}/logistica_parametros.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
