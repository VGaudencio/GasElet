import sys, pandas as pd, numpy as np
df = pd.read_csv(sys.argv[1], dtype=str)
grp = df.file.str.replace(r'^\d+_', '', regex=True)
yr = grp.str.extract(r'(\d{4})')[0].astype(float)
rsd = grp.str.extract(r'^RSD0(\d)')[0].astype(float)
yr = yr.where(rsd.isna(), 2001 + rsd)   # RSD03->2004 ... RSD06->2007 (confirmed by 'Ano' column)
df['year'] = yr.astype(int)
num = [c for c in df.columns if c not in ('file','sheet','cod','ano','uf','year')]
for c in num:
    df[c] = pd.to_numeric(df[c].str.replace(',', '.', regex=False), errors='coerce')
# consistency check on duplicates of Co119 across sheets
dup = df.dropna(subset=['CO119']).groupby(['year','cod'])['CO119'].agg(['min','max','count'])
bad = dup[(dup['count']>1) & ((dup['max']-dup['min']).abs() > 1e-6*dup['max'].abs()+1e-9)]
print('Co119 conflicting duplicates:', len(bad), 'of', len(dup))
p = df.groupby(['year','cod'])[num].first().reset_index()
p['POP_TOT'] = p['POP_TOT'].fillna(p['GE001']); p['POP_URB'] = p['POP_URB'].fillna(p['GE002'])
atd = p['CO164'].copy()
alt = p['CO050'] + p['CO147'].fillna(0)
p['pop_atd'] = atd.fillna(alt)
p['atd_src'] = np.where(atd.notna(), 'Co164', np.where(p['CO147'].notna(), 'Co050+Co147', 'Co050'))
ufmap = {11:'RO',12:'AC',13:'AM',14:'RR',15:'PA',16:'AP',17:'TO',21:'MA',22:'PI',23:'CE',24:'RN',25:'PB',26:'PE',27:'AL',28:'SE',29:'BA',31:'MG',32:'ES',33:'RJ',35:'SP',41:'PR',42:'SC',43:'RS',50:'MS',51:'MT',52:'GO',53:'DF'}
reg = {1:'Norte',2:'Nordeste',3:'Sudeste',4:'Sul',5:'Centro-Oeste'}
p['uf'] = p.cod.str[:2].astype(int).map(ufmap); p['regiao'] = p.cod.str[0].astype(int).map(reg)
p['g_atd'] = p['CO119']*1000/p['pop_atd']          # kg/hab/ano (IN028-like)
p['g_urb'] = p['CO119']*1000/p['POP_URB']          # kg/hab/ano (IN021-like)
p['g_tot'] = p['CO119']*1000/p['POP_TOT']
p['cobert'] = p['pop_atd']/p['POP_TOT']
# validity: positive mass & pop, per capita in [0.2, 3.0] kg/hab/dia (73–1095 kg/hab/ano), coverage <= 1.05
ok = (p.CO119>0) & (p.pop_atd>0) & (p.POP_TOT>0) & p.g_atd.between(73, 1095) & (p.cobert<=1.05)
p['valid'] = ok
print(p.groupby('year').agg(munic=('cod','size'), com_Co119=('CO119', lambda s: (s>0).sum()), validos=('valid','sum'),
      pop_validos_mi=('POP_TOT', lambda s: s[p.loc[s.index,'valid']].sum()/1e6), fonte_atd=('atd_src', lambda s: s.mode()[0])).to_string())
p.to_csv(sys.argv[2], index=False)
