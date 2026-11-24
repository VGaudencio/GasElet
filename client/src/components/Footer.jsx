import "../styles/Footer.css";

// Brasão da UFPB rasterizado do vetor "Ufpb brasao.svg" (Teo Gab, Wikimedia Commons, CC BY-SA 4.0).
const BRASAO_CREDITO = "Brasão da UFPB: vetor de Teo Gab (Wikimedia Commons, CC BY-SA 4.0)";

export default function Footer() {
  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <div className="app-footer-brand">
          <img src="/gaselet.svg" alt="" width="34" height="34" />
          <div>
            <p className="app-footer-name">GasElet</p>
            <p className="app-footer-text">
              Potencial de geração de energia elétrica do biogás de aterros sanitários, a partir de dados
              públicos de população e resíduos.
            </p>
          </div>
        </div>

        <span className="app-footer-divider" aria-hidden="true" />

        <a
          className="app-footer-org"
          href="https://www.ufpb.br"
          target="_blank"
          rel="noreferrer"
          title="Universidade Federal da Paraíba"
        >
          <img
            src="/ufpb/brasao-ufpb.png"
            width="39"
            height="56"
            alt="Brasão da Universidade Federal da Paraíba (UFPB)"
            title={BRASAO_CREDITO}
          />
          <span>
            <span className="app-footer-small">Desenvolvida no</span>
            <span className="app-footer-lab">Laboratório de Microengenharia</span>
            <span className="app-footer-small">
              Centro de Energias Alternativas e Renováveis (CEAR)
              <br />
              Universidade Federal da Paraíba
            </span>
          </span>
        </a>

        <span className="app-footer-divider" aria-hidden="true" />

        <p className="app-footer-meta">
          Fontes: IBGE, SNIS, IPCC 2006 e OpenStreetMap
          <br />© {new Date().getFullYear()} GasElet
        </p>
      </div>
    </footer>
  );
}
