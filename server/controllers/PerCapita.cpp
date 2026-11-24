#include "PerCapita.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <mutex>
#include <unordered_map>

namespace percapita {
namespace {

    // dg/dt = r·g·(1 − g/K), g(kT0) = G0 (kg/hab. atendido/ano).
    struct Logistica {
        double G0;
        double r;
        double K;
    };

    constexpr int kT0 = 2016;
    constexpr int kAnoMin = 2000;
    constexpr int kAnoMax = 2065;
    constexpr double kPasso = 0.25;

    // Curvas ajustadas ao SNIS (analise_sinis/scripts/ajuste_logistico.py).
    // <gerado:snis-logistica>
    // Gerado por analise_sinis/scripts/gerar_codigo.py; não editar à mão.
    const std::unordered_map<std::string, Logistica> kSnisRegioes = {
        {"Norte", {373.7393, 0.241240, 378.0063}},
        {"Nordeste", {401.7360, 0.066203, 480.8620}},
        {"Centro-Oeste", {371.8836, 0.028528, 301.1545}},
        {"Sudeste", {334.3888, 0.064939, 357.8092}},
        {"Sul", {282.9122, 0.122282, 301.4844}},
    };

    // UFs com dados confiáveis: curva da região reescalada para o nível da UF.
    // As demais UFs usam a curva da região.
    const std::unordered_map<std::string, Logistica> kSnisUfs = {
        {"AM", {409.9861, 0.241240, 414.6670}},
        {"BA", {357.0170, 0.066203, 427.3352}},
        {"ES", {303.3497, 0.064939, 324.5962}},
        {"GO", {348.6701, 0.028528, 282.3560}},
        {"MG", {282.0278, 0.064939, 301.7808}},
        {"MT", {350.1953, 0.028528, 283.5912}},
        {"PA", {371.8850, 0.241240, 376.1309}},
        {"PB", {361.8676, 0.066203, 433.1412}},
        {"PR", {288.3263, 0.122282, 307.2539}},
        {"RJ", {426.7107, 0.064939, 456.5973}},
        {"RN", {374.7900, 0.066203, 448.6087}},
        {"RS", {273.1240, 0.122282, 291.0536}},
        {"SC", {282.6566, 0.122282, 301.2120}},
        {"SE", {397.6553, 0.066203, 475.9775}},
        {"SP", {317.3009, 0.064939, 339.5245}},
    };
    // </gerado:snis-logistica>

    const std::unordered_map<std::string, std::string> kUfRegiao = {
        {"AC", "Norte"}, {"AM", "Norte"}, {"AP", "Norte"}, {"PA", "Norte"},
        {"RO", "Norte"}, {"RR", "Norte"}, {"TO", "Norte"},
        {"AL", "Nordeste"}, {"BA", "Nordeste"}, {"CE", "Nordeste"}, {"MA", "Nordeste"},
        {"PB", "Nordeste"}, {"PE", "Nordeste"}, {"PI", "Nordeste"}, {"RN", "Nordeste"},
        {"SE", "Nordeste"},
        {"DF", "Centro-Oeste"}, {"GO", "Centro-Oeste"}, {"MS", "Centro-Oeste"},
        {"MT", "Centro-Oeste"},
        {"ES", "Sudeste"}, {"MG", "Sudeste"}, {"RJ", "Sudeste"}, {"SP", "Sudeste"},
        {"PR", "Sul"}, {"RS", "Sul"}, {"SC", "Sul"},
    };

    std::string normalizarUf(const std::string& uf)
    {
        std::string out;
        for (const char ch : uf) {
            if (!std::isspace(static_cast<unsigned char>(ch))) {
                out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(ch))));
            }
        }
        return out;
    }

    // Integra por RK4 de kT0 até o ano (para frente ou para trás); fora de
    // kAnoMin–kAnoMax o valor fica constante no extremo.
    double logisticaRk4(const Logistica& p, int ano)
    {
        const int t = std::clamp(ano, kAnoMin, kAnoMax);
        const int n = static_cast<int>(std::lround(std::abs(t - kT0) / kPasso));
        if (n == 0) return p.G0;
        const double h = static_cast<double>(t - kT0) / n;
        const auto f = [&p](double x) { return p.r * x * (1.0 - x / p.K); };
        double g = p.G0;
        for (int i = 0; i < n; ++i) {
            const double k1 = f(g);
            const double k2 = f(g + 0.5 * h * k1);
            const double k3 = f(g + 0.5 * h * k2);
            const double k4 = f(g + h * k3);
            g += h / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        }
        return g;
    }

    double snisCached(const std::string& chave, const Logistica& p, int ano)
    {
        static std::mutex mtx;
        static std::unordered_map<std::string, double> cache;
        const std::string key = chave + "|" + std::to_string(std::clamp(ano, kAnoMin, kAnoMax));
        std::lock_guard<std::mutex> lock(mtx);
        const auto it = cache.find(key);
        if (it != cache.end()) return it->second;
        const double g = logisticaRk4(p, ano);
        cache.emplace(key, g);
        return g;
    }

}  // namespace

std::string regiaoDaUf(const std::string& uf)
{
    const auto it = kUfRegiao.find(normalizarUf(uf));
    return it != kUfRegiao.end() ? it->second : std::string();
}

double kgAnoHab(const std::string& uf,
                const std::string& regiao,
                int ano,
                double fallbackKgAnoHab)
{
    const std::string sigla = normalizarUf(uf);
    const auto itUf = kSnisUfs.find(sigla);
    if (itUf != kSnisUfs.end()) return snisCached(sigla, itUf->second, ano);

    const std::string regiaoUf = regiaoDaUf(sigla);
    const std::string& reg = regiaoUf.empty() ? regiao : regiaoUf;
    const auto itReg = kSnisRegioes.find(reg);
    if (itReg == kSnisRegioes.end()) return fallbackKgAnoHab;
    return snisCached(reg, itReg->second, ano);
}

}  // namespace percapita
