// Geração per capita de RSU (kg/hab/ano) e massa anual destinada ao aterro.
// Curvas logísticas ajustadas à coleta per capita do SNIS 2003–2021 (Co119/Co164),
// dg/dt = r·g·(1 − g/K), integradas por Runge-Kutta 4 de 2000 a 2065: a da UF do
// município quando os dados do estado são confiáveis; senão, a da região.
// Espelha server/controllers/PerCapita.cpp: qualquer mudança aqui precisa ser
// replicada no backend, que calcula os valores usados nos gráficos.

export const UF_REGIAO = {
  AC: "Norte", AM: "Norte", AP: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
  AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste",
  PE: "Nordeste", PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
  DF: "Centro-Oeste", GO: "Centro-Oeste", MS: "Centro-Oeste", MT: "Centro-Oeste",
  ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste",
  PR: "Sul", RS: "Sul", SC: "Sul",
};

export function regiaoDaUf(uf) {
  return UF_REGIAO[String(uf || "").trim().toUpperCase()] || null;
}

// Curvas logísticas ajustadas ao SNIS (analise_sinis/scripts/ajuste_logistico.py).
// g(T0) = G0; fora de 2000–2065 o valor fica constante no extremo.
export const SNIS_T0 = 2016;
export const SNIS_ANO_MIN = 2000;
export const SNIS_ANO_MAX = 2065;
const SNIS_PASSO = 0.25;

// <gerado:snis-logistica>
// Gerado por analise_sinis/scripts/gerar_codigo.py; não editar à mão.
const SNIS_REGIOES = {
  "Norte": { G0: 373.7393, r: 0.241240, K: 378.0063 },
  "Nordeste": { G0: 401.7360, r: 0.066203, K: 480.8620 },
  "Centro-Oeste": { G0: 371.8836, r: 0.028528, K: 301.1545 },
  "Sudeste": { G0: 334.3888, r: 0.064939, K: 357.8092 },
  "Sul": { G0: 282.9122, r: 0.122282, K: 301.4844 },
};

// UFs com dados confiáveis: curva da região reescalada para o nível da UF.
const SNIS_UFS = {
  AM: { G0: 409.9861, r: 0.241240, K: 414.6670 },
  BA: { G0: 357.0170, r: 0.066203, K: 427.3352 },
  ES: { G0: 303.3497, r: 0.064939, K: 324.5962 },
  GO: { G0: 348.6701, r: 0.028528, K: 282.3560 },
  MG: { G0: 282.0278, r: 0.064939, K: 301.7808 },
  MT: { G0: 350.1953, r: 0.028528, K: 283.5912 },
  PA: { G0: 371.8850, r: 0.241240, K: 376.1309 },
  PB: { G0: 361.8676, r: 0.066203, K: 433.1412 },
  PR: { G0: 288.3263, r: 0.122282, K: 307.2539 },
  RJ: { G0: 426.7107, r: 0.064939, K: 456.5973 },
  RN: { G0: 374.7900, r: 0.066203, K: 448.6087 },
  RS: { G0: 273.1240, r: 0.122282, K: 291.0536 },
  SC: { G0: 282.6566, r: 0.122282, K: 301.2120 },
  SE: { G0: 397.6553, r: 0.066203, K: 475.9775 },
  SP: { G0: 317.3009, r: 0.064939, K: 339.5245 },
};

// Demais UFs usam a curva da região; motivo exibido na tela.
const SNIS_UFS_SEM_CURVA_PROPRIA = {
  AC: "21 município(s) (<30); IC95% ±22% (>15%)",
  AL: "cobertura 58% (<60%)",
  AP: "16 município(s) (<30); IC95% ±39% (>15%)",
  CE: "IC95% ±16% (>15%)",
  DF: "1 município(s) (<30)",
  MA: "cobertura 40% (<60%)",
  MS: "IC95% ±19% (>15%)",
  PE: "IC95% ±17% (>15%)",
  PI: "cobertura 52% (<60%); IC95% ±17% (>15%)",
  RO: "IC95% ±17% (>15%)",
  RR: "12 município(s) (<30); IC95% ±23% (>15%)",
  TO: "IC95% ±15% (>15%)",
};
// </gerado:snis-logistica>

// dg/dt = r·g·(1 − g/K) integrada por RK4 de SNIS_T0 até o ano (para frente ou para trás).
export function logisticaRk4({ G0, r, K }, ano) {
  const t = Math.min(SNIS_ANO_MAX, Math.max(SNIS_ANO_MIN, ano));
  const n = Math.round(Math.abs(t - SNIS_T0) / SNIS_PASSO);
  if (n === 0) return G0;
  const h = (t - SNIS_T0) / n;
  const f = (x) => r * x * (1 - x / K);
  let g = G0;
  for (let i = 0; i < n; i++) {
    const k1 = f(g);
    const k2 = f(g + 0.5 * h * k1);
    const k3 = f(g + 0.5 * h * k2);
    const k4 = f(g + h * k3);
    g += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  }
  return g;
}

// Curva SNIS aplicada a um município: a da UF, se confiável; senão, a da região da UF;
// sem UF, a da região informada.
export function snisCurveFor(uf, regiao) {
  const sigla = String(uf || "").trim().toUpperCase();
  if (SNIS_UFS[sigla]) {
    return { params: SNIS_UFS[sigla], base: "uf", uf: sigla, regiao: UF_REGIAO[sigla] };
  }
  const reg = UF_REGIAO[sigla] || regiao;
  if (!SNIS_REGIOES[reg]) return null;
  return {
    params: SNIS_REGIOES[reg],
    base: "regiao",
    uf: UF_REGIAO[sigla] ? sigla : null,
    regiao: reg,
    motivo: SNIS_UFS_SEM_CURVA_PROPRIA[sigla] || null,
  };
}

const snisCache = new Map();

export function getPerCapKgAnoHab({ uf, regiao, ano, fallbackKgAnoHab = 0 }) {
  const year = Number(ano);
  const curve = snisCurveFor(uf, regiao);
  if (!curve || !Number.isFinite(year)) return Number(fallbackKgAnoHab) || 0;
  const key = `${curve.base === "uf" ? curve.uf : curve.regiao}|${year}`;
  if (!snisCache.has(key)) snisCache.set(key, logisticaRk4(curve.params, year));
  return snisCache.get(key);
}

export function calcRsuTonAno({ uf, regiao, coletaPct, ano, populacao, fallbackKgAnoHab = 0 }) {
  const perCapKgAnoHab = getPerCapKgAnoHab({ uf, regiao, ano, fallbackKgAnoHab });
  const coleta = (Number(coletaPct) || 0) / 100;
  const pop = Number(populacao) || 0;
  return (coleta * perCapKgAnoHab * pop) / 1000;
}
