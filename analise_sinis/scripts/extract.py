import sys, re, os, glob, pandas as pd, warnings
warnings.filterwarnings('ignore')
D = sys.argv[1]; OUT = sys.argv[2]
KEYS = {'POP_TOT','POP_URB','GE001','GE002','CO119','CO164','CO050','CO147','CO051','CO165',
        'IN021','IN028','IN022','IN016','IN015','I021','I022','I028','I016','I015'}
codepat = re.compile(r'^(?:[A-Za-z]{1,2}\d{3}|POP_[A-Z]+)$')
files = sorted(glob.glob(os.path.join(D, '*.xls*')) + glob.glob(os.path.join(D, '*', '*.xls*')))
skip = re.compile(r'(?i)Catadores|Delegac|Importadores|Politicas|Unidades|_Up0|_Os0|_Cs0|_Cc0|_Va0|_Cp0|_Ca0|_Rs0|TabUp|TabOs|TabCs|TabRs|TabVa|_Cp01|_Ca01')
rows = []
for f in files:
    name = os.path.basename(f)
    if skip.search(name): continue
    try: xl = pd.ExcelFile(f)
    except Exception as e: print('ERR', name, e, file=sys.stderr); continue
    for sh in xl.sheet_names:
        if re.search(r'(?i)Up0|Os0|Cs0|Cc0|Va0|Cp0|Ca0|Rs0|Cons', sh): continue
        try: df = xl.parse(sh, header=None)
        except Exception as e: print('ERR', name, sh, e, file=sys.stderr); continue
        if df.empty: continue
        hdr = None
        for i in range(min(40, len(df))):
            vals = [str(v).strip() for v in df.iloc[i].tolist()]
            if sum(bool(codepat.match(v)) for v in vals) >= 3:
                hdr = i; break
        if hdr is None: continue
        cols = {}
        for j, v in enumerate(df.iloc[hdr].tolist()):
            v = str(v).strip().upper()
            if v in KEYS: cols[v] = j
        if not cols: continue
        # locate município code col, name/uf col, year col
        head = df.iloc[:hdr+1].astype(str)
        def find(pat):
            for j in range(df.shape[1]):
                if any(re.search(pat, str(x), re.I) for x in head.iloc[:, j].tolist()): return j
            return None
        jcod = 0
        jano = find(r'^Ano( de refer)?')
        juf = find(r'^UF$'); jnome = find(r'Nome/UF|^Munic[ií]pio$')
        data = df.iloc[hdr+1:]
        for _, r in data.iterrows():
            cod = str(r.iloc[jcod]).strip().split('.')[0]
            if not re.fullmatch(r'\d{6,7}', cod): continue
            rec = {'file': name, 'sheet': sh, 'cod': cod[:6]}
            if jano is not None: rec['ano'] = r.iloc[jano]
            if juf is not None: rec['uf'] = r.iloc[juf]
            elif jnome is not None and '/' in str(r.iloc[jnome]): rec['uf'] = str(r.iloc[jnome]).rsplit('/', 1)[1].strip()
            for k, j in cols.items(): rec[k] = r.iloc[j]
            rows.append(rec)
    print('ok', name, len(rows), file=sys.stderr)
pd.DataFrame(rows).to_csv(OUT, index=False)
