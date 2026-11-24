#pragma once
#include <string>

// Geração per capita de RSU (kg/hab/ano): curvas logísticas ajustadas ao SNIS 2003–2021,
// integradas por Runge-Kutta 4. Espelhado em client/src/utils/rsuProduction.js.
namespace percapita {

// Região da UF ("PB" -> "Nordeste"); vazio se a sigla não for reconhecida.
std::string regiaoDaUf(const std::string& uf);

// Curva da UF quando os dados do estado são confiáveis, senão a da região da UF;
// sem UF reconhecida, a da região informada. Se nenhuma curva se aplicar, devolve
// fallbackKgAnoHab.
double kgAnoHab(const std::string& uf,
                const std::string& regiao,
                int ano,
                double fallbackKgAnoHab);

}  // namespace percapita
