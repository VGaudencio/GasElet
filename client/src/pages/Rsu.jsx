import React, { useEffect, useMemo, useRef, useState } from "react";
import "../styles/Rsu.css";
import { ResponsiveLine } from "@nivo/line";
import { useDashboard } from "../context/DashboardContext.jsx";
import { calcRsuTonAno, getPerCapKgAnoHab, snisCurveFor } from "../utils/rsuProduction.js";
import { fmtAxis, fmtNumber, yearTicks } from "../utils/chartFormat.js";
import {
  DEFAULT_ANO_FINAL,
  DEFAULT_ANO_INICIAL,
  DEFAULT_COMPOSICAO,
  CLIMATE_ZONES,
  DEFAULT_FOD_METHOD,
  FOD_METHODS,
  MCF_OPTIONS,
  climateZoneForK,
  computeLoTonPerTon,
  resolveFodMethod,
} from "../utils/landfillModel.js";

const API_BASE =
  (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "") ||
  (import.meta.env.DEV ? "/backend" : "");
const DASHBOARD_API = `${API_BASE}/api/user/dashboard`;

function clampNum(v, min, max) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function parsePct(v) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function rangeYears(from, to) {
  const out = [];
  for (let y = from; y <= to; y++) out.push(y);
  return out;
}

function makeDefaultDraft() {
  return {
    // Captação RSU
    taxaColetaPct: null,
    regiao: "Nordeste",
    geracaoKgAnoHab: null,
    vidaInicio: DEFAULT_ANO_INICIAL,
    vidaFim: DEFAULT_ANO_FINAL,

    // Produção
    captacaoBiogasPct: 100,
    gerenciamento: "Gerenciado",
    kMetano: 0.05,
    metodoFod: DEFAULT_FOD_METHOD,

    // Composição
    composicao: { ...DEFAULT_COMPOSICAO },

    // Série
    popBase: 499990,
    popCrescimentoAnualPct: 0.95,
  };
}

function normalizeConfig(config) {
  const base = makeDefaultDraft();
  if (!config || typeof config !== "object") return base;
  // metodoPerCapita: campo de versões com a opção ABRELPE 2020, que foi removida.
  // eslint-disable-next-line no-unused-vars
  const { metodoPerCapita, ...rest } = config;
  return {
    ...base,
    ...rest,
    composicao: {
      ...base.composicao,
      ...(config.composicao || {}),
    },
  };
}

function isDefaultConfig(config) {
  if (!config || typeof config !== "object") return true;
  const base = makeDefaultDraft();
  return (
    String(config.regiao) === base.regiao &&
    Number(config.geracaoKgAnoHab) === base.geracaoKgAnoHab &&
    Number(config.taxaColetaPct) === base.taxaColetaPct &&
    Number(config.vidaInicio) === base.vidaInicio &&
    Number(config.vidaFim) === base.vidaFim &&
    Number(config.captacaoBiogasPct) === base.captacaoBiogasPct &&
    Number(config.kMetano) === base.kMetano &&
    resolveFodMethod(config.metodoFod) === base.metodoFod &&
    String(config.gerenciamento) === base.gerenciamento &&
    Number(config.popBase) === base.popBase &&
    Number(config.popCrescimentoAnualPct) === base.popCrescimentoAnualPct
  );
}

function fmtInt(n) {
  try {
    return new Intl.NumberFormat("pt-BR").format(Math.round(n));
  } catch {
    return String(Math.round(n));
  }
}

function fmt1(n) {
  try {
    return new Intl.NumberFormat("pt-BR", {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    }).format(n);
  } catch {
    return String(n);
  }
}

function fmt4(n) {
  try {
    return new Intl.NumberFormat("pt-BR", {
      maximumFractionDigits: 4,
      minimumFractionDigits: 4,
    }).format(n);
  } catch {
    return String(n);
  }
}

export default function Rsu() {
  const [loaded, setLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const {
    loadingUser,
    scenarios,
    currentScenarioId,
    rsuByScenario,
    setRsuByScenario,
  } = useDashboard();

  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 640);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const YEARS = useMemo(() => rangeYears(DEFAULT_ANO_INICIAL, DEFAULT_ANO_FINAL), []);
  const REGIOES = useMemo(
    () => [
      { id: "Norte", kgAnoHab: 320 },
      { id: "Nordeste", kgAnoHab: 328.3 },
      { id: "Centro-Oeste", kgAnoHab: 360 },
      { id: "Sudeste", kgAnoHab: 380 },
      { id: "Sul", kgAnoHab: 370 },
    ],
    []
  );

  const [draft, setDraft] = useState(() => makeDefaultDraft());
  const [model, setModel] = useState(() => makeDefaultDraft());
  const hydratedScenariosRef = useRef(new Set());
  const readyToPersistRef = useRef(new Set());
  const refreshAttemptedRef = useRef(new Set());
  const prevRegiaoRef = useRef(makeDefaultDraft().regiao);

  const scenarioRows = useMemo(() => {
    const scenario = scenarios.find(
      (s) => String(s.id) === String(currentScenarioId)
    );
    return scenario?.rows?.length ? scenario.rows : [];
  }, [scenarios, currentScenarioId]);

  const scenarioTotals = useMemo(() => {
    if (!scenarioRows.length) return null;
    const totals = {};
    for (const row of scenarioRows) {
      const series = row.series || {};
      for (const [yearKey, value] of Object.entries(series)) {
        const year = Number(yearKey);
        if (!Number.isFinite(year)) continue;
        const pop = Number(value) || 0;
        totals[year] = (totals[year] || 0) + pop;
      }
    }
    return Object.keys(totals).length ? totals : null;
  }, [scenarioRows]);

  useEffect(() => {
    if (!currentScenarioId) return;
    if (loadingUser) return;
    const hydrated = hydratedScenariosRef.current;

    const entry = rsuByScenario?.[currentScenarioId];
    if (entry?.config) {
      if (hydrated.has(currentScenarioId) && !isDefaultConfig(draft)) {
        return;
      }
      const normalized = normalizeConfig(entry.config);
      setDraft(normalized);
      setModel(normalized);
      hydrated.add(currentScenarioId);
      readyToPersistRef.current.add(currentScenarioId);
      return;
    }

    const nextDefault = makeDefaultDraft();
    setDraft(nextDefault);
    setModel(nextDefault);
    hydrated.add(currentScenarioId);
    readyToPersistRef.current.add(currentScenarioId);
  }, [currentScenarioId, rsuByScenario, loadingUser]);

  useEffect(() => {
    if (loadingUser) return;
    if (!currentScenarioId) return;
    const entry = rsuByScenario?.[currentScenarioId];
    if (entry?.config && !isDefaultConfig(entry.config)) return;

    const attempted = refreshAttemptedRef.current;
    if (attempted.has(currentScenarioId)) return;
    attempted.add(currentScenarioId);

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(DASHBOARD_API, {
          method: "GET",
          credentials: "include",
        });
        if (!resp.ok) return;
        const json = await resp.json();
        if (cancelled) return;

        const serverRsuByScenario =
          json && typeof json.rsuByScenario === "object" && json.rsuByScenario
            ? json.rsuByScenario
            : {};
        if (!Object.keys(serverRsuByScenario).length) return;

        setRsuByScenario(serverRsuByScenario);

        const serverEntry = serverRsuByScenario[currentScenarioId];
        if (serverEntry?.config) {
          const normalized = normalizeConfig(serverEntry.config);
          setDraft(normalized);
          setModel(normalized);
          hydratedScenariosRef.current.add(currentScenarioId);
          readyToPersistRef.current.add(currentScenarioId);
        }
      } catch {
        // best-effort refresh
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadingUser, currentScenarioId, rsuByScenario, setRsuByScenario]);

  useEffect(() => {
    if (!scenarioTotals) return;
    const defaults = makeDefaultDraft();
    const vidaInicio = Number(draft.vidaInicio);
    const vidaFim = Number(draft.vidaFim);
    const popInicio = scenarioTotals[vidaInicio];
    const popFim = scenarioTotals[vidaFim];
    if (!Number.isFinite(popInicio) || !Number.isFinite(popFim) || popInicio <= 0) return;

    const years = Math.max(1, vidaFim - vidaInicio);
    const growth = Math.pow(popFim / popInicio, 1 / years) - 1;
    const popBase = Math.round(popInicio);
    const popCrescimentoAnualPct = round1(growth * 100);

    const canAutoSync =
      draft.popBase === defaults.popBase &&
      round1(draft.popCrescimentoAnualPct) === round1(defaults.popCrescimentoAnualPct);

    if (!canAutoSync) return;

    setDraft((prev) => {
      if (
        prev.popBase === popBase &&
        round1(prev.popCrescimentoAnualPct) === popCrescimentoAnualPct
      ) {
        return prev;
      }
      return { ...prev, popBase, popCrescimentoAnualPct };
    });

    setModel((prev) => {
      if (
        prev.popBase === popBase &&
        round1(prev.popCrescimentoAnualPct) === popCrescimentoAnualPct
      ) {
        return prev;
      }
      return { ...prev, popBase, popCrescimentoAnualPct };
    });
  }, [scenarioTotals, draft.vidaInicio, draft.vidaFim, draft.popBase, draft.popCrescimentoAnualPct]);

  // Auto-sugestão do Kg/Ano/Hab ao mudar região (mantém editável pelo input)
  useEffect(() => {
    const found = REGIOES.find((r) => r.id === draft.regiao);
    if (!found) return;
    const prevRegiao = prevRegiaoRef.current;
    const prevFound = REGIOES.find((r) => r.id === prevRegiao);
    const prevDefault = prevFound?.kgAnoHab;
    const shouldUpdate =
      typeof prevDefault === "number" &&
      Number(draft.geracaoKgAnoHab) === Number(prevDefault);

    prevRegiaoRef.current = draft.regiao;
    if (!shouldUpdate) return;
    setDraft((d) => ({ ...d, geracaoKgAnoHab: found.kgAnoHab }));
  }, [draft.regiao, draft.geracaoKgAnoHab, REGIOES]);

  // Composição como números (robusto contra string/vazio/virgula)
  const compNums = useMemo(() => {
    const c = draft.composicao;
    return {
      papel: parsePct(c.papel),
      plastico: parsePct(c.plastico),
      madeira: parsePct(c.madeira),
      vidro: parsePct(c.vidro),
      outros: parsePct(c.outros),
      organica: parsePct(c.organica),
      texteis: parsePct(c.texteis),
      metal: parsePct(c.metal),
      borracha: parsePct(c.borracha),
    };
  }, [draft.composicao]);

  const somaComposicao = useMemo(() => {
    const sum = Object.values(compNums).reduce((acc, x) => acc + x, 0);
    return round1(sum);
  }, [compNums]);

  const deltaComposicao = useMemo(() => round1(100 - somaComposicao), [somaComposicao]);
  const compOk = useMemo(() => Math.abs(deltaComposicao) <= 0.2, [deltaComposicao]);

  const loCalculado = useMemo(
    () => computeLoTonPerTon(compNums, String(draft.gerenciamento || ""), draft.metodoFod),
    [draft.gerenciamento, draft.metodoFod, compNums]
  );

  const normalizarComposicao = () => {
    const keys = Object.keys(compNums);
    const sum = Object.values(compNums).reduce((a, b) => a + b, 0);
    if (sum <= 0) return;

    const factor = 100 / sum;
    const normalized = {};
    for (const k of keys) normalized[k] = round1(compNums[k] * factor);

    // Ajuste fino para fechar 100% após arredondamento
    const sum2 = Object.values(normalized).reduce((a, b) => a + b, 0);
    const diff = round1(100 - sum2);
    if (diff !== 0) {
      let maxK = keys[0];
      for (const k of keys) if (normalized[k] > normalized[maxK]) maxK = k;
      normalized[maxK] = round1(normalized[maxK] + diff);
    }

    setDraft((d) => ({ ...d, composicao: { ...d.composicao, ...normalized } }));
  };

  const onAtualizar = () => {
    const vidaInicio = clampNum(draft.vidaInicio, 1900, 2100);
    const vidaFim = clampNum(draft.vidaFim, vidaInicio, 2100);

    const sanitized = {
      ...draft,
      taxaColetaPct: clampNum(draft.taxaColetaPct, 0, 100),
      geracaoKgAnoHab: clampNum(draft.geracaoKgAnoHab, 0, 2000),
      vidaInicio,
      vidaFim,
      captacaoBiogasPct: clampNum(draft.captacaoBiogasPct, 0, 100),
      kMetano: clampNum(draft.kMetano, 0, 10),
      popBase: clampNum(draft.popBase, 0, 1e9),
      popCrescimentoAnualPct: clampNum(draft.popCrescimentoAnualPct, -10, 20),
      composicao: Object.fromEntries(
        Object.entries(draft.composicao).map(([k, v]) => [k, clampNum(parsePct(v), 0, 100)])
      ),
    };

    setModel(sanitized);
  };

  // Cada município usa a per capita da sua UF (ou região); sem municípios no cenário,
  // a população vem de popBase e crescimento, com a região selecionada.
  // Espelha computeRsuSeries em server/controllers/UserDashboard.cpp.
  const series = useMemo(() => {
    const years = rangeYears(model.vidaInicio, model.vidaFim);
    const growth = model.popCrescimentoAnualPct / 100;
    const base = {
      regiao: model.regiao,
      coletaPct: model.taxaColetaPct,
      fallbackKgAnoHab: model.geracaoKgAnoHab,
    };

    const rows = years.map((ano, i) => {
      const yearKey = String(ano);
      let found = false;
      let pop = 0;
      let rsuTAno = 0;
      let perCapPop = 0;
      for (const row of scenarioRows) {
        const rowSeries = row.series || {};
        if (!Object.prototype.hasOwnProperty.call(rowSeries, yearKey)) continue;
        const popRow = Number(rowSeries[yearKey]) || 0;
        const g = getPerCapKgAnoHab({ ...base, uf: row.uf, ano });
        found = true;
        pop += popRow;
        perCapPop += g * popRow;
        rsuTAno += calcRsuTonAno({ ...base, uf: row.uf, ano, populacao: popRow });
      }

      if (!found) {
        pop = model.popBase * Math.pow(1 + growth, i);
        rsuTAno = calcRsuTonAno({ ...base, uf: null, ano, populacao: pop });
      }
      const perCapita =
        found && pop > 0 ? perCapPop / pop : getPerCapKgAnoHab({ ...base, uf: null, ano });
      return { ano, pop, rsuTAno, perCapita };
    });

    const nivo = [
      {
        id: "Resíduo coletado (t/ano)",
        data: rows.map((r) => ({ x: String(r.ano), y: Number(r.rsuTAno.toFixed(1)) })),
      },
    ];

    const ticks = yearTicks(years.map(Number)).map(String);

    return { rows, nivo, ticks };
  }, [model, scenarioRows]);

  // Curva per capita aplicada a cada UF do cenário.
  const perCapitaBases = useMemo(() => {
    const ufs = [...new Set(scenarioRows.map((r) => String(r.uf || "").toUpperCase()).filter(Boolean))].sort();
    return ufs.map((uf) => {
      const curve = snisCurveFor(uf, draft.regiao);
      if (!curve) return { uf, texto: "sem curva (usa o valor padrão)" };
      if (curve.base === "uf") return { uf, texto: "curva do estado" };
      return {
        uf,
        texto: `curva da região ${curve.regiao}${curve.motivo ? ` (${curve.motivo})` : ""}`,
      };
    });
  }, [draft.regiao, scenarioRows]);

  useEffect(() => {
    if (!currentScenarioId) return;
    if (!readyToPersistRef.current.has(currentScenarioId)) return;
    setRsuByScenario((prev) => {
      const safePrev = prev || {};
      const prevEntry = safePrev[currentScenarioId];
      const nextEntry = {
        config: model,
        series: series.rows,
      };

      if (
        prevEntry &&
        JSON.stringify(prevEntry.config) === JSON.stringify(nextEntry.config) &&
        JSON.stringify(prevEntry.series) === JSON.stringify(nextEntry.series)
      ) {
        return safePrev;
      }

      return {
        ...safePrev,
        [currentScenarioId]: nextEntry,
      };
    });
  }, [currentScenarioId, model, series.rows, setRsuByScenario]);

  if (loadingUser) {
    return (
      <div className={`home-container ${loaded ? "fade-in" : ""}`}>
        <p>Carregando dados do usuário…</p>
      </div>
    );
  }

  return (
    <div className={`home-container ${loaded ? "fade-in" : ""}`}>
     <header className="home-header">
        <div>
          <h1>Resíduos sólidos urbanos</h1>
          <p>Parâmetros de coleta, do aterro e da composição do resíduo. As mudanças valem depois de clicar em Recalcular.</p>
        </div>
      </header>

      <main className="home-grid rsu-grid">
        {/* Card combinado: Captação + Produção */}
        <section className="card glow rsu-config-card">
          <div className="rsu-config-grid">
            <div className="rsu-config-col">
              <h3 className="rsu-section-title">Coleta</h3>
              <div className="rsu-form">
                <div className="field">
                  <label>Taxa de coleta (%)</label>
                  <input
                    type="number"
                    value={draft.taxaColetaPct}
                    onChange={(e) => setDraft((d) => ({ ...d, taxaColetaPct: e.target.value }))}
                  />
                </div>

                <div className="field">
                  <label>Geração per capita</label>
                  <div className="field-static" title="Coleta per capita do SNIS 2003–2021, curva logística integrada por Runge-Kutta 4">
                    Curva do SNIS por UF
                  </div>
                  {perCapitaBases.length > 0 && (
                    <small className="field-hint">
                      {perCapitaBases.map((b) => `${b.uf}: ${b.texto}`).join("; ")}
                    </small>
                  )}
                </div>

                <div className="field">
                  <label>Região (cenário sem municípios)</label>
                  <select value={draft.regiao} onChange={(e) => setDraft((d) => ({ ...d, regiao: e.target.value }))}>
                    {REGIOES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>Operação do aterro (início e fim)</label>
                  <div className="field-inline">
                    <select
                      value={draft.vidaInicio}
                      onChange={(e) => setDraft((d) => ({ ...d, vidaInicio: +e.target.value }))}
                    >
                      {YEARS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>

                    <select value={draft.vidaFim} onChange={(e) => setDraft((d) => ({ ...d, vidaFim: +e.target.value }))}>
                      {YEARS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="rsu-config-col">
              <h3 className="rsu-section-title">Aterro e biogás</h3>
              <div className="rsu-form two-cols">
                <div className="field">
                  <label>Captação de biogás (%)</label>
                  <input
                    type="number"
                    value={draft.captacaoBiogasPct}
                    onChange={(e) => setDraft((d) => ({ ...d, captacaoBiogasPct: e.target.value }))}
                  />
                </div>

                <div className="field">
                  <label>Zona climática (IPCC)</label>
                  <select
                    value={climateZoneForK(draft.kMetano)}
                    title="Define o k padrão do IPCC 2006 (Tab. 3.3) para resíduo misto"
                    onChange={(e) => {
                      const zone = CLIMATE_ZONES.find((z) => z.value === e.target.value);
                      if (zone) setDraft((d) => ({ ...d, kMetano: zone.k }));
                    }}
                  >
                    <option value="">Personalizado (k informado)</option>
                    {CLIMATE_ZONES.map((z) => (
                      <option key={z.value} value={z.value} title={z.criterio}>
                        {z.value} — k {String(z.k).replace(".", ",")}
                        {z.brasil === false ? " (não ocorre no Brasil)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>Constante de decaimento k (1/ano)</label>
                  <input
                    type="number"
                    step="0.001"
                    value={draft.kMetano}
                    onChange={(e) => setDraft((d) => ({ ...d, kMetano: e.target.value }))}
                  />
                </div>

                <div className="field">
                  <label>Tipo de aterro (MCF)</label>
                  <select
                    value={draft.gerenciamento}
                    onChange={(e) => setDraft((d) => ({ ...d, gerenciamento: e.target.value }))}
                  >
                    {!MCF_OPTIONS.some((o) => o.value === draft.gerenciamento) && (
                      <option value={draft.gerenciamento}>{draft.gerenciamento} (antigo)</option>
                    )}
                    {MCF_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label || o.value} — MCF {o.mcf.toFixed(1).replace(".", ",")}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>Discretização do decaimento (FOD)</label>
                  <select
                    value={resolveFodMethod(draft.metodoFod)}
                    title={FOD_METHODS.find((m) => m.value === resolveFodMethod(draft.metodoFod))?.descricao}
                    onChange={(e) => setDraft((d) => ({ ...d, metodoFod: e.target.value }))}
                  >
                    {FOD_METHODS.map((m) => (
                      <option key={m.value} value={m.value} title={m.descricao}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label>População base (hab.)</label>
                  <input type="number" value={draft.popBase} onChange={(e) => setDraft((d) => ({ ...d, popBase: e.target.value }))} />
                </div>

                <div className="field">
                  <label>Crescimento anual da população (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={draft.popCrescimentoAnualPct}
                    onChange={(e) => setDraft((d) => ({ ...d, popCrescimentoAnualPct: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Tabela (direita, 2 linhas) */}
        <section className="card glow rsu-tableCard">
          <h3 className="rsu-section-title">Resíduo coletado por ano</h3>

          <div className="table-wrap" role="region" aria-label="Tabela de produção de RSU">
            <table className="rsu-table">
              <thead>
                <tr>
                  <th>Ano</th>
                  <th>Per capita (kg/hab/ano)</th>
                  <th>RSU (t/ano)</th>
                  <th>População</th>
                </tr>
              </thead>
              <tbody>
                {series.rows.map((r) => (
                  <tr key={r.ano}>
                    <td>{r.ano}</td>
                    <td>{fmt1(r.perCapita)}</td>
                    <td>{fmt1(r.rsuTAno)}</td>
                    <td>{fmtInt(r.pop)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Composição */}
        <section className="card glow rsu-comp">
          <h3 className="rsu-section-title">Composição do resíduo (%)</h3>

          <div className="rsu-comp-grid">
            <div className="field">
              <label>Papel e papelão</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.papel}
                onChange={(e) => setDraft((d) => ({ ...d, composicao: { ...d.composicao, papel: e.target.value } }))}
              />
            </div>

            <div className="field">
              <label>Plástico</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.plastico}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, composicao: { ...d.composicao, plastico: e.target.value } }))
                }
              />
            </div>

            <div className="field">
              <label>Madeira</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.madeira}
                onChange={(e) => setDraft((d) => ({ ...d, composicao: { ...d.composicao, madeira: e.target.value } }))}
              />
            </div>

            <div className="field">
              <label>Vidro</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.vidro}
                onChange={(e) => setDraft((d) => ({ ...d, composicao: { ...d.composicao, vidro: e.target.value } }))}
              />
            </div>

            <div className="field">
              <label>Outros</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.outros}
                onChange={(e) => setDraft((d) => ({ ...d, composicao: { ...d.composicao, outros: e.target.value } }))}
              />
            </div>

            <div className="field">
              <label>Matéria orgânica</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.organica}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, composicao: { ...d.composicao, organica: e.target.value } }))
                }
              />
            </div>

            <div className="field">
              <label>Têxteis</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.texteis}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, composicao: { ...d.composicao, texteis: e.target.value } }))
                }
              />
            </div>

            <div className="field">
              <label>Metal</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.metal}
                onChange={(e) => setDraft((d) => ({ ...d, composicao: { ...d.composicao, metal: e.target.value } }))}
              />
            </div>

            <div className="field">
              <label>Borracha e couro</label>
              <input
                type="number"
                step="0.1"
                value={draft.composicao.borracha}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, composicao: { ...d.composicao, borracha: e.target.value } }))
                }
              />
            </div>

            <div className="rsu-comp-actions">
              <button className="btn-primary" type="button" onClick={onAtualizar}>
                Recalcular
              </button>

              <button className="btn-secondary" type="button" onClick={normalizarComposicao}>
                Ajustar soma para 100%
              </button>

              <div className={`rsu-sum ${compOk ? "ok" : "warn"}`}>
                Soma: <b>{fmt1(somaComposicao)}%</b>
                {compOk ? null : (
                  <span className="orange-text">
                    {deltaComposicao > 0 ? `faltam ${fmt1(deltaComposicao)}%` : `sobram ${fmt1(Math.abs(deltaComposicao))}%`}
                  </span>
                )}
              </div>

              <div className="rsu-sum ok">
                L0: <b>{fmt4(loCalculado)}</b>
                <span className="rsu-lo-unit">t CH₄/t ({fmt1(loCalculado / 0.0007168)} m³/t)</span>
              </div>
            </div>
          </div>
        </section>

        {/* Gráfico full width */}
        <section className="card glow rsu-chart full-width">
          <h3 className="rsu-section-title">Resíduo coletado (t/ano)</h3>

          {/* container específico para evitar conflitos com .chart-container global */}
          <div className="rsu-chart-container">
            <ResponsiveLine
              data={series.nivo}
              margin={
                isMobile
                  ? { top: 16, right: 16, bottom: 52, left: 52 }
                  : { top: 20, right: 24, bottom: 52, left: 76 }
              }
              xScale={{ type: "point" }}
              yScale={{ type: "linear", min: 0, max: "auto", stacked: false, reverse: false }}
              curve="monotoneX"
              axisTop={null}
              axisRight={null}
              axisBottom={{
                tickSize: 4,
                tickPadding: 6,
                tickRotation: isMobile ? -45 : 0,
                tickValues: isMobile ? yearTicks(series.rows.map((r) => r.ano), 6).map(String) : series.ticks,
                legend: "Ano",
                legendPosition: "middle",
                legendOffset: isMobile ? 40 : 38,
              }}
              axisLeft={{
                tickSize: 0,
                tickPadding: 8,
                tickRotation: 0,
                tickValues: isMobile ? 4 : 6,
                format: fmtAxis,
                legend: "t/ano",
                legendPosition: "middle",
                legendOffset: isMobile ? -40 : -58,
              }}
              gridXValues={series.ticks}
              gridYValues={isMobile ? 4 : 6}
              enablePoints={series.rows.length <= 25 && !isMobile}
              pointSize={5}
              pointColor="#1d4a37"
              pointBorderWidth={2}
              pointBorderColor="#fff"
              enableArea={true}
              areaOpacity={0.12}
              useMesh={true}
              colors={["#1d4a37"]}
              theme={{
                text: { fontFamily: "Barlow, 'Segoe UI', sans-serif", fill: "#4a5650" },
                textColor: "#4a5650",
                fontSize: isMobile ? 11 : 12,
                grid: { line: { stroke: "#e3e7e3", strokeWidth: 1 } },
              }}
              tooltip={({ point }) => (
                <div
                  style={{
                    background: "white",
                    padding: "8px 10px",
                    border: "1px solid #d5dbd6",
                    borderRadius: "4px",
                    color: "#1e2723",
                  }}
                >
                  {point.data.xFormatted}: {fmtNumber(point.data.y)} t/ano
                </div>
              )}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
