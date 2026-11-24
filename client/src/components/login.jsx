import React, { useState } from "react";
import "../styles/login.css";

// Curvas de nível de um maciço de aterro, desenhadas uma vez no carregamento do módulo.
const CONTORNOS = Array.from({ length: 11 }, (_, i) => {
  const cx = 860;
  const cy = 520;
  const base = 70 + i * 62;
  const pontos = Array.from({ length: 96 }, (_, k) => {
    const t = (k / 96) * Math.PI * 2;
    const r =
      base *
      (1 + 0.09 * Math.sin(3 * t + i * 0.35) + 0.05 * Math.cos(5 * t - i * 0.5) + 0.03 * Math.sin(7 * t + i));
    return `${(cx + r * Math.cos(t) * 1.35).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`;
  });
  return `M${pontos.join("L")}Z`;
});

export default function EcoLogin({ onSubmit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    const u = username.trim();
    const p = password;
    if (u.length < 3) return setError("Informe o usuário (pelo menos 3 caracteres).");
    if (p.length < 8) return setError("A senha tem pelo menos 8 caracteres.");
    try {
      setLoading(true);
      await onSubmit?.(u, p);
    } catch (err) {
      setError(err?.message ? `Não foi possível entrar: ${err.message}` : "Não foi possível entrar.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="eco-root">
      <svg className="eco-contours" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {CONTORNOS.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>

      <section className="eco-card" aria-label="Entrar">
        <header className="eco-brand">
          <img src="/gaselet.svg" alt="" className="eco-logo" />
          <div>
            <h1 className="eco-title">GasElet</h1>
            <p className="eco-sub">Potencial elétrico do biogás de aterros sanitários</p>
          </div>
        </header>

        <form className="eco-form" onSubmit={handleSubmit} noValidate>
          <label className="eco-field">
            <span>Usuário</span>
            <input
              className="eco-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={!!error && username.trim().length < 3}
              aria-describedby={error ? "eco-err" : undefined}
            />
          </label>

          <label className="eco-field">
            <span>Senha</span>
            <input
              className="eco-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error && password.length < 8}
              aria-describedby={error ? "eco-err" : undefined}
            />
          </label>

          {error && (
            <p id="eco-err" className="eco-error" role="alert">
              {error}
            </p>
          )}

          <button className="eco-btn" disabled={loading}>
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="eco-footer">Contas novas são criadas pelo administrador do servidor.</p>
      </section>

      <p className="eco-credit">Laboratório de Microengenharia do CEAR, Universidade Federal da Paraíba</p>
    </div>
  );
}
