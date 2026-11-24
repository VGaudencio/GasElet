import sys, pandas as pd, numpy as np, statsmodels.formula.api as smf, warnings
warnings.filterwarnings('ignore')
p = pd.read_csv(sys.argv[1], dtype={'cod':str})
v = p[p.valid & (p.year>=2011)].copy()
v['lg'] = np.log(v.g_atd); v['lpop'] = np.log(v.POP_TOT); v['t'] = v.year-2015
bins = [0,10e3,20e3,50e3,100e3,250e3,1e6,2e7]; labs = ['<10k','10-20k','20-50k','50-100k','100-250k','250k-1M','>1M']
v['faixa'] = pd.cut(v.POP_TOT, bins, labels=labs).astype(str)
tr, te = v[v.year<=2017].copy(), v[v.year>=2018].copy()
coef = {"Norte":(-7753.0,4.0),"Nordeste":(-4588.33,2.44),"Centro-Oeste":(1258.333,-0.444),"Sudeste":(-10093.667,5.222),"Sul":(-3985.333,2.111)}
ratio = lambda g: g.CO119.sum()*1000/g.pop_atd.sum()
P = {}
P['M0 plataforma atual (ABRELPE, reta)'] = te.apply(lambda r: coef[r.regiao][0]+coef[r.regiao][1]*r.year, axis=1)
def agg_trend(level):
    a = tr.groupby([level,'year']).apply(ratio).rename('g').reset_index()
    fits = {k: np.polyfit(g.year, g.g, 1) for k, g in a.groupby(level)}
    return te.apply(lambda r: np.polyval(fits[r[level]], r.year), axis=1)
P['M1 região, reta no tempo (SNIS)'] = agg_trend('regiao')
P['M2 UF, reta no tempo (SNIS)'] = agg_trend('uf')
P['M3 região, constante'] = te.regiao.map(tr.groupby('regiao').apply(ratio))
P['M4 UF, constante'] = te.uf.map(tr.groupby('uf').apply(ratio))
cell = tr.groupby(['uf','faixa']).apply(lambda g: pd.Series({'g': ratio(g), 'n': g.cod.nunique()}))
cg = cell[cell.n>=8].g
P['M5 UF x faixa de porte, constante'] = pd.Series([cg.get((u,f), np.nan) for u,f in zip(te.uf, te.faixa)], index=te.index).fillna(P['M4 UF, constante'])
for name, f in [('M6 UF + log(pop) [log-linear]', 'lg ~ C(uf) + lpop'), ('M7 UF + log(pop) + tempo', 'lg ~ C(uf) + lpop + t')]:
    m = smf.wls(f, tr, weights=tr.POP_TOT).fit()      # weighted -> targets mass
    smear = np.average(np.exp(m.resid), weights=tr.POP_TOT)
    P[name] = np.exp(m.predict(te))*smear
own = tr.groupby('cod').apply(ratio)
P['M8 valor do próprio município (média 2011-17)'] = te.cod.map(own)
rows = []
for k, pred in P.items():
    ok = pred.notna()
    ape = (pred[ok]-te.g_atd[ok]).abs()/te.g_atd[ok]
    w = te.POP_TOT[ok]
    d = te[ok].assign(pm=pred[ok]*te.pop_atd[ok]/1000)
    uf = d.groupby(['uf','year']).apply(lambda g: g.pm.sum()/g.CO119.sum()-1)
    rg = d.groupby(['regiao','year']).apply(lambda g: g.pm.sum()/g.CO119.sum()-1)
    br = d.groupby('year').apply(lambda g: g.pm.sum()/g.CO119.sum()-1)
    rows.append([k, ok.mean()*100, 100*ape.median(), 100*np.average(ape, weights=w), 100*uf.abs().mean(), 100*rg.abs().mean(), 100*br.mean()])
res = pd.DataFrame(rows, columns=['modelo','cobertura_%','munic_MdAPE_%','munic_MAPE_pond_pop_%','massa_UF_erro_abs_%','massa_regiao_erro_abs_%','massa_Brasil_vies_%'])
pd.set_option('display.width', 250)
print('Treino 2011–2017, teste 2018–2021 (', len(te), 'obs município-ano )')
print(res.round(1).to_string(index=False))
res.to_csv(sys.argv[2]+'/validacao_fora_da_amostra.csv', index=False)
# spread of municipal noise
m = smf.ols('lg ~ C(uf) + lpop', v[v.year>=2017]).fit()
print('\nDesvio-padrão do resíduo log (município): %.3f  -> faixa de 80%% ≈ x%.2f a x%.2f' % (m.resid.std(), np.exp(np.quantile(m.resid,.1)), np.exp(np.quantile(m.resid,.9))))
