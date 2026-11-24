"""Escreve os parâmetros das curvas logísticas no cliente e no servidor.

Lê resultados/logistica_parametros.csv (saída de ajuste_logistico.py) e substitui o trecho entre
os marcadores "<gerado:snis-logistica>" e "</gerado:snis-logistica>" em
client/src/utils/rsuProduction.js e server/controllers/PerCapita.cpp.

Uso: python gerar_codigo.py resultados/logistica_parametros.csv <raiz do repositório>
"""
import re
import sys
from pathlib import Path

import pandas as pd

ORDEM_REG = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"]
INI, FIM = "<gerado:snis-logistica>", "</gerado:snis-logistica>"


def fmt(x, nd):
    return f"{x:.{nd}f}"


def bloco_js(df):
    reg = df[df.nivel == "regiao"].set_index("grupo").loc[ORDEM_REG]
    uf = df[df.nivel == "uf"].set_index("grupo").sort_index()
    out = ["// Gerado por analise_sinis/scripts/gerar_codigo.py; não editar à mão.",
           "const SNIS_REGIOES = {"]
    for nome, r in reg.iterrows():
        out.append(f'  "{nome}": {{ G0: {fmt(r.G0, 4)}, r: {fmt(r.r, 6)}, K: {fmt(r.K, 4)} }},')
    out += ["};", "", "// UFs com dados confiáveis: curva da região reescalada para o nível da UF.",
            "const SNIS_UFS = {"]
    for nome, r in uf[uf.confiavel].iterrows():
        out.append(f'  {nome}: {{ G0: {fmt(r.G0, 4)}, r: {fmt(r.r, 6)}, K: {fmt(r.K, 4)} }},')
    out += ["};", "", "// Demais UFs usam a curva da região; motivo exibido na tela.",
            "const SNIS_UFS_SEM_CURVA_PROPRIA = {"]
    for nome, r in uf[~uf.confiavel].iterrows():
        out.append(f'  {nome}: "{r.motivo}",')
    out.append("};")
    return out


def bloco_cpp(df):
    reg = df[df.nivel == "regiao"].set_index("grupo").loc[ORDEM_REG]
    uf = df[df.nivel == "uf"].set_index("grupo").sort_index()
    out = ["    // Gerado por analise_sinis/scripts/gerar_codigo.py; não editar à mão.",
           "    const std::unordered_map<std::string, Logistica> kSnisRegioes = {"]
    for nome, r in reg.iterrows():
        out.append(f'        {{"{nome}", {{{fmt(r.G0, 4)}, {fmt(r.r, 6)}, {fmt(r.K, 4)}}}}},')
    out += ["    };", "",
            "    // UFs com dados confiáveis: curva da região reescalada para o nível da UF.",
            "    // As demais UFs usam a curva da região.",
            "    const std::unordered_map<std::string, Logistica> kSnisUfs = {"]
    for nome, r in uf[uf.confiavel].iterrows():
        out.append(f'        {{"{nome}", {{{fmt(r.G0, 4)}, {fmt(r.r, 6)}, {fmt(r.K, 4)}}}}},')
    out.append("    };")
    return out


def substituir(path, linhas):
    texto = path.read_text(encoding="utf-8")
    padrao = re.compile(rf"(^[ \t]*//[^\n]*{re.escape(INI)}[^\n]*\n).*?(^[ \t]*//[^\n]*{re.escape(FIM)})", re.S | re.M)
    if not padrao.search(texto):
        raise SystemExit(f"marcadores não encontrados em {path}")
    texto = padrao.sub(lambda m: m.group(1) + "\n".join(linhas) + "\n" + m.group(2), texto, count=1)
    path.write_text(texto, encoding="utf-8")
    print("atualizado:", path)


def main(csv, raiz):
    df = pd.read_csv(csv)
    raiz = Path(raiz)
    substituir(raiz / "client/src/utils/rsuProduction.js", bloco_js(df))
    substituir(raiz / "server/controllers/PerCapita.cpp", bloco_cpp(df))


if __name__ == "__main__":
    main(*sys.argv[1:3])
