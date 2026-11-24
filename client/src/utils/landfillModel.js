// Modelo do aterro (IPCC 2006). Espelha server/controllers/UserDashboard.cpp:
// qualquer mudança aqui precisa ser replicada no backend, que é a fonte dos
// valores de metano usados nos gráficos.

import { DEFAULT_PER_CAPITA_METHOD, resolvePerCapitaMethod } from "./rsuProduction.js";

export const DEFAULT_ANO_INICIAL = 2000;
export const DEFAULT_ANO_FINAL = 2060;

export const DEFAULT_COMPOSICAO = {
  papel: 17.1,
  organica: 44.9,
  plastico: 10.8,
  texteis: 2.6,
  madeira: 4.7,
  metal: 2.9,
  vidro: 3.3,
  borracha: 0.7,
  outros: 13.0,
};

// Discretização anual do decaimento de primeira ordem (FOD). Espelha FodMethod
// em server/controllers/UserDashboard.cpp.
export const FOD_METHODS = [
  {
    value: "ipcc2000",
    label: "IPCC 2000 — normalizado",
    descricao:
      "GPG 2000, Eq. 5.1: Σ M·L0·(1−e^−k)·e^−k(t−x). Cada lote gera exatamente L0·M ao longo do tempo.",
  },
  {
    value: "ipcc2006",
    label: "IPCC 2006 — atraso de 6 meses",
    descricao:
      "Como a planilha IPCC_Waste_Model: a decomposição começa no ano seguinte ao da deposição.",
  },
  {
    value: "legado",
    label: "Legado (até out/2026)",
    descricao:
      "k·M·L0·e^−k(t−x) e DOC 0,01 para inertes. Superestima o total em k/(1−e^−k); use só para reproduzir resultados antigos.",
  },
];

export const DEFAULT_FOD_METHOD = "ipcc2000";

export function resolveFodMethod(value) {
  return FOD_METHODS.some((m) => m.value === value) ? value : DEFAULT_FOD_METHOD;
}

// DOC de metal, vidro e "outros": inertes no IPCC 2006 (Tab. 2.4); 0,01 só no legado.
function docInertes(metodoFod) {
  return resolveFodMethod(metodoFod) === "legado" ? 0.01 : 0;
}

export const DEFAULT_LANDFILL_CONFIG = {
  regiao: "Nordeste",
  metodoPerCapita: DEFAULT_PER_CAPITA_METHOD,
  geracaoKgAnoHab: 328.3,
  taxaColetaPct: 100,
  kMetano: 0.05,
  gerenciamento: "Gerenciado",
  metodoFod: DEFAULT_FOD_METHOD,
  captacaoBiogasPct: 100,
  vidaInicio: DEFAULT_ANO_INICIAL,
  vidaFim: DEFAULT_ANO_FINAL,
  composicao: DEFAULT_COMPOSICAO,
};

// IPCC 2006, Vol. 5, Tabela 3.1.
export const MCF_OPTIONS = [
  { value: "Gerenciado", mcf: 1.0 },
  { value: "Não gerenciado - profundo (>=5 m)", mcf: 0.8 },
  { value: "Não gerenciado - raso (<5 m)", mcf: 0.4 },
  { value: "Não categorizado", mcf: 0.6, label: "Não categorizado (aterro controlado/lixão)" },
];

// Rótulos de versões anteriores, ainda presentes em cenários salvos.
const LEGACY_MCF = {
  Parcial: 0.8,
  "Não gerenciado": 0.4,
  "Nao gerenciado": 0.4,
};

// k padrão para resíduo misto (bulk waste), IPCC 2006 Vol. 5 Tab. 3.3 (mantida no
// Refinamento 2019). Zona definida pela temperatura média anual do ar (MAT) e
// precipitação (MAP); o Inventário Nacional (4ª Comunicação) classifica cada município
// assim e não há clima temperado seco no Brasil.
export const CLIMATE_ZONES = [
  { value: "Tropical úmido", k: 0.17, criterio: "MAT > 20 °C e MAP ≥ 1000 mm" },
  { value: "Tropical seco", k: 0.065, criterio: "MAT > 20 °C e MAP < 1000 mm" },
  { value: "Temperado úmido", k: 0.09, criterio: "MAT ≤ 20 °C e MAP/PET > 1" },
  { value: "Temperado seco", k: 0.05, criterio: "MAT ≤ 20 °C e MAP/PET < 1", brasil: false },
];

export function climateZoneForK(k) {
  return CLIMATE_ZONES.find((z) => Math.abs(z.k - Number(k)) < 1e-9)?.value || "";
}

export function resolveMcf(gerenciamento) {
  const found = MCF_OPTIONS.find((o) => o.value === gerenciamento);
  if (found) return found.mcf;
  return LEGACY_MCF[gerenciamento] ?? 1.0;
}

export function computeDoc(c, metodoFod = DEFAULT_FOD_METHOD) {
  return (
    (c.papel / 100) * 0.4 +
    (c.organica / 100) * 0.15 +
    (c.plastico / 100) * 0.0 +
    (c.texteis / 100) * 0.24 +
    (c.madeira / 100) * 0.43 +
    (c.borracha / 100) * 0.39 +
    (c.metal / 100 + c.vidro / 100 + c.outros / 100) * docInertes(metodoFod)
  );
}

// Lo em t CH4 / t RSU: MCF · DOC · DOCf(0,5) · F(0,5) · 16/12
export function computeLoTonPerTon(composicao, gerenciamento, metodoFod = DEFAULT_FOD_METHOD) {
  return resolveMcf(gerenciamento) * computeDoc(composicao, metodoFod) * 0.5 * 0.5 * (16 / 12);
}

function toNumber(v, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : fallback;
}

// Config enviada ao cálculo do backend; mantém todos os campos que afetam o resultado.
export function normalizeLandfillConfig(config) {
  const d = DEFAULT_LANDFILL_CONFIG;
  const merged = {
    ...d,
    ...(config || {}),
    composicao: { ...d.composicao, ...(config?.composicao || {}) },
  };

  const out = {
    regiao: String(merged.regiao || d.regiao),
    metodoPerCapita: resolvePerCapitaMethod(merged.metodoPerCapita),
    geracaoKgAnoHab: toNumber(merged.geracaoKgAnoHab, d.geracaoKgAnoHab),
    taxaColetaPct: toNumber(merged.taxaColetaPct, d.taxaColetaPct),
    kMetano: toNumber(merged.kMetano, d.kMetano),
    gerenciamento: String(merged.gerenciamento || d.gerenciamento),
    metodoFod: resolveFodMethod(merged.metodoFod),
    captacaoBiogasPct: toNumber(merged.captacaoBiogasPct, d.captacaoBiogasPct),
    vidaInicio: Math.round(toNumber(merged.vidaInicio, d.vidaInicio)),
    vidaFim: Math.round(toNumber(merged.vidaFim, d.vidaFim)),
    composicao: Object.fromEntries(
      Object.keys(d.composicao).map((k) => [k, toNumber(merged.composicao[k], d.composicao[k])])
    ),
  };

  if (merged.popBase != null) out.popBase = toNumber(merged.popBase, 0);
  if (merged.popCrescimentoAnualPct != null) {
    out.popCrescimentoAnualPct = toNumber(merged.popCrescimentoAnualPct, 0);
  }
  return out;
}
