import { useMemo } from "react";
import { useDashboard } from "../context/DashboardContext.jsx";
import { DEFAULT_ANO_FINAL, DEFAULT_ANO_INICIAL, normalizeLandfillConfig } from "../utils/landfillModel.js";
import { calcRsuTonAno, regiaoDaUf } from "../utils/rsuProduction.js";
import "../styles/ResumoAterro.css";

const fmtInt = (n) => Math.round(n).toLocaleString("pt-BR");

function fmtMassa(t) {
  if (!Number.isFinite(t) || t <= 0) return "—";
  if (t >= 1e6) return `${(t / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi t`;
  if (t >= 1e3) return `${fmtInt(t / 1e3)} mil t`;
  return `${fmtInt(t)} t`;
}

const semUf = (nome) => String(nome || "").replace(/\s*\([A-Z]{2}\)\s*$/, "");

function juntar(lista) {
  if (lista.length <= 1) return lista.join("");
  return `${lista.slice(0, -1).join(", ")} e ${lista[lista.length - 1]}`;
}

// Resumo do aterro do cenário atual, mostrado no topo de todas as telas.
// A massa é calculada como na tela de Resíduos: população de cada município × per capita
// da sua UF × taxa de coleta, somada nos anos de operação.
export default function ResumoAterro() {
  const { scenarios, currentScenarioId, rsuByScenario } = useDashboard();

  const resumo = useMemo(() => {
    const lista = Array.isArray(scenarios) ? scenarios : [];
    const cenario = lista.find((s) => String(s.id) === String(currentScenarioId)) || lista[0] || null;
    const rows = Array.isArray(cenario?.rows) ? cenario.rows : [];
    const entry = cenario ? rsuByScenario?.[cenario.id] : null;
    const cfg = normalizeLandfillConfig(entry?.config);
    const inicio = Math.min(cfg.vidaInicio, cfg.vidaFim);
    const fim = Math.max(cfg.vidaInicio, cfg.vidaFim);

    const anoAtual = new Date().getFullYear();
    const anoPop = Math.min(DEFAULT_ANO_FINAL, Math.max(DEFAULT_ANO_INICIAL, anoAtual));
    const popDe = (row, ano) => Number(row?.series?.[ano] ?? row?.series?.[String(ano)]) || 0;

    const populacao = rows.reduce((acc, r) => acc + popDe(r, anoPop), 0);
    const maior = rows.reduce((best, r) => (popDe(r, anoPop) > popDe(best, anoPop) ? r : best), rows[0]);

    let residuo = 0;
    if (rows.length) {
      for (let ano = inicio; ano <= fim; ano++) {
        for (const r of rows) {
          residuo += calcRsuTonAno({
            uf: r.uf,
            regiao: cfg.regiao,
            coletaPct: cfg.taxaColetaPct,
            ano,
            populacao: popDe(r, ano),
            fallbackKgAnoHab: cfg.geracaoKgAnoHab,
          });
        }
      }
    } else if (Array.isArray(entry?.series)) {
      residuo = entry.series.reduce((acc, r) => acc + (Number(r?.rsuTAno) || 0), 0);
    }

    const ufs = [...new Set(rows.map((r) => String(r.uf || "").toUpperCase()).filter(Boolean))].sort();
    const regioes = [...new Set(ufs.map(regiaoDaUf).filter(Boolean))];

    return {
      nome: cenario?.name || "Cenário",
      qtd: rows.length,
      maior: maior ? semUf(maior.nome) : null,
      regiao: regioes.length ? juntar(regioes) : cfg.regiao,
      ufs,
      populacao,
      anoPop,
      residuo,
      inicio,
      fim,
      anoAtual,
    };
  }, [scenarios, currentScenarioId, rsuByScenario]);

  // Linha do tempo: horizonte das projeções, com a operação do aterro destacada.
  const h0 = Math.min(DEFAULT_ANO_INICIAL, resumo.inicio);
  const h1 = Math.max(DEFAULT_ANO_FINAL, resumo.fim);
  const pos = (ano) => `${(((ano - h0) / (h1 - h0)) * 100).toFixed(2)}%`;
  const anos = resumo.fim - resumo.inicio + 1;
  const hojeNoHorizonte = resumo.anoAtual >= h0 && resumo.anoAtual <= h1;

  return (
    <section className="resumo-aterro" aria-label="Resumo do aterro">
      <div className="resumo-identidade">
        <span className="resumo-rotulo">Aterro do cenário</span>
        <p className="resumo-nome">{resumo.nome}</p>
        <p className="resumo-operacao">
          Recebe resíduo de {resumo.inicio} a {resumo.fim} ({anos} {anos === 1 ? "ano" : "anos"})
        </p>
        <div className="resumo-linha" role="img" aria-label={`Operação de ${resumo.inicio} a ${resumo.fim}, no horizonte de ${h0} a ${h1}`}>
          <div className="resumo-trilho">
            <span
              className="resumo-periodo"
              style={{ left: pos(resumo.inicio), width: `calc(${pos(resumo.fim + 1)} - ${pos(resumo.inicio)})` }}
            />
            {hojeNoHorizonte && (
              <span className="resumo-hoje" style={{ left: pos(resumo.anoAtual) }} title={`Hoje (${resumo.anoAtual})`} />
            )}
          </div>
          <div className="resumo-escala">
            <span>{h0}</span>
            {hojeNoHorizonte && (
              <span className="resumo-escala-hoje" style={{ left: pos(resumo.anoAtual) }}>
                hoje
              </span>
            )}
            <span>{h1}</span>
          </div>
        </div>
      </div>

      <dl className="resumo-dados">
        <div>
          <dt>Municípios</dt>
          <dd>{resumo.qtd}</dd>
          <dd className="resumo-contexto">
            {resumo.qtd === 0
              ? "adicione na tela Início"
              : resumo.qtd === 1
              ? resumo.maior
              : `${resumo.maior} e mais ${resumo.qtd - 1}`}
          </dd>
        </div>
        <div>
          <dt>Região</dt>
          <dd>{resumo.regiao}</dd>
          <dd className="resumo-contexto">{resumo.ufs.length ? juntar(resumo.ufs) : "sem municípios no cenário"}</dd>
        </div>
        <div>
          <dt>População</dt>
          <dd>{resumo.populacao > 0 ? fmtInt(resumo.populacao) : "—"}</dd>
          <dd className="resumo-contexto">dos municípios em {resumo.anoPop}</dd>
        </div>
        <div>
          <dt>Resíduo previsto</dt>
          <dd>{fmtMassa(resumo.residuo)}</dd>
          <dd className="resumo-contexto">
            coletado de {resumo.inicio} a {resumo.fim}
          </dd>
        </div>
      </dl>
    </section>
  );
}
