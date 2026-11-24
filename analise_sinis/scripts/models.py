import sys, pandas as pd, numpy as np, statsmodels.formula.api as smf, warnings
warnings.filterwarnings('ignore')
p = pd.read_csv(sys.argv[1], dtype={'cod':str})
v = p[p.valid & (p.year>=2011)].copy()          # Co164-consistent window
v['lg'] = np.log(v.g_atd); v['lpop'] = np.log(v.POP_TOT); v['t'] = v.year-2015
pd.set_option('display.width', 220)

print('### 1. Tendência dentro do município (efeito fixo de município), 2011–2021, % ao ano')
out = []
for key, grp in [('regiao', v.groupby('regiao')), ('uf', v.groupby('uf'))]:
    for name, g in grp:
        g = g[g.groupby('cod').cod.transform('size') >= 4]
        if g.cod.nunique() < 5: continue
        g = g.copy(); g['lg_d'] = g.lg - g.groupby('cod').lg.transform('mean'); g['t_d'] = g.t - g.groupby('cod').t.transform('mean')
        m = smf.ols('lg_d ~ t_d - 1', g).fit(cov_type='cluster', cov_kwds={'groups': g.cod.astype('category').cat.codes})
        mw = smf.wls('lg_d ~ t_d - 1', g, weights=g.POP_TOT).fit(cov_type='cluster', cov_kwds={'groups': g.cod.astype('category').cat.codes})
        b, se = m.params.iloc[0], m.bse.iloc[0]; bw, sew = mw.params.iloc[0], mw.bse.iloc[0]
        out.append((key, name, g.cod.nunique(), len(g), 100*b, 100*1.96*se, 100*bw, 100*1.96*sew))
fe = pd.DataFrame(out, columns=['nivel','grupo','munic','obs','tend_%a','ic95','tend_pond_pop_%a','ic95_pond'])
print(fe.round(2).to_string(index=False))
fe.to_csv(sys.argv[2]+'/tendencia_efeito_fixo.csv', index=False)

print('\n### 2. Corte transversal 2017–2021: log(g) explicado por região/UF e porte')
cs = v[v.year>=2017]
for f in ['lg ~ C(regiao)', 'lg ~ C(uf)', 'lg ~ C(regiao) + lpop', 'lg ~ C(uf) + lpop', 'lg ~ C(uf) + lpop + I(lpop**2)', 'lg ~ C(uf) + lpop + t']:
    m = smf.ols(f, cs).fit()
    extra = f"  elasticidade porte={m.params['lpop']:.3f} (ep {m.bse['lpop']:.3f})" if 'lpop' in m.params else ''
    extra += f"  tend={100*m.params['t']:.2f}%/a (ep {100*m.bse['t']:.2f})" if 't' in m.params else ''
    print(f"{f:35s} R2={m.rsquared:.3f}  R2aj={m.rsquared_adj:.3f}  n={int(m.nobs)}{extra}")

print('\n### 3. Por faixa de população (2017–2021), coleta per capita kg/hab/ano')
bins = [0,10e3,20e3,50e3,100e3,250e3,1e6,5e6,2e7]; labs = ['<10k','10-20k','20-50k','50-100k','100-250k','250k-1M','1-5M','>5M']
cs = cs.assign(faixa=pd.cut(cs.POP_TOT, bins, labels=labs))
t = cs.groupby(['regiao','faixa'], observed=True).apply(lambda g: g.CO119.sum()*1000/g.pop_atd.sum()).unstack().round(0)
t['mediana_geral'] = cs.groupby('regiao').g_atd.median().round(0)
print(t.to_string())
