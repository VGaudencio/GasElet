import sys, pandas as pd, numpy as np, statsmodels.formula.api as smf, warnings
warnings.filterwarnings('ignore')
p = pd.read_csv(sys.argv[1], dtype={'cod':str})
pop = pd.read_csv(sys.argv[2], sep=';', header=None, names=['ano','uf','nome','pop'], encoding='utf-8-sig')
popuf = pop[pop.ano==2019].groupby('uf')['pop'].sum()
v = p[p.valid & p.year.between(2017, 2021)].copy()
ratio = lambda g: g.CO119.sum()*1000/g.pop_atd.sum()
rng = np.random.default_rng(42)
def boot(g, B=400):
    cods = g.cod.unique(); idx = {c: g.index[g.cod==c] for c in cods}
    vals = []
    for _ in range(B):
        s = rng.choice(cods, len(cods), replace=True)
        gg = g.loc[np.concatenate([idx[c] for c in s])]
        vals.append(ratio(gg))
    return np.percentile(vals, [2.5, 97.5])
fe = pd.read_csv(sys.argv[3]+'/tendencia_efeito_fixo.csv')
rows = []
for level in ['regiao', 'uf']:
    for k, g in v.groupby(level):
        ann = g.groupby('year').apply(ratio)
        lo, hi = boot(g)
        cover = g[g.year==2019].POP_TOT.sum() / (popuf.get(k) if level=='uf' else popuf[[u for u in popuf.index if u in set(p[p.regiao==k].uf)]].sum())
        f = fe[(fe.nivel==level) & (fe.grupo==k)]
        rows.append({'nivel':level, 'grupo':k, 'g_kg_hab_ano':ratio(g), 'ic95_lo':lo, 'ic95_hi':hi, 'kg_hab_dia':ratio(g)/365,
                     'min_anual':ann.min(), 'max_anual':ann.max(), 'munic':g.cod.nunique(), 'pop_coberta_2019_%':100*cover,
                     'tend_pond_%a':f['tend_pond_pop_%a'].iloc[0] if len(f) else np.nan, 'tend_ic95':f['ic95_pond'].iloc[0] if len(f) else np.nan})
t = pd.DataFrame(rows)
# size elasticity per region (pop-weighted log model within UF)
v['lg'] = np.log(v.g_atd); v['lpop'] = np.log(v.POP_TOT)
el = {}
for r, g in v.groupby('regiao'):
    m = smf.ols('lg ~ C(uf) + lpop', g).fit(cov_type='cluster', cov_kwds={'groups': g.cod.astype('category').cat.codes})
    el[r] = (m.params['lpop'], 1.96*m.bse['lpop'])
t['elasticidade_porte'] = t.apply(lambda r: el[r.grupo][0] if r.nivel=='regiao' else np.nan, axis=1)
t['elast_ic95'] = t.apply(lambda r: el[r.grupo][1] if r.nivel=='regiao' else np.nan, axis=1)
pd.set_option('display.width', 250)
print(t.round(2).to_string(index=False))
t.to_csv(sys.argv[3]+'/percapita_uf_regiao_2017_2021.csv', index=False)
