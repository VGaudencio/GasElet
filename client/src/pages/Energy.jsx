import React, { useEffect, useMemo, useRef, useState } from "react";
import ResumoAterro from "../components/ResumoAterro.jsx";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { GeoJSON, MapContainer, TileLayer } from "react-leaflet";
import L from "leaflet";
import { useDashboard } from "../context/DashboardContext.jsx";
import { fetchLandfillCalculation } from "../utils/landfillCalcApi.js";
import { DEFAULT_ANO_FINAL, normalizeLandfillConfig } from "../utils/landfillModel.js";
import { fmtAxis, yearTicks } from "../utils/chartFormat.js";
import "../styles/Energy.css";


const GENERATOR_TEMPLATES = [
  {
    id: "motor-gerador",
    nome: "Motor-gerador",
    tipo: "Motor de combustão interna",
    eficienciaEletricaPct: 38,
    potenciaNominalKw: 1200,
    disponibilidadePct: 92,
    energiaEspecificaKwhPorTonCh4: 13890,
  },
  {
    id: "microturbina",
    nome: "Microturbina",
    tipo: "Microturbina a gás",
    eficienciaEletricaPct: 30,
    potenciaNominalKw: 500,
    disponibilidadePct: 90,
    energiaEspecificaKwhPorTonCh4: 13890,
  },
  {
    id: "turbina-gas",
    nome: "Turbina a gás",
    tipo: "Turbina industrial",
    eficienciaEletricaPct: 34,
    potenciaNominalKw: 2500,
    disponibilidadePct: 89,
    energiaEspecificaKwhPorTonCh4: 13890,
  },
  {
    id: "peltier",
    nome: "Célula de Peltier",
    tipo: "Geração termoelétrica",
    eficienciaEletricaPct: 6,
    potenciaNominalKw: 40,
    disponibilidadePct: 85,
    energiaEspecificaKwhPorTonCh4: 13890,
  },
];

const IBGE_LOCALIDADES = "https://servicodados.ibge.gov.br/api/v1/localidades";
const IBGE_MALHAS_V3 = "https://servicodados.ibge.gov.br/api/v3/malhas";
const CALC_END_YEAR = DEFAULT_ANO_FINAL;
const ENERGY_SERIES_COLORS = ["#1d4a37", "#2f6b4f", "#4e8a6a", "#7aa88e", "#a3c4b0", "#c7dccf"];
const DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH = 180;

function toNumber(v, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : fallback;
}

function rangeYears(from, to) {
  const out = [];
  for (let y = from; y <= to; y += 1) out.push(y);
  return out;
}

function cityKey(row) {
  return `${row.uf}::${row.nome}`;
}

function cityShortName(nome) {
  return String(nome).replace(/\s*\([A-Z]{2}\)\s*$/, "").trim();
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableSerialize(value[k])}`)
    .join(",")}}`;
}

function generatorDraftFromTemplate(template = GENERATOR_TEMPLATES[0]) {
  return {
    nome: template.nome,
    tipo: template.tipo,
    eficienciaEletricaPct: String(template.eficienciaEletricaPct),
    potenciaNominalKw: String(template.potenciaNominalKw),
    disponibilidadePct: String(template.disponibilidadePct),
    energiaEspecificaKwhPorTonCh4: String(template.energiaEspecificaKwhPorTonCh4),
    quantidadeUnidades: "0",
  };
}

function normalizeGenerator(raw, fallbackId = "gen-default") {
  return {
    id: String(raw?.id || fallbackId),
    nome: String(raw?.nome || "Gerador"),
    tipo: String(raw?.tipo || "Personalizado"),
    eficienciaEletricaPct: Math.min(100, Math.max(0, toNumber(raw?.eficienciaEletricaPct, 30))),
    potenciaNominalKw: Math.max(0, toNumber(raw?.potenciaNominalKw, 100)),
    disponibilidadePct: Math.min(100, Math.max(0, toNumber(raw?.disponibilidadePct, 90))),
    energiaEspecificaKwhPorTonCh4: Math.max(1, toNumber(raw?.energiaEspecificaKwhPorTonCh4, 13890)),
    // 0 = automático: unidades suficientes para absorver o pico de metano.
    quantidadeUnidades: Math.max(0, Math.round(toNumber(raw?.quantidadeUnidades, 0))),
  };
}

function createGeneratorFromTemplate(template) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return normalizeGenerator(
    {
      ...template,
      id: `gen-${template.id}-${stamp}`,
    },
    `gen-${template.id}-${stamp}`
  );
}

// Metano efetivamente captado; respostas antigas do backend não trazem o campo.
function recoveredMethane(row) {
  const recuperado = Number(row?.metanoRecuperadoTAno);
  return Number.isFinite(recuperado) ? recuperado : Number(row?.metanoTAno) || 0;
}

const HOURS_PER_YEAR = 8760;

// Potência elétrica média (kW) que o metano consegue sustentar com o gerador:
// t CH4/ano · kWh/t (PCI) · η / 8760 h.
function electricPowerFromMethaneKw(methaneTAno, generator) {
  if (!generator) return 0;
  return (
    (Math.max(0, methaneTAno) * generator.energiaEspecificaKwhPorTonCh4 * (generator.eficienciaEletricaPct / 100)) /
    HOURS_PER_YEAR
  );
}

// Unidades instaladas. Em modo automático (0) dimensiona pelo pico de metano da série,
// para que a geração acompanhe a curva de metano em vez de saturar numa unidade só.
function resolveGeneratorUnits(generator, peakMethaneTAno) {
  if (!generator) return 0;
  if (generator.quantidadeUnidades > 0) return generator.quantidadeUnidades;
  if (generator.potenciaNominalKw <= 0) return 0;
  const peakKw = electricPowerFromMethaneKw(peakMethaneTAno, generator);
  return Math.max(1, Math.ceil(peakKw / generator.potenciaNominalKw - 1e-9));
}

function peakMethane(rows) {
  return rows.reduce((max, row) => Math.max(max, recoveredMethane(row)), 0);
}

// Gás chega continuamente; quando a planta está parada (1 - disponibilidade) ele é
// queimado em flare. Logo: E = min(P_gás · η, N · P_nom) · 8760 · disponibilidade.
function generatorEnergyFromMethane(methaneTAno, generator, units) {
  if (!generator) {
    return {
      energiaGeradaKwh: 0,
      energiaGeradaMwh: 0,
      energiaPotencialKwh: 0,
      limitePorPotenciaKwh: 0,
      unidades: 0,
    };
  }

  const disponibilidade = generator.disponibilidadePct / 100;
  const energiaPotencialKwh =
    electricPowerFromMethaneKw(methaneTAno, generator) * HOURS_PER_YEAR * disponibilidade;
  const limitePorPotenciaKwh =
    units * generator.potenciaNominalKw * HOURS_PER_YEAR * disponibilidade;

  const energiaGeradaKwh = Math.min(energiaPotencialKwh, limitePorPotenciaKwh);

  return {
    energiaGeradaKwh,
    energiaGeradaMwh: energiaGeradaKwh / 1000,
    energiaPotencialKwh,
    limitePorPotenciaKwh,
    unidades: units,
  };
}

function fmtInt(n) {
  return new Intl.NumberFormat("pt-BR").format(Math.round(n || 0));
}

function fmtTon(n) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n || 0));
}

function fmtMwh(n) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n || 0));
}

function norm(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function getMunicipioId(ufSigla, nomeMunicipioComUf) {
  const nomeMunicipio = String(nomeMunicipioComUf).replace(/\s*\(.+\)\s*$/, "");
  const list = await fetch(`${IBGE_LOCALIDADES}/estados/${ufSigla}/municipios`).then((r) => r.json());
  const alvo = norm(nomeMunicipio);
  const hit = list.find((m) => norm(m.nome) === alvo) || list.find((m) => norm(m.nome).startsWith(alvo));
  if (!hit) throw new Error(`Município não encontrado: ${nomeMunicipio}/${ufSigla}`);
  return hit.id;
}

async function getMunicipioGeoJSON(municipioId, qualidade = "intermediaria") {
  const url =
    `${IBGE_MALHAS_V3}/municipios/${municipioId}` +
    `?formato=application/vnd.geo+json&qualidade=${qualidade}`;
  const gj = await fetch(url, {
    headers: { Accept: "application/vnd.geo+json" },
  }).then((r) => r.json());

  if (gj.type === "FeatureCollection") return gj;
  if (gj.type === "Feature") return { type: "FeatureCollection", features: [gj] };
  throw new Error("GeoJSON inesperado da malha do IBGE");
}

function EnergyMap({ rows, selectedCityKey, onSelectCity }) {
  const mapRef = useRef(null);
  const [geoCache, setGeoCache] = useState(() => new Map());
  const [loadingKeys, setLoadingKeys] = useState(new Set());
  const [errorKeys, setErrorKeys] = useState(new Map());

  useEffect(() => {
    const wanted = rows.map((r) => cityKey(r));
    const missing = wanted.filter((k) => !geoCache.has(k) && !loadingKeys.has(k));
    if (missing.length === 0) return;

    setLoadingKeys((prev) => new Set([...prev, ...missing]));
    (async () => {
      const newCache = new Map(geoCache);
      const newErrors = new Map(errorKeys);
      await Promise.all(
        missing.map(async (k) => {
          const [uf, nome] = k.split("::");
          try {
            const id = await getMunicipioId(uf, nome);
            const gj = await getMunicipioGeoJSON(id, "intermediaria");
            newCache.set(k, gj);
            newErrors.delete(k);
          } catch (e) {
            newErrors.set(k, e?.message || "Erro ao carregar malha");
          }
        })
      );

      setGeoCache(newCache);
      setErrorKeys(newErrors);
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        missing.forEach((k) => next.delete(k));
        return next;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (selectedCityKey) {
      const fc = geoCache.get(selectedCityKey);
      if (fc?.features?.length) {
        const g = L.geoJSON(fc);
        const b = g.getBounds();
        if (b.isValid()) {
          map.flyToBounds(b.pad(0.2), { duration: 1.1 });
          return;
        }
      }
    }

    const all = [];
    rows.forEach((r) => {
      const fc = geoCache.get(cityKey(r));
      if (fc?.features?.length) all.push(...fc.features);
    });
    if (all.length) {
      const g = L.geoJSON({ type: "FeatureCollection", features: all });
      const b = g.getBounds();
      if (b.isValid()) {
        map.fitBounds(b.pad(0.12));
        return;
      }
    }

    map.setView([-14.235, -51.9253], 4);
  }, [rows, geoCache, selectedCityKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const tick = () => map.invalidateSize();
    const t = setTimeout(tick, 0);
    window.addEventListener("resize", tick);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", tick);
    };
  }, []);

  const styleFor = (idx, isActive) => {
    const palette = ["#1d4a37", "#2f6b4f", "#4e8a6a", "#7aa88e", "#a3c4b0", "#c7dccf"];
    if (isActive) {
      return { color: "#d9661a", fillColor: "#f0b27a", weight: 3.2, fillOpacity: 0.5 };
    }
    const color = palette[idx % palette.length];
    return { color, fillColor: color, weight: 2.3, fillOpacity: 0.25 };
  };

  return (
    <div className="energy-map-shell">
      <div className="map-wrap">
        <MapContainer
          center={[-14.235, -51.9253]}
          zoom={4}
          scrollWheelZoom
          className="map-el"
          whenCreated={(map) => {
            mapRef.current = map;
          }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap colaboradores"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {rows.map((row, idx) => {
            const key = cityKey(row);
            const fc = geoCache.get(key);
            if (!fc) return null;
            const active = selectedCityKey === key;
            return (
              <GeoJSON
                key={key}
                data={fc}
                style={() => styleFor(idx, active)}
                eventHandlers={{ click: () => onSelectCity(key) }}
              />
            );
          })}
        </MapContainer>

        {loadingKeys.size > 0 && <div className="map-loading">Carregando {loadingKeys.size} cidade(s)...</div>}
        {errorKeys.size > 0 && <div className="map-error">Algumas cidades nao carregaram no mapa.</div>}
      </div>
    </div>
  );
}

export default function Energy() {
  const [loaded, setLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth <= 768 : false)
  );
  const [selectedYear, setSelectedYear] = useState(null);
  const [selectedCityKey, setSelectedCityKey] = useState(null);
  const [customDraft, setCustomDraft] = useState(() => generatorDraftFromTemplate());
  const [generators, setGenerators] = useState([]);
  const [activeGeneratorId, setActiveGeneratorId] = useState(null);
  const [compareGeneratorIds, setCompareGeneratorIds] = useState([]);
  const [residentialConsumptionKwhMonth, setResidentialConsumptionKwhMonth] = useState(
    DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH
  );
  const [landfillCalc, setLandfillCalc] = useState(null);
  const [loadingLandfillCalc, setLoadingLandfillCalc] = useState(false);
  const [landfillCalcError, setLandfillCalcError] = useState(null);
  const hydratedEnergyScenariosRef = useRef(new Set());

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
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const currentScenario = useMemo(
    () => scenarios.find((s) => String(s.id) === String(currentScenarioId)) || null,
    [scenarios, currentScenarioId]
  );
  const rows = useMemo(() => currentScenario?.rows || [], [currentScenario]);

  useEffect(() => {
    if (!currentScenarioId) return;
    const hydrated = hydratedEnergyScenariosRef.current;
    if (hydrated.has(currentScenarioId)) return;

    const entry = rsuByScenario?.[currentScenarioId];
    const savedEnergy = entry?.energy;
    if (savedEnergy && Array.isArray(savedEnergy.generators) && savedEnergy.generators.length) {
      const normalized = savedEnergy.generators.map((g, idx) => normalizeGenerator(g, `gen-saved-${idx}`));
      const nextSig = stableSerialize(normalized);
      const activeExists = normalized.some((g) => g.id === savedEnergy.activeGeneratorId);
      const desiredActiveId = activeExists ? savedEnergy.activeGeneratorId : normalized[0].id;
      const normalizedCompare = Array.isArray(savedEnergy.compareGeneratorIds)
        ? savedEnergy.compareGeneratorIds.filter((id) => normalized.some((g) => g.id === id))
        : [];
      const nextCompareIds = normalizedCompare.length
        ? normalizedCompare
        : normalized.slice(0, 3).map((g) => g.id);
      const nextYear = Number(savedEnergy.selectedYear);
      const normalizedYear = Number.isFinite(nextYear) ? nextYear : null;
      const normalizedCityKey =
        typeof savedEnergy.selectedCityKey === "string" && savedEnergy.selectedCityKey.trim()
          ? savedEnergy.selectedCityKey
          : null;
      const normalizedResidentialConsumption = Math.max(
        1,
        toNumber(savedEnergy.residentialConsumptionKwhMonth, DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH)
      );

      setGenerators((prev) => (stableSerialize(prev) === nextSig ? prev : normalized));
      setActiveGeneratorId((prev) => (prev === desiredActiveId ? prev : desiredActiveId));
      setCompareGeneratorIds((prev) =>
        stableSerialize(prev) === stableSerialize(nextCompareIds) ? prev : nextCompareIds
      );
      setSelectedYear((prev) => (prev === normalizedYear ? prev : normalizedYear));
      setSelectedCityKey((prev) => (prev === normalizedCityKey ? prev : normalizedCityKey));
      setResidentialConsumptionKwhMonth((prev) =>
        prev === normalizedResidentialConsumption ? prev : normalizedResidentialConsumption
      );
      hydrated.add(currentScenarioId);
      return;
    }

    const defaultGenerator = normalizeGenerator(
      { ...GENERATOR_TEMPLATES[0], id: `gen-default-${currentScenarioId}` },
      `gen-default-${currentScenarioId}`
    );
    const defaultList = [defaultGenerator];
    const defaultSig = stableSerialize(defaultList);
    setGenerators((prev) => (stableSerialize(prev) === defaultSig ? prev : defaultList));
    setActiveGeneratorId((prev) => (prev === defaultGenerator.id ? prev : defaultGenerator.id));
    setCompareGeneratorIds([defaultGenerator.id]);
    setSelectedYear((prev) => (prev === null ? prev : null));
    setSelectedCityKey((prev) => (prev === null ? prev : null));
    setResidentialConsumptionKwhMonth(DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH);
    hydrated.add(currentScenarioId);
  }, [currentScenarioId, rsuByScenario]);

  useEffect(() => {
    if (!generators.length) {
      setCompareGeneratorIds([]);
      return;
    }
    setCompareGeneratorIds((prev) => {
      const valid = prev.filter((id) => generators.some((g) => g.id === id));
      if (valid.length) return valid;
      return generators.slice(0, 3).map((g) => g.id);
    });
  }, [generators]);

  useEffect(() => {
    if (!currentScenarioId || !generators.length) return;
    if (!hydratedEnergyScenariosRef.current.has(currentScenarioId)) return;
    const validCompareGeneratorIds = compareGeneratorIds.filter((id) =>
      generators.some((g) => g.id === id)
    );
    const nextEnergy = {
      generators,
      activeGeneratorId: activeGeneratorId || generators[0].id,
      compareGeneratorIds: validCompareGeneratorIds,
      selectedYear: Number.isFinite(Number(selectedYear)) ? Number(selectedYear) : null,
      selectedCityKey:
        typeof selectedCityKey === "string" && selectedCityKey.trim() ? selectedCityKey : null,
      residentialConsumptionKwhMonth: Math.max(
        1,
        toNumber(residentialConsumptionKwhMonth, DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH)
      ),
    };

    setRsuByScenario((prev) => {
      const safePrev = prev || {};
      const currentEntry = safePrev[currentScenarioId] || {};
      const prevEnergySig = stableSerialize(currentEntry.energy || {});
      const nextEnergySig = stableSerialize(nextEnergy);
      if (
        currentEntry.energy &&
        prevEnergySig === nextEnergySig
      ) {
        return safePrev;
      }

      return {
        ...safePrev,
        [currentScenarioId]: {
          ...currentEntry,
          energy: nextEnergy,
        },
      };
    });
  }, [
    currentScenarioId,
    generators,
    activeGeneratorId,
    compareGeneratorIds,
    selectedYear,
    selectedCityKey,
    residentialConsumptionKwhMonth,
    setRsuByScenario,
  ]);

  const scenarioEntry = useMemo(
    () => (currentScenarioId ? rsuByScenario?.[currentScenarioId] : null),
    [currentScenarioId, rsuByScenario]
  );

  const config = useMemo(() => normalizeLandfillConfig(scenarioEntry?.config), [scenarioEntry?.config]);
  const configSignature = useMemo(() => stableSerialize(config), [config]);

  const years = useMemo(() => {
    const fromConfig = Number(config.vidaInicio);
    const toConfig = Number(config.vidaFim);
    if (Number.isFinite(fromConfig) && Number.isFinite(toConfig) && fromConfig <= toConfig) {
      return rangeYears(fromConfig, Math.max(fromConfig, CALC_END_YEAR));
    }

    const fromScenario = Number(currentScenario?.anoInicial);
    const toScenario = Number(currentScenario?.anoFinal);
    if (Number.isFinite(fromScenario) && Number.isFinite(toScenario) && fromScenario <= toScenario) {
      return rangeYears(fromScenario, Math.max(fromScenario, CALC_END_YEAR));
    }

    const set = new Set();
    rows.forEach((r) => {
      Object.keys(r?.series || {}).forEach((y) => {
        const ny = Number(y);
        if (Number.isFinite(ny)) set.add(ny);
      });
    });
    if (set.size === 0) return [];
    return Array.from(set).sort((a, b) => a - b);
  }, [rows, currentScenario, config.vidaInicio, config.vidaFim]);

  useEffect(() => {
    if (!years.length) {
      setSelectedYear(null);
      return;
    }
    if (!selectedYear || !years.includes(selectedYear)) {
      setSelectedYear(years[years.length - 1]);
    }
  }, [years, selectedYear]);

  useEffect(() => {
    if (!currentScenarioId || !years.length) {
      setLandfillCalc(null);
      setLandfillCalcError(null);
      setLoadingLandfillCalc(false);
      return;
    }

    let cancelled = false;
    setLoadingLandfillCalc(true);
    setLandfillCalcError(null);

    fetchLandfillCalculation({
      rows,
      config,
      anoInicial: Math.round(toNumber(config.vidaInicio, years[0])),
      anoFinal: Math.max(
        Math.round(toNumber(config.vidaInicio, years[0])),
        Math.round(toNumber(config.vidaFim, years[0]))
      ),
      maxYear: Math.max(CALC_END_YEAR, years[0]),
    })
      .then((result) => {
        if (cancelled) return;
        setLandfillCalc(result);
      })
      .catch((error) => {
        if (cancelled) return;
        setLandfillCalc(null);
        setLandfillCalcError(error?.message || "Erro ao calcular metano no servidor");
      })
      .finally(() => {
        if (!cancelled) setLoadingLandfillCalc(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentScenarioId, rows, years, configSignature]);

  const annualMethaneData = useMemo(() => {
    const byYear = new Map(
      (landfillCalc?.total?.rows || []).map((row) => [Number(row?.ano), row])
    );

    return years.map((year) => {
      const calcRow = byYear.get(year);
      return {
        ano: year,
        populacao: Number(calcRow?.pop) || 0,
        residuoTAno: Number(calcRow?.residuoTAno) || 0,
        metanoTAno: Number(calcRow?.metanoTAno) || 0,
        metanoRecuperadoTAno: recoveredMethane(calcRow),
      };
    });
  }, [years, landfillCalc]);

  const activeGenerator = useMemo(
    () => generators.find((g) => g.id === activeGeneratorId) || generators[0] || null,
    [generators, activeGeneratorId]
  );

  const totalPeakMethaneTAno = useMemo(() => peakMethane(annualMethaneData), [annualMethaneData]);

  const activeGeneratorUnits = useMemo(
    () => resolveGeneratorUnits(activeGenerator, totalPeakMethaneTAno),
    [activeGenerator, totalPeakMethaneTAno]
  );

  const annualEnergyData = useMemo(
    () =>
      annualMethaneData.map((row) => {
        const energy = generatorEnergyFromMethane(
          row.metanoRecuperadoTAno,
          activeGenerator,
          activeGeneratorUnits
        );
        return {
          ...row,
          energiaPotencialMwh: energy.energiaPotencialKwh / 1000,
          energiaGeradaMwh: energy.energiaGeradaMwh,
          limiteMwh: energy.limitePorPotenciaKwh / 1000,
        };
      }),
    [annualMethaneData, activeGenerator, activeGeneratorUnits]
  );

  const cityRowsByKey = useMemo(() => {
    const map = new Map();
    (landfillCalc?.cities || []).forEach((city) => {
      map.set(city.key, city.rows || []);
    });
    return map;
  }, [landfillCalc]);

  const cityEnergyData = useMemo(() => {
    if (!selectedYear) return [];

    return rows
      .map((row) => {
        const key = cityKey(row);
        const cityRows = cityRowsByKey.get(key) || [];
        const selectedRow = cityRows.find((item) => Number(item?.ano) === selectedYear);
        const metanoTAno = Number(selectedRow?.metanoTAno) || 0;
        // Cada cidade com sua própria planta, dimensionada pelo pico de metano dela.
        const units = resolveGeneratorUnits(activeGenerator, peakMethane(cityRows));
        const energy = generatorEnergyFromMethane(recoveredMethane(selectedRow), activeGenerator, units);

        return {
          key,
          uf: row.uf,
          nome: cityShortName(row.nome),
          populacao: Number(selectedRow?.pop) || 0,
          residuoTAno: Number(selectedRow?.residuoTAno) || 0,
          metanoTAno,
          metanoRecuperadoTAno: recoveredMethane(selectedRow),
          energiaPotencialMwh: energy.energiaPotencialKwh / 1000,
          energiaGeradaMwh: energy.energiaGeradaMwh,
          unidades: units,
        };
      })
      .sort((a, b) => b.energiaPotencialMwh - a.energiaPotencialMwh);
  }, [rows, selectedYear, cityRowsByKey, activeGenerator]);

  useEffect(() => {
    if (!cityEnergyData.length) {
      setSelectedCityKey(null);
      return;
    }
    if (!selectedCityKey || !cityEnergyData.some((c) => c.key === selectedCityKey)) {
      setSelectedCityKey(cityEnergyData[0].key);
    }
  }, [cityEnergyData, selectedCityKey]);

  const selectedCity = useMemo(
    () => cityEnergyData.find((c) => c.key === selectedCityKey) || null,
    [cityEnergyData, selectedCityKey]
  );

  const selectedYearTotals = useMemo(
    () => annualEnergyData.find((d) => d.ano === selectedYear) || null,
    [annualEnergyData, selectedYear]
  );

  const annualResidentialConsumptionKwh = useMemo(
    () =>
      Math.max(1, toNumber(residentialConsumptionKwhMonth, DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH)) * 12,
    [residentialConsumptionKwhMonth]
  );

  const comparedGenerators = useMemo(
    () => generators.filter((g) => compareGeneratorIds.includes(g.id)),
    [generators, compareGeneratorIds]
  );

  const generatorComparisonData = useMemo(() => {
    const methaneTAno = selectedYearTotals?.metanoRecuperadoTAno || 0;
    return comparedGenerators.map((generator) => {
      const units = resolveGeneratorUnits(generator, totalPeakMethaneTAno);
      const energy = generatorEnergyFromMethane(methaneTAno, generator, units);
      const energiaGeradaMwh = energy.energiaGeradaMwh;
      const energiaPotencialMwh = energy.energiaPotencialKwh / 1000;
      const limiteMwh = energy.limitePorPotenciaKwh / 1000;
      const casasAtendidasAno = (energiaGeradaMwh * 1000) / annualResidentialConsumptionKwh;
      const utilizacaoPotenciaPct =
        limiteMwh > 0 ? (energiaGeradaMwh / limiteMwh) * 100 : 0;
      return {
        id: generator.id,
        nome: generator.nome,
        tipo: generator.tipo,
        eficienciaEletricaPct: generator.eficienciaEletricaPct,
        potenciaNominalKw: generator.potenciaNominalKw,
        disponibilidadePct: generator.disponibilidadePct,
        unidades: units,
        potenciaInstaladaKw: units * generator.potenciaNominalKw,
        energiaGeradaMwh,
        energiaPotencialMwh,
        casasAtendidasAno,
        limiteMwh,
        utilizacaoPotenciaPct,
      };
    });
  }, [comparedGenerators, selectedYearTotals, totalPeakMethaneTAno, annualResidentialConsumptionKwh]);

  const comparisonSeries = useMemo(() => {
    return comparedGenerators.map((generator, idx) => ({
      id: generator.id,
      nome: generator.nome,
      color: ENERGY_SERIES_COLORS[idx % ENERGY_SERIES_COLORS.length],
    }));
  }, [comparedGenerators]);

  const comparisonAreaData = useMemo(() => {
    const unitsById = new Map(
      comparedGenerators.map((g) => [g.id, resolveGeneratorUnits(g, totalPeakMethaneTAno)])
    );
    return annualMethaneData.map((row) => {
      const point = { ano: row.ano };
      comparedGenerators.forEach((generator) => {
        const energy = generatorEnergyFromMethane(
          row.metanoRecuperadoTAno,
          generator,
          unitsById.get(generator.id)
        );
        point[generator.id] = energy.energiaGeradaMwh;
      });
      return point;
    });
  }, [annualMethaneData, comparedGenerators, totalPeakMethaneTAno]);

  const comparisonTicks = useMemo(
    () => yearTicks(comparisonAreaData.map((point) => point.ano), isMobile ? 6 : 14),
    [comparisonAreaData, isMobile]
  );

  const homesComparisonData = useMemo(
    () =>
      comparisonAreaData.map((row) => {
        const point = { ano: row.ano };
        comparisonSeries.forEach((series) => {
          const energiaMwh = Number(row?.[series.id]) || 0;
          point[series.id] = (energiaMwh * 1000) / annualResidentialConsumptionKwh;
        });
        return point;
      }),
    [comparisonAreaData, comparisonSeries, annualResidentialConsumptionKwh]
  );

  const annualHomesData = useMemo(
    () =>
      annualEnergyData.map((row) => ({
        ...row,
        casasAtendidas:
          (Number(row?.energiaGeradaMwh) || 0) * 1000 / annualResidentialConsumptionKwh,
      })),
    [annualEnergyData, annualResidentialConsumptionKwh]
  );

  const homesSeries = useMemo(() => {
    if (comparisonSeries.length) return comparisonSeries;
    return [
      {
        id: "casasAtendidas",
        nome: activeGenerator?.nome
          ? `Casas (${activeGenerator.nome})`
          : "Casas alimentadas",
        color: "#2f6b4f",
      },
    ];
  }, [comparisonSeries, activeGenerator]);

  const hasComparedHomesSeries = comparisonSeries.length > 0;

  const homesChartData = useMemo(() => {
    if (hasComparedHomesSeries) return homesComparisonData;
    return annualHomesData.map((row) => ({ ano: row.ano, casasAtendidas: row.casasAtendidas }));
  }, [hasComparedHomesSeries, homesComparisonData, annualHomesData]);

  const selectedYearHomes = useMemo(
    () => annualHomesData.find((d) => d.ano === selectedYear) || null,
    [annualHomesData, selectedYear]
  );

  const homesTicks = useMemo(
    () => yearTicks(homesChartData.map((point) => point.ano), isMobile ? 6 : 14),
    [homesChartData, isMobile]
  );

  const cityAxisWidth = useMemo(() => {
    const maxChars = cityEnergyData.reduce((maxLen, row) => Math.max(maxLen, row.nome.length), 0);
    const estimated = Math.round(maxChars * (isMobile ? 5.5 : 6.2));
    const min = isMobile ? 84 : 100;
    const max = isMobile ? 112 : 170;
    return Math.min(max, Math.max(min, estimated));
  }, [cityEnergyData, isMobile]);

  const formatCityTick = (value) => {
    const text = String(value ?? "");
    const max = isMobile ? 12 : 22;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const handleAddTemplate = (templateId) => {
    const template = GENERATOR_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const next = createGeneratorFromTemplate(template);
    setGenerators((prev) => [...prev, next]);
    setActiveGeneratorId(next.id);
  };

  const handleAddCustomGenerator = () => {
    const nome = customDraft.nome.trim();
    const tipo = customDraft.tipo.trim();
    if (!nome || !tipo) return;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = normalizeGenerator(
      {
        id: `gen-custom-${stamp}`,
        nome,
        tipo,
        eficienciaEletricaPct: customDraft.eficienciaEletricaPct,
        potenciaNominalKw: customDraft.potenciaNominalKw,
        disponibilidadePct: customDraft.disponibilidadePct,
        energiaEspecificaKwhPorTonCh4: customDraft.energiaEspecificaKwhPorTonCh4,
        quantidadeUnidades: customDraft.quantidadeUnidades,
      },
      `gen-custom-${stamp}`
    );
    setGenerators((prev) => [...prev, next]);
    setActiveGeneratorId(next.id);
  };

  const handleRemoveGenerator = (id) => {
    setGenerators((prev) => {
      const filtered = prev.filter((g) => g.id !== id);
      if (!filtered.length) return prev;
      if (activeGeneratorId === id) {
        setActiveGeneratorId(filtered[0].id);
      }
      return filtered;
    });
    setCompareGeneratorIds((prev) => prev.filter((gid) => gid !== id));
  };

  const handleChangeUnits = (id, value) => {
    const unidades = Math.max(0, Math.round(toNumber(value, 0)));
    setGenerators((prev) =>
      prev.map((g) => (g.id === id ? { ...g, quantidadeUnidades: unidades } : g))
    );
  };

  const toggleCompareGenerator = (id) => {
    setCompareGeneratorIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((gid) => gid !== id);
      }
      return [...prev, id];
    });
  };

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
          <h1>Energia elétrica</h1>
        </div>

        <div className="header-actions">
          <div className="select-wrap compact energy-year-select">
            <select
              value={selectedYear ?? ""}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              disabled={!years.length}
            >
              {!years.length && <option value="">Sem anos</option>}
              {years.map((y) => (
                <option key={y} value={y}>
                  Ano {y}
                </option>
              ))}
            </select>
            <span className="chev">▾</span>
          </div>
        </div>
      </header>

      <ResumoAterro />

      {loadingLandfillCalc && (
        <small style={{ display: "block", marginBottom: 8 }}>
          Atualizando cálculo de metano no servidor...
        </small>
      )}
      {landfillCalcError && (
        <small className="error-text" style={{ display: "block", marginBottom: 8 }}>
          {landfillCalcError}
        </small>
      )}

      <section className="card glow energy-generator-card">
        <div className="energy-generator-header">
          <h3>Geradores</h3>
          <p>Comece por um modelo pronto ou informe os dados de outro gerador.</p>
        </div>

        <div className="energy-template-row">
          {GENERATOR_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="btn-secondary"
              onClick={() => handleAddTemplate(template.id)}
            >
              + {template.nome}
            </button>
          ))}
        </div>

        <div className="energy-generator-form">
          <div className="field">
            <label>Nome do gerador</label>
            <input
              type="text"
              value={customDraft.nome}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, nome: e.target.value }))}
              placeholder="Ex.: Meu Gerador 01"
            />
          </div>

          <div className="field">
            <label>Tipo do gerador</label>
            <input
              type="text"
              value={customDraft.tipo}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, tipo: e.target.value }))}
              placeholder="Ex.: Motor, Peltier, Turbina..."
            />
          </div>

          <div className="field">
            <label>Eficiência elétrica (%)</label>
            <input
              type="number"
              value={customDraft.eficienciaEletricaPct}
              onChange={(e) =>
                setCustomDraft((prev) => ({ ...prev, eficienciaEletricaPct: e.target.value }))
              }
            />
          </div>

          <div className="field">
            <label>Potência nominal (kW)</label>
            <input
              type="number"
              value={customDraft.potenciaNominalKw}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, potenciaNominalKw: e.target.value }))}
            />
          </div>

          <div className="field">
            <label>Disponibilidade (%)</label>
            <input
              type="number"
              value={customDraft.disponibilidadePct}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, disponibilidadePct: e.target.value }))}
            />
          </div>

          <div className="field">
            <label>Quantidade de unidades (0 = automático)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={customDraft.quantidadeUnidades}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, quantidadeUnidades: e.target.value }))}
            />
          </div>

          <div className="field">
            <label>Energia específica do CH₄ (kWh/t)</label>
            <input
              type="number"
              value={customDraft.energiaEspecificaKwhPorTonCh4}
              onChange={(e) =>
                setCustomDraft((prev) => ({
                  ...prev,
                  energiaEspecificaKwhPorTonCh4: e.target.value,
                }))
              }
            />
          </div>
        </div>

        <div className="energy-generator-actions">
          <button className="btn-primary" type="button" onClick={handleAddCustomGenerator}>
            Adicionar gerador
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setCompareGeneratorIds(generators.map((g) => g.id))}
          >
            Comparar todos
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setCompareGeneratorIds(activeGeneratorId ? [activeGeneratorId] : [])}
          >
            Comparar só o ativo
          </button>
        </div>

        <div className="energy-generator-list-wrap">
          <table className="energy-generator-list">
            <thead>
              <tr>
                <th>Ativo</th>
                <th>Comparar</th>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Efic. (%)</th>
                <th>Pot. (kW)</th>
                <th>Disp. (%)</th>
                <th>Unidades</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {generators.map((g) => (
                <tr key={g.id} className={g.id === activeGeneratorId ? "is-selected" : ""}>
                  <td>
                    <input
                      type="radio"
                      name="active-generator"
                      checked={g.id === activeGeneratorId}
                      onChange={() => setActiveGeneratorId(g.id)}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={compareGeneratorIds.includes(g.id)}
                      onChange={() => toggleCompareGenerator(g.id)}
                    />
                  </td>
                  <td>{g.nome}</td>
                  <td>{g.tipo}</td>
                  <td>{fmtTon(g.eficienciaEletricaPct)}</td>
                  <td>{fmtTon(g.potenciaNominalKw)}</td>
                  <td>{fmtTon(g.disponibilidadePct)}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="energy-units-input"
                      value={g.quantidadeUnidades}
                      title="0 = automático (dimensionado pelo pico de metano)"
                      onChange={(e) => handleChangeUnits(g.id, e.target.value)}
                    />
                    {g.quantidadeUnidades === 0 && (
                      <small> auto: {resolveGeneratorUnits(g, totalPeakMethaneTAno)}</small>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleRemoveGenerator(g.id)}
                      disabled={generators.length <= 1}
                      title={generators.length <= 1 ? "Mantenha pelo menos um gerador" : "Remover gerador"}
                    >
                      <span className="material-icons">delete</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card glow energy-compare-card">
        <div className="energy-generator-header">
          <h3>Comparação de geradores</h3>
          <p>
            Curva anual de geração a partir do metano recuperado, limitada pela potência instalada
            (unidades × potência nominal) dos geradores selecionados.
            Consumo usado: {fmtInt(annualResidentialConsumptionKwh)} kWh/ano por residência.
          </p>
        </div>

        {generatorComparisonData.length === 0 ? (
          <div className="energy-compare-empty">
            Selecione pelo menos um gerador na coluna "Comparar".
          </div>
        ) : (
          <>
            <div className="energy-compare-chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={comparisonAreaData}
                  margin={
                    isMobile
                      ? { top: 10, right: 10, left: 0, bottom: 18 }
                      : { top: 12, right: 18, left: 6, bottom: 12 }
                  }
                >
                  <defs>
                    {comparisonSeries.map((series) => (
                      <linearGradient key={series.id} id={`compare-${series.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={series.color} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={series.color} stopOpacity={0.06} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="#e3e7e3" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ano"
                    tickMargin={8}
                    interval={0}
                    ticks={comparisonTicks}
                    tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                    tickLine={{ stroke: "#e3e7e3" }}
                    axisLine={{ stroke: "#e3e7e3" }}
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    width={isMobile ? 56 : 64}
                    tickFormatter={fmtAxis}
                    tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                    tickLine={{ stroke: "#e3e7e3" }}
                    axisLine={{ stroke: "#e3e7e3" }}
                  />
                  <Legend />
                  <ReTooltip
                    formatter={(value, name) => {
                      const casas = (Number(value) * 1000) / annualResidentialConsumptionKwh;
                      return [`${fmtMwh(value)} MWh • ${fmtInt(casas)} casas/ano`, name];
                    }}
                    labelFormatter={(label) => `Ano ${label}`}
                    contentStyle={{
                      background: "#fff",
                      border: "1px solid #1d4a37",
                      borderRadius: 4,
                      color: "#1d4a37",
                      fontWeight: 500,
                    }}
                  />
                  {comparisonSeries.map((series) => (
                    <Area
                      key={series.id}
                      type="linear"
                      dataKey={series.id}
                      name={series.nome}
                      stroke={series.color}
                      fill={`url(#compare-${series.id})`}
                      fillOpacity={1}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="energy-compare-table-wrap">
              <table className="energy-compare-table">
                <thead>
                  <tr>
                    <th>Gerador</th>
                    <th>Tipo</th>
                    <th>Efic. (%)</th>
                    <th>Pot. (kW)</th>
                    <th>Disp. (%)</th>
                    <th>Unidades</th>
                    <th>Pot. instalada (kW)</th>
                    <th>Energia gerada (MWh)</th>
                    <th>Energia potencial (MWh)</th>
                    <th>Casas/ano</th>
                    <th>Uso da potência (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {generatorComparisonData.map((row) => (
                    <tr key={row.id}>
                      <td>{row.nome}</td>
                      <td>{row.tipo}</td>
                      <td>{fmtTon(row.eficienciaEletricaPct)}</td>
                      <td>{fmtTon(row.potenciaNominalKw)}</td>
                      <td>{fmtTon(row.disponibilidadePct)}</td>
                      <td>{fmtInt(row.unidades)}</td>
                      <td>{fmtInt(row.potenciaInstaladaKw)}</td>
                      <td>{fmtMwh(row.energiaGeradaMwh)}</td>
                      <td>{fmtMwh(row.energiaPotencialMwh)}</td>
                      <td>{fmtInt(row.casasAtendidasAno)}</td>
                      <td>{fmtTon(row.utilizacaoPotenciaPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {!rows.length ? (
        <section className="card glow energy-empty">
          <h3>Nenhum município neste cenário</h3>
          <p>Adicione municípios na tela Início para estimar a energia.</p>
        </section>
      ) : (
        <>
          <div className="exp-metrics-row energy-metrics-row">
            <div className="exp-metric-card glow">
              <h3>Geradores cadastrados</h3>
              <div className="exp-mini-content">
                <div className="exp-text">
                  <h2>{generators.length}</h2>
                </div>
              </div>
            </div>

            <div className="exp-metric-card is-gas">
              <h3>Energia potencial em {selectedYear}</h3>
              <div className="exp-mini-content">
                <div className="exp-text">
                  <h2>{fmtMwh(selectedYearTotals?.energiaPotencialMwh || 0)} MWh</h2>
                  <p className="green-text">gerada: {fmtMwh(selectedYearTotals?.energiaGeradaMwh || 0)} MWh</p>
                </div>
              </div>
            </div>

            <div className="exp-metric-card glow">
              <h3>Gerador ativo</h3>
              <div className="exp-mini-content">
                <div className="exp-text">
                  <p className="green-text">{activeGenerator?.nome || "Sem gerador"}</p>
                  <h2>
                    {fmtInt(activeGeneratorUnits)} × {fmtTon(activeGenerator?.potenciaNominalKw || 0)} kW
                  </h2>
                </div>
              </div>
            </div>
          </div>

          <main className="home-grid energy-grid">
            <section className="card glow energy-map-card energy-map-main-card">
              <div className="map-card-header">
                <h3>Energia por município</h3>
              </div>

              <div className="energy-map-layout">
                <EnergyMap rows={rows} selectedCityKey={selectedCityKey} onSelectCity={setSelectedCityKey} />

                <aside className="energy-city-info">
                  <h4>Município selecionado</h4>
                  {!selectedCity ? (
                    <p>Clique num município no mapa.</p>
                  ) : (
                    <div className="energy-city-info-content">
                      <p className="energy-city-name">
                        {selectedCity.nome} ({selectedCity.uf})
                      </p>
                      <div className="energy-city-stat">
                        <span>População ({selectedYear})</span>
                        <strong>{fmtInt(selectedCity.populacao)}</strong>
                      </div>
                      <div className="energy-city-stat">
                        <span>Metano gerado</span>
                        <strong>{fmtTon(selectedCity.metanoTAno)} t/ano</strong>
                      </div>
                      <div className="energy-city-stat">
                        <span>Metano recuperado</span>
                        <strong>{fmtTon(selectedCity.metanoRecuperadoTAno)} t/ano</strong>
                      </div>
                      <div className="energy-city-stat">
                        <span>Potencial elétrico (metano)</span>
                        <strong>{fmtMwh(selectedCity.energiaPotencialMwh)} MWh/ano</strong>
                      </div>
                      <div className="energy-city-stat">
                        <span>Geração ({fmtInt(selectedCity.unidades)} unidade(s))</span>
                        <strong>{fmtMwh(selectedCity.energiaGeradaMwh)} MWh/ano</strong>
                      </div>
                    </div>
                  )}
                </aside>
              </div>
            </section>

            <section className="card glow energy-city-card">
              <h3>Potencial por município em {selectedYear}</h3>
              <div className="energy-city-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={cityEnergyData}
                    margin={
                      isMobile
                        ? { top: 8, right: 8, left: 6, bottom: 8 }
                        : { top: 8, right: 18, left: 8, bottom: 8 }
                    }
                    barCategoryGap={8}
                  >
                    <CartesianGrid stroke="#e3e7e3" strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={fmtAxis}
                      tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                      tickLine={{ stroke: "#e3e7e3" }}
                      axisLine={{ stroke: "#e3e7e3" }}
                      domain={[0, "auto"]}
                    />
                    <YAxis
                      type="category"
                      dataKey="nome"
                      width={cityAxisWidth}
                      interval={0}
                      tickFormatter={formatCityTick}
                      tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                      tickLine={{ stroke: "#e3e7e3" }}
                      axisLine={{ stroke: "#e3e7e3" }}
                    />
                    <ReTooltip
                      formatter={(value) => [`${fmtMwh(value)} MWh`, "Potencial"]}
                      labelFormatter={(value) => `Município: ${value}`}
                      contentStyle={{
                        background: "#fff",
                        border: "1px solid #1d4a37",
                        borderRadius: 4,
                        color: "#1d4a37",
                        fontWeight: 500,
                      }}
                    />
                    <Bar
                      dataKey="energiaPotencialMwh"
                      radius={[0, 8, 8, 0]}
                      onClick={(entry) => setSelectedCityKey(entry?.payload?.key || null)}
                    >
                      {cityEnergyData.map((c) => (
                        <Cell key={c.key} fill={c.key === selectedCityKey ? "#d9661a" : "#2f6b4f"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="card glow energy-homes-input-card">
              <h3>Consumo residencial</h3>
              <p className="energy-homes-help">
                Consumo médio de uma residência, usado para converter energia em casas atendidas.
              </p>
              <div className="field">
                <label>Consumo da residência (kWh/mês)</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={residentialConsumptionKwhMonth}
                  onChange={(e) =>
                    setResidentialConsumptionKwhMonth(
                      Math.max(1, toNumber(e.target.value, DEFAULT_RESIDENTIAL_CONSUMPTION_KWH_MONTH))
                    )
                  }
                />
              </div>

              <div className="energy-home-summary">
                <span>Residências atendidas em {selectedYear} (gerador ativo)</span>
                <strong>{fmtInt(selectedYearHomes?.casasAtendidas || 0)}</strong>
              </div>
            </section>

            <section className="card glow energy-homes-chart-card">
              <h3>Residências atendidas por ano</h3>
              <p className="energy-homes-help">
                Energia gerada por ano pelos geradores em comparação, dividida pelo consumo de uma residência.
              </p>
              <div className="energy-homes-chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={homesChartData}
                    margin={
                      isMobile
                        ? { top: 12, right: 10, bottom: 22, left: 0 }
                        : { top: 12, right: 18, bottom: 12, left: 6 }
                    }
                  >
                    <defs>
                      {homesSeries.map((series) => (
                        <linearGradient key={series.id} id={`homes-${series.id}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={series.color} stopOpacity={0.32} />
                          <stop offset="100%" stopColor={series.color} stopOpacity={0.06} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid stroke="#e3e7e3" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="ano"
                      tickMargin={8}
                      interval={0}
                      ticks={homesTicks}
                      tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                      tickLine={{ stroke: "#e3e7e3" }}
                      axisLine={{ stroke: "#e3e7e3" }}
                    />
                    <YAxis
                      tickFormatter={fmtAxis}
                      width={isMobile ? 56 : 64}
                      tick={{ fill: "#4a5650", fontSize: isMobile ? 10 : 11 }}
                      tickLine={{ stroke: "#e3e7e3" }}
                      axisLine={{ stroke: "#e3e7e3" }}
                      domain={[0, "auto"]}
                    />
                    <Legend />
                    <ReTooltip
                      formatter={(value, name) => [`${fmtInt(value)} casas/ano`, name]}
                      labelFormatter={(label) => `Ano ${label}`}
                      contentStyle={{
                        background: "#fff",
                        border: "1px solid #1d4a37",
                        borderRadius: 4,
                        color: "#1d4a37",
                        fontWeight: 500,
                      }}
                    />
                    {homesSeries.map((series) => (
                      <Area
                        key={series.id}
                        type="linear"
                        dataKey={series.id}
                        name={series.nome}
                        stroke={series.color}
                        strokeWidth={2.4}
                        fill={`url(#homes-${series.id})`}
                        fillOpacity={1}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          </main>
        </>
      )}
    </div>
  );
}
