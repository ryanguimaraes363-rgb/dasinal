/*
  Roteamento por ruas (Dá sinal).

  Recebe os pontos de uma linha, na ordem em que o ônibus passa por eles
  (origem, pontos de parada, destino) e devolve a geometria real das ruas
  entre eles, usando o servidor público de demonstração do projeto OSRM
  (Open Source Routing Machine).

  IMPORTANTE: o servidor público do OSRM (router.project-osrm.org) é de
  demonstração, sem garantia de disponibilidade e sem uso indicado para
  produção. Para lançar o app de verdade, troque SERVIDOR_OSRM por um
  servidor próprio do OSRM ou por um provedor pago (Mapbox, Google,
  OpenRouteService etc.) — veja o LEIA-ME.md.

  Se o servidor não responder, cada função devolve o próprio traçado reto
  entre os pontos (fonte: "reta"), para o app continuar funcionando.
*/
window.DaSinalRotas = (function () {
  "use strict";

  var SERVIDOR_OSRM = "https://router.project-osrm.org";
  var CHAVE_CACHE = "da-sinal-rotas-cache-v1";
  var cache = null;
  var emAndamento = {};

  function lerCache() {
    if (cache) return cache;
    try { cache = JSON.parse(window.localStorage.getItem(CHAVE_CACHE) || "{}"); }
    catch (e) { cache = {}; }
    return cache;
  }

  function salvarCache() {
    try { window.localStorage.setItem(CHAVE_CACHE, JSON.stringify(cache)); }
    catch (e) { /* sem armazenamento disponível: segue só com o cache em memória */ }
  }

  // Chave estável para os pontos de uma linha (arredonda para não duplicar
  // por causas de ruído de ponto flutuante).
  function chaveDosPontos(pontos) {
    return pontos.map(function (p) { return p[0].toFixed(5) + "," + p[1].toFixed(5); }).join(";");
  }

  function paraOsrm(pontos) {
    // O OSRM espera "longitude,latitude", ao contrário da convenção lat/lng do app.
    return pontos.map(function (p) { return p[1] + "," + p[0]; }).join(";");
  }

  function deOsrm(coordenadas) {
    return coordenadas.map(function (c) { return [c[1], c[0]]; });
  }

  /*
    pontos: [[lat, lng], ...] na ordem do percurso (mínimo 2).
    devolve Promise<{ pontos: [[lat,lng], ...], fonte: "osrm" | "reta" }>.
  */
  function obterRota(pontos) {
    if (!pontos || pontos.length < 2) return Promise.resolve({ pontos: pontos || [], fonte: "reta" });

    var chave = chaveDosPontos(pontos);
    var c = lerCache();
    if (c[chave]) return Promise.resolve(c[chave]);
    if (emAndamento[chave]) return emAndamento[chave];

    if (typeof fetch !== "function") return Promise.resolve({ pontos: pontos, fonte: "reta" });

    var url = SERVIDOR_OSRM + "/route/v1/driving/" + paraOsrm(pontos) + "?overview=full&geometries=geojson";

    var pedido;
    try {
      pedido = fetch(url);
    } catch (e) {
      return Promise.resolve({ pontos: pontos, fonte: "reta" });
    }
    pedido = pedido.then(function (resp) {
      if (!resp.ok) throw new Error("osrm-http-" + resp.status);
      return resp.json();
    }).then(function (json) {
      if (json.code !== "Ok" || !json.routes || !json.routes[0] || !json.routes[0].geometry) {
        throw new Error("osrm-sem-rota");
      }
      var resultado = { pontos: deOsrm(json.routes[0].geometry.coordinates), fonte: "osrm" };
      c[chave] = resultado;
      salvarCache();
      return resultado;
    }).catch(function () {
      return { pontos: pontos, fonte: "reta" };
    }).then(function (r) {
      delete emAndamento[chave];
      return r;
    });

    emAndamento[chave] = pedido;
    return pedido;
  }

  return { obterRota: obterRota };
})();
