// Formatação comum aos gráficos (pt-BR).

const compactFmt = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const decimalFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

// Eixos: 150000 → "150 mil", 2500000 → "2,5 mi".
export function fmtAxis(n) {
  const v = Number(n) || 0;
  return Math.abs(v) < 10000 ? decimalFmt.format(v) : compactFmt.format(v);
}

// Valores completos (tooltips e tabelas): 139023.5 → "139.023,5".
export function fmtNumber(n, digits = 1) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(n) || 0);
}

// Anos exibidos no eixo X: múltiplos de 5 (ou 10 se a série for longa), sempre
// incluindo o primeiro e o último ano para deixar claro o intervalo.
export function yearTicks(years, maxTicks = 14) {
  if (!years.length) return [];
  const first = years[0];
  const last = years[years.length - 1];
  const span = last - first;
  const step = [1, 2, 5, 10, 20].find((s) => span / s <= maxTicks) || 20;
  const ticks = years.filter((y) => y % step === 0);
  if (ticks[0] !== first) {
    if (ticks.length && ticks[0] - first <= step / 2) ticks.shift();
    ticks.unshift(first);
  }
  if (ticks[ticks.length - 1] !== last) {
    if (ticks.length > 1 && last - ticks[ticks.length - 1] <= step / 2) ticks.pop();
    ticks.push(last);
  }
  return ticks;
}

// t CH4 → m³ CH4 (densidade 0,7168 kg/m³ a 0 °C, 1 atm), unidade usada nos textos da pesquisa.
export const M3_PER_TON_CH4 = 1 / 0.0007168;
