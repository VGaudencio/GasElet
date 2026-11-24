#pragma once
#include <string>

// Geração per capita de RSU (kg/hab/ano). Espelhado em client/src/utils/rsuProduction.js.
namespace percapita {

enum class Metodo {
    Snis,         // curvas logísticas do SNIS 2003–2021, integradas por RK4 (padrão)
    Abrelpe2020,  // reta regional do Panorama ABRELPE 2020 (legado)
};

Metodo metodoFromString(const std::string& value);
const char* metodoName(Metodo metodo);

// Região da UF ("PB" -> "Nordeste"); vazio se a sigla não for reconhecida.
std::string regiaoDaUf(const std::string& uf);

// SNIS: curva da UF quando os dados do estado são confiáveis, senão a da região da UF;
// sem UF reconhecida, a da região informada. ABRELPE 2020: só a região.
// Se nenhuma curva se aplicar, devolve fallbackKgAnoHab.
double kgAnoHab(Metodo metodo,
                const std::string& uf,
                const std::string& regiao,
                int ano,
                double fallbackKgAnoHab);

}  // namespace percapita
