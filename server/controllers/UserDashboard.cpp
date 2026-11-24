#include "UserDashboard.h"
#include "PerCapita.h"
#include <drogon/drogon.h>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <unordered_map>

using namespace drogon;

namespace {
    constexpr int kDefaultAnoInicial = 2000;
    constexpr int kDefaultAnoFinal = 2060;

    constexpr double kDefaultTaxaColetaPct = 100.0;
    constexpr double kDefaultGeracaoKgAnoHab = 328.3;
    constexpr double kDefaultKMetano = 0.05;
    constexpr double kDefaultCaptacaoBiogasPct = 100.0;

    constexpr double kDocf = 0.5;
    constexpr double kMethaneFraction = 0.5;
    constexpr double kTonPerM3Methane = 0.0007168;  // t CH4 / m3 CH4 (0 °C, 1 atm)

    // DOC de metal, vidro e "outros": o IPCC 2006 (Vol. 5, Tab. 2.4) trata essas
    // frações como inertes (DOC = 0). O 0,01 da versão anterior só vale no método legado.
    constexpr double kDocInertesIpcc = 0.0;
    constexpr double kDocInertesLegado = 0.01;

    // Discretização anual do decaimento de primeira ordem (FOD).
    // Espelhado em client/src/utils/landfillModel.js (FOD_METHODS).
    enum class FodMethod {
        Ipcc2000,  // GPG 2000, Eq. 5.1 (fator A = (1 - e^-k)/k); padrão
        Ipcc2006,  // IPCC 2006: atraso de 6 meses, decompõe a partir do ano seguinte
        Legado,    // até out/2026: k·M·L0·e^-k(t-x), sem normalização
    };

    struct Composition {
        double papel = 17.1;
        double organica = 44.9;
        double plastico = 10.8;
        double texteis = 2.6;
        double madeira = 4.7;
        double metal = 2.9;
        double vidro = 3.3;
        double borracha = 0.7;
        double outros = 13.0;
    };

    std::filesystem::path userJsonPath(const std::string& username)
    {
        std::filesystem::path base = "Dados/users";
        std::filesystem::create_directories(base);
        return base / (username + ".json");
    }

    double parseJsonNumber(const Json::Value& value, double fallback = 0.0)
    {
        if (value.isDouble() || value.isInt() || value.isUInt() || value.isInt64() || value.isUInt64())
        {
            return value.asDouble();
        }

        if (value.isString())
        {
            auto s = value.asString();
            std::replace(s.begin(), s.end(), ',', '.');
            try
            {
                size_t pos = 0;
                const double v = std::stod(s, &pos);
                if (pos > 0) return v;
            }
            catch (...) {}
        }

        return fallback;
    }

    int parseJsonInt(const Json::Value& value, int fallback = 0)
    {
        if (value.isInt() || value.isUInt() || value.isInt64() || value.isUInt64())
        {
            return value.asInt();
        }

        if (value.isDouble())
        {
            return static_cast<int>(std::llround(value.asDouble()));
        }

        if (value.isString())
        {
            auto s = value.asString();
            std::replace(s.begin(), s.end(), ',', '.');
            try
            {
                size_t pos = 0;
                const double v = std::stod(s, &pos);
                if (pos > 0) return static_cast<int>(std::llround(v));
            }
            catch (...) {}
        }

        return fallback;
    }

    Json::Value loadUserDashboard(const std::string& username)
    {
        auto path = userJsonPath(username);
        if (!std::filesystem::exists(path))
        {
            Json::Value root;
            root["username"] = username;
            root["name"] = username;
            root["role"] = "Operador";
            root["scenarios"] = Json::arrayValue;
            return root;
        }

        std::ifstream ifs(path);
        Json::Value root;
        ifs >> root;
        return root;
    }

    void saveUserDashboardJson(const std::string& username,
                               const Json::Value& root)
    {
        auto path = userJsonPath(username);
        std::ofstream ofs(path);
        ofs << root;
    }

    Json::Value mergeDashboardPayload(const std::string& username,
                                      const Json::Value& incoming,
                                      const Json::Value& existing)
    {
        Json::Value merged = existing.isObject() ? existing : Json::Value(Json::objectValue);

        merged["username"] = username;

        if (incoming.isMember("name")) {
            merged["name"] = incoming["name"];
        }

        if (incoming.isMember("role")) {
            merged["role"] = incoming["role"];
        }

        if (incoming.isMember("scenarios") && incoming["scenarios"].isArray()) {
            merged["scenarios"] = incoming["scenarios"];
        }

        if (incoming.isMember("rsuByScenario") && incoming["rsuByScenario"].isObject()) {
            merged["rsuByScenario"] = incoming["rsuByScenario"];
        }

        if (incoming.isMember("currentScenarioId")) {
            merged["currentScenarioId"] = incoming["currentScenarioId"];
        }

        return merged;
    }

    // Parâmetros da massa anual de RSU (espelha calcRsuTonAno em client/src/utils/rsuProduction.js).
    struct RsuParams {
        percapita::Metodo metodo = percapita::Metodo::Snis;
        std::string regiao;            // usada quando o município não tem UF e no método legado
        double taxaColetaPct = kDefaultTaxaColetaPct;
        double perCapFallback = kDefaultGeracaoKgAnoHab;
    };

    RsuParams parseRsuParams(const Json::Value& config)
    {
        RsuParams p;
        p.metodo = percapita::metodoFromString(config.get("metodoPerCapita", "").asString());
        p.regiao = config.get("regiao", "Nordeste").asString();
        p.taxaColetaPct = parseJsonNumber(config["taxaColetaPct"], kDefaultTaxaColetaPct);
        p.perCapFallback = parseJsonNumber(config["geracaoKgAnoHab"], kDefaultGeracaoKgAnoHab);
        return p;
    }

    double perCapKgAnoHab(const RsuParams& p, const std::string& uf, int ano)
    {
        return percapita::kgAnoHab(p.metodo, uf, p.regiao, ano, p.perCapFallback);
    }

    double calcRsuTonAno(const RsuParams& p, double perCapita, double populacao)
    {
        const double coleta = p.taxaColetaPct / 100.0;
        return coleta * perCapita * populacao / 1000.0;
    }

    // Soma dos municípios do cenário em um ano, cada um com a per capita da sua UF.
    struct ScenarioYear {
        bool found = false;      // algum município tem o ano na série
        double pop = 0.0;
        double residuo = 0.0;    // t/ano
        double perCapita = 0.0;  // kg/hab/ano, média ponderada pela população
    };

    ScenarioYear scenarioYear(const Json::Value& rows, const RsuParams& p, int year)
    {
        ScenarioYear out;
        if (!rows.isArray()) return out;

        const auto yearKey = std::to_string(year);
        double perCapPop = 0.0;
        for (const auto& row : rows) {
            if (!row.isObject()) continue;
            const auto& series = row["series"];
            if (!series.isObject() || !series.isMember(yearKey)) continue;

            const double pop = parseJsonNumber(series[yearKey], 0.0);
            const double g = perCapKgAnoHab(p, row.get("uf", "").asString(), year);
            out.found = true;
            out.pop += pop;
            out.residuo += calcRsuTonAno(p, g, pop);
            perCapPop += g * pop;
        }
        out.perCapita = out.pop > 0.0 ? perCapPop / out.pop : perCapKgAnoHab(p, "", year);
        return out;
    }

    Composition parseComposition(const Json::Value& config)
    {
        Composition c;
        const auto& raw = config["composicao"];
        if (!raw.isObject()) return c;

        c.papel = parseJsonNumber(raw["papel"], c.papel);
        c.organica = parseJsonNumber(raw["organica"], c.organica);
        c.plastico = parseJsonNumber(raw["plastico"], c.plastico);
        c.texteis = parseJsonNumber(raw["texteis"], c.texteis);
        c.madeira = parseJsonNumber(raw["madeira"], c.madeira);
        c.metal = parseJsonNumber(raw["metal"], c.metal);
        c.vidro = parseJsonNumber(raw["vidro"], c.vidro);
        c.borracha = parseJsonNumber(raw["borracha"], c.borracha);
        c.outros = parseJsonNumber(raw["outros"], c.outros);
        return c;
    }

    double resolveMCF(const Json::Value& config)
    {
        if (config.isMember("mcf"))
        {
            const double mcf = parseJsonNumber(config["mcf"], 1.0);
            return std::max(0.0, mcf);
        }

        // MCF (IPCC 2006, Vol. 5, Tab. 3.1). "Parcial" e "Não gerenciado" são
        // rótulos antigos, mantidos para cenários já salvos.
        const std::string gerenciamento = config.get("gerenciamento", "").asString();
        if (gerenciamento == "Não gerenciado - profundo (>=5 m)" || gerenciamento == "Parcial") return 0.8;
        if (gerenciamento == "Não gerenciado - raso (<5 m)" ||
            gerenciamento == "Não gerenciado" || gerenciamento == "Nao gerenciado") return 0.4;
        if (gerenciamento == "Não categorizado") return 0.6;
        return 1.0;
    }

    FodMethod fodMethodFromString(const std::string& value)
    {
        if (value == "ipcc2006") return FodMethod::Ipcc2006;
        if (value == "legado") return FodMethod::Legado;
        return FodMethod::Ipcc2000;
    }

    const char* fodMethodName(FodMethod metodo)
    {
        switch (metodo) {
            case FodMethod::Ipcc2006: return "ipcc2006";
            case FodMethod::Legado: return "legado";
            case FodMethod::Ipcc2000: break;
        }
        return "ipcc2000";
    }

    FodMethod resolveFodMethod(const Json::Value& config)
    {
        return fodMethodFromString(config.get("metodoFod", "").asString());
    }

    double docInertesFor(FodMethod metodo)
    {
        return metodo == FodMethod::Legado ? kDocInertesLegado : kDocInertesIpcc;
    }

    // DOC padrão por fração (IPCC 2006, Vol. 5, Tab. 2.4, base úmida).
    double computeDoc(const Composition& c, double docInertes)
    {
        return
            (c.papel / 100.0) * 0.40 +
            (c.organica / 100.0) * 0.15 +
            (c.plastico / 100.0) * 0.00 +
            (c.texteis / 100.0) * 0.24 +
            (c.madeira / 100.0) * 0.43 +
            (c.borracha / 100.0) * 0.39 +
            ((c.metal / 100.0) + (c.vidro / 100.0) + (c.outros / 100.0)) * docInertes;
    }

    double computeLoTonPerTon(const Composition& c, double mcf, double docInertes)
    {
        const double doc = computeDoc(c, docInertes);
        return mcf * doc * kDocf * kMethaneFraction * (16.0 / 12.0);
    }

    // Metano gerado por ano (t CH4/ano). Cada lote M(x) contribui com
    //   M(x) · L0 · f · e^(-k (t - x - atraso)),   t >= x + atraso,
    // em que f é a fração do lote que decompõe no primeiro ano de reação:
    //   - IPCC 2000 e 2006: f = 1 - e^-k, logo a soma no tempo é exatamente L0 · M(x);
    //   - legado: f = k, que soma k/(1 - e^-k) · L0 · M(x) (+2,5% com k = 0,05).
    // O IPCC 2006 (atraso de 6 meses, M = 13 na planilha) só começa no ano seguinte.
    std::map<int, double> computeMethaneByYear(const std::map<int, double>& residueByYear,
                                               int anoInicial,
                                               int anoFinal,
                                               int maxYear,
                                               double kMetano,
                                               double loTonPerTon,
                                               FodMethod metodo)
    {
        std::map<int, double> out;
        if (anoFinal < anoInicial) anoFinal = anoInicial;
        if (maxYear < anoFinal) maxYear = anoFinal;

        for (int year = anoInicial; year <= maxYear; ++year)
        {
            out[year] = 0.0;
        }

        if (!(kMetano > 0.0)) return out;

        const double firstYearFraction =
            (metodo == FodMethod::Legado) ? kMetano : -std::expm1(-kMetano);
        const int atraso = (metodo == FodMethod::Ipcc2006) ? 1 : 0;

        for (int year = anoInicial; year <= anoFinal; ++year)
        {
            const auto it = residueByYear.find(year);
            const double residue = (it != residueByYear.end()) ? it->second : 0.0;

            for (int targetYear = year + atraso; targetYear <= maxYear; ++targetYear)
            {
                const double generated =
                    residue * loTonPerTon * firstYearFraction *
                    std::exp(-kMetano * static_cast<double>(targetYear - year - atraso));
                out[targetYear] += generated;
            }
        }

        return out;
    }

    Json::Value toYearObject(const std::map<int, double>& values,
                             int fromYear,
                             int toYear)
    {
        Json::Value out(Json::objectValue);
        for (int year = fromYear; year <= toYear; ++year)
        {
            const auto it = values.find(year);
            out[std::to_string(year)] = (it != values.end()) ? it->second : 0.0;
        }
        return out;
    }

    Json::Value computeRsuSeries(const Json::Value& config,
                                 const Json::Value& scenarioRows)
    {
        int vidaInicio = parseJsonInt(config["vidaInicio"], kDefaultAnoInicial);
        int vidaFim = parseJsonInt(config["vidaFim"], kDefaultAnoFinal);
        if (vidaFim < vidaInicio) vidaFim = vidaInicio;

        const RsuParams params = parseRsuParams(config);
        const double popBase = parseJsonNumber(config["popBase"], 0.0);
        const double growthPct = parseJsonNumber(config["popCrescimentoAnualPct"], 0.0);
        const double growth = growthPct / 100.0;

        Json::Value rows(Json::arrayValue);
        for (int i = 0, year = vidaInicio; year <= vidaFim; ++year, ++i) {
            const ScenarioYear sy = scenarioYear(scenarioRows, params, year);
            double pop = sy.pop;
            double rsuTAno = sy.residuo;
            double perCapita = sy.perCapita;
            if (!sy.found) {
                pop = popBase * std::pow(1.0 + growth, i);
                perCapita = perCapKgAnoHab(params, "", year);
                rsuTAno = calcRsuTonAno(params, perCapita, pop);
            }

            Json::Value row;
            row["ano"] = year;
            row["pop"] = pop;
            row["rsuTAno"] = rsuTAno;
            row["perCapita"] = perCapita;
            row["source"] = sy.found ? "scenario" : "model";
            rows.append(row);
        }

        return rows;
    }

    Json::Value computeLandfillCalculation(const Json::Value& config,
                                           const Json::Value& rows,
                                           int anoInicial,
                                           int anoFinal,
                                           int maxYear)
    {
        if (anoFinal < anoInicial) anoFinal = anoInicial;
        if (maxYear < anoFinal) maxYear = anoFinal;

        const RsuParams params = parseRsuParams(config);
        const double popBase = parseJsonNumber(config["popBase"], 0.0);
        const double growthPct = parseJsonNumber(config["popCrescimentoAnualPct"], 0.0);
        const double growth = growthPct / 100.0;
        const double kMetano = std::max(0.0, parseJsonNumber(config["kMetano"], kDefaultKMetano));
        const double captacao = std::clamp(
            parseJsonNumber(config["captacaoBiogasPct"], kDefaultCaptacaoBiogasPct), 0.0, 100.0) / 100.0;

        const FodMethod metodoFod = resolveFodMethod(config);
        const double docInertes = docInertesFor(metodoFod);
        const Composition comp = parseComposition(config);
        const double mcf = resolveMCF(config);
        const double doc = computeDoc(comp, docInertes);
        const double loTonPerTon = computeLoTonPerTon(comp, mcf, docInertes);
        const double loM3PerTon = (kTonPerM3Methane > 0.0) ? (loTonPerTon / kTonPerM3Methane) : 0.0;

        std::map<int, double> totalResidueByYear;

        Json::Value totalRows(Json::arrayValue);
        for (int i = 0, year = anoInicial; year <= maxYear; ++year, ++i)
        {
            const ScenarioYear sy = scenarioYear(rows, params, year);
            const bool fromScenario = sy.found && sy.pop > 0.0;
            const double pop = fromScenario ? sy.pop : (popBase * std::pow(1.0 + growth, i));
            const double perCapita = fromScenario ? sy.perCapita : perCapKgAnoHab(params, "", year);
            const bool aterroAberto = year <= anoFinal;
            double residue = 0.0;
            if (aterroAberto) {
                residue = fromScenario ? sy.residuo : calcRsuTonAno(params, perCapita, pop);
            }
            totalResidueByYear[year] = residue;

            Json::Value rowOut;
            rowOut["ano"] = year;
            rowOut["pop"] = pop;
            rowOut["perCapita"] = perCapita;
            rowOut["residuoTAno"] = residue;
            if (!aterroAberto) {
                rowOut["source"] = "closed";
            } else {
                rowOut["source"] = fromScenario ? "scenario" : "model";
            }
            totalRows.append(rowOut);
        }

        const auto totalMethaneByYear = computeMethaneByYear(
            totalResidueByYear,
            anoInicial,
            anoFinal,
            maxYear,
            kMetano,
            loTonPerTon,
            metodoFod);

        for (Json::ArrayIndex i = 0; i < totalRows.size(); ++i)
        {
            const int year = totalRows[i]["ano"].asInt();
            auto it = totalMethaneByYear.find(year);
            const double metano = (it != totalMethaneByYear.end()) ? it->second : 0.0;
            totalRows[i]["metanoTAno"] = metano;
            totalRows[i]["metanoRecuperadoTAno"] = metano * captacao;
        }

        Json::Value cities(Json::arrayValue);
        for (const auto& city : rows)
        {
            const std::string uf = city.get("uf", "").asString();
            const std::string nome = city.get("nome", "").asString();
            if (uf.empty() || nome.empty()) continue;

            const std::string key = uf + "::" + nome;
            const auto& series = city["series"];
            if (!series.isObject()) continue;

            std::map<int, double> cityResidueByYear;
            Json::Value cityRows(Json::arrayValue);

            for (int year = anoInicial; year <= maxYear; ++year)
            {
                const auto yearKey = std::to_string(year);
                const double pop = parseJsonNumber(series[yearKey], 0.0);
                const double perCapita = perCapKgAnoHab(params, uf, year);
                const bool aterroAberto = year <= anoFinal;
                const double residue = aterroAberto ? calcRsuTonAno(params, perCapita, pop) : 0.0;
                cityResidueByYear[year] = residue;

                Json::Value rowOut;
                rowOut["ano"] = year;
                rowOut["pop"] = pop;
                rowOut["perCapita"] = perCapita;
                rowOut["residuoTAno"] = residue;
                rowOut["source"] = aterroAberto ? "scenario" : "closed";
                cityRows.append(rowOut);
            }

            const auto cityMethaneByYear = computeMethaneByYear(
                cityResidueByYear,
                anoInicial,
                anoFinal,
                maxYear,
                kMetano,
                loTonPerTon,
                metodoFod);

            for (Json::ArrayIndex i = 0; i < cityRows.size(); ++i)
            {
                const int year = cityRows[i]["ano"].asInt();
                auto it = cityMethaneByYear.find(year);
                const double metano = (it != cityMethaneByYear.end()) ? it->second : 0.0;
                cityRows[i]["metanoTAno"] = metano;
                cityRows[i]["metanoRecuperadoTAno"] = metano * captacao;
            }

            Json::Value cityOut;
            cityOut["key"] = key;
            cityOut["uf"] = uf;
            cityOut["nome"] = nome;
            cityOut["rows"] = cityRows;
            cityOut["methaneByYear"] = toYearObject(cityMethaneByYear, anoInicial, maxYear);
            cities.append(cityOut);
        }

        Json::Value out(Json::objectValue);
        out["anoInicial"] = anoInicial;
        out["anoFinal"] = anoFinal;
        out["maxYear"] = maxYear;
        out["kMetano"] = kMetano;
        out["metodoFod"] = fodMethodName(metodoFod);
        out["metodoPerCapita"] = percapita::metodoName(params.metodo);
        out["doc"] = doc;
        out["mcf"] = mcf;
        out["captacaoBiogasPct"] = captacao * 100.0;
        out["loTonPerTon"] = loTonPerTon;
        out["loM3PerTon"] = loM3PerTon;
        out["total"]["rows"] = totalRows;
        out["total"]["methaneByYear"] = toYearObject(totalMethaneByYear, anoInicial, maxYear);
        out["cities"] = cities;
        return out;
    }

    void applyRsuEquation(Json::Value& root)
    {
        const auto& scenarios = root["scenarios"];
        auto& rsuByScenario = root["rsuByScenario"];
        if (!scenarios.isArray() || !rsuByScenario.isObject()) return;

        std::unordered_map<std::string, Json::Value> rowsByScenario;
        for (const auto& scenario : scenarios) {
            const std::string id = scenario.get("id", "").asString();
            if (id.empty()) continue;
            rowsByScenario[id] = scenario["rows"];
        }

        const Json::Value emptyRows(Json::arrayValue);

        for (const auto& id : rsuByScenario.getMemberNames()) {
            auto& entry = rsuByScenario[id];
            const auto& config = entry["config"];
            if (!config.isObject()) continue;

            const auto rowsIt = rowsByScenario.find(id);
            const auto& scenarioRows = (rowsIt != rowsByScenario.end()) ? rowsIt->second : emptyRows;
            entry["series"] = computeRsuSeries(config, scenarioRows);

            const int anoInicial = parseJsonInt(config["vidaInicio"], kDefaultAnoInicial);
            const int anoFinal = parseJsonInt(config["vidaFim"], kDefaultAnoFinal);

            entry["landfillCalc"] = computeLandfillCalculation(
                config,
                scenarioRows,
                anoInicial,
                std::max(anoInicial, anoFinal),
                std::max(anoInicial, kDefaultAnoFinal));
        }
    }
}

void UserDashboard::getDashboard(const HttpRequestPtr& req,
                                 std::function<void (const HttpResponsePtr&)>&& cb)
{
    try {
        const auto &username = req->attributes()->get<std::string>("username");

        auto data = loadUserDashboard(username);
        applyRsuEquation(data);
        auto resp = HttpResponse::newHttpJsonResponse(data);
        cb(resp);
    } catch (const std::exception& e) {
        LOG_ERROR << "UserDashboard::getDashboard erro: " << e.what();
        auto resp = HttpResponse::newHttpResponse();
        resp->setStatusCode(k500InternalServerError);
        resp->setBody("Erro ao carregar dashboard do usuário");
        cb(resp);
    }
}

void UserDashboard::saveDashboard(const HttpRequestPtr& req,
                                  std::function<void (const HttpResponsePtr&)>&& cb)
{
    try {
        const auto &username = req->attributes()->get<std::string>("username");

        auto jsonOpt = req->getJsonObject();
        if (!jsonOpt) {
            auto resp = HttpResponse::newHttpResponse();
            resp->setStatusCode(k400BadRequest);
            resp->setBody("JSON inválido");
            return cb(resp);
        }

        Json::Value incoming = *jsonOpt;
        const auto existing = loadUserDashboard(username);
        auto merged = mergeDashboardPayload(username, incoming, existing);
        applyRsuEquation(merged);

        saveUserDashboardJson(username, merged);

        Json::Value ok;
        ok["status"] = "ok";
        ok["message"] = "Dashboard salvo com sucesso";

        auto resp = HttpResponse::newHttpJsonResponse(ok);
        cb(resp);
    } catch (const std::exception& e) {
        LOG_ERROR << "UserDashboard::saveDashboard erro: " << e.what();
        auto resp = HttpResponse::newHttpResponse();
        resp->setStatusCode(k500InternalServerError);
        resp->setBody("Erro ao salvar dashboard do usuário");
        cb(resp);
    }
}

void UserDashboard::calculateLandfill(const HttpRequestPtr& req,
                                      std::function<void (const HttpResponsePtr&)>&& cb)
{
    try
    {
        auto jsonOpt = req->getJsonObject();
        if (!jsonOpt)
        {
            auto resp = HttpResponse::newHttpResponse();
            resp->setStatusCode(k400BadRequest);
            resp->setBody("JSON inválido");
            return cb(resp);
        }

        const Json::Value payload = *jsonOpt;
        const Json::Value config = payload["config"].isObject() ? payload["config"] : Json::Value(Json::objectValue);
        const Json::Value rows = payload["rows"].isArray() ? payload["rows"] : Json::Value(Json::arrayValue);

        const int anoInicial = parseJsonInt(
            payload["anoInicial"],
            parseJsonInt(config["vidaInicio"], kDefaultAnoInicial));
        const int anoFinal = parseJsonInt(
            payload["anoFinal"],
            parseJsonInt(config["vidaFim"], kDefaultAnoFinal));
        const int maxYear = parseJsonInt(payload["maxYear"], kDefaultAnoFinal);

        auto result = computeLandfillCalculation(
            config,
            rows,
            anoInicial,
            std::max(anoInicial, anoFinal),
            std::max(anoInicial, maxYear));
        result["status"] = "ok";

        auto resp = HttpResponse::newHttpJsonResponse(result);
        cb(resp);
    }
    catch (const std::exception& e)
    {
        LOG_ERROR << "UserDashboard::calculateLandfill erro: " << e.what();
        auto resp = HttpResponse::newHttpResponse();
        resp->setStatusCode(k500InternalServerError);
        resp->setBody("Erro ao calcular metano/LO no servidor");
        cb(resp);
    }
}
