/*
  Simulador de passageiros (Dá sinal) — dados FICTÍCIOS.

  Gera as localizações que celulares reais mandariam, com ruído de GPS,
  para testar o estimador e para o modo demonstração. Nenhum dado real.

  Atores:
    adicionarOnibus({ s0, passageiros })   ônibus que para nos pontos, com N passageiros dentro
    adicionarAtor({ tipo: "carro" })       segue a rota mais rápido e sem parar nos pontos
    adicionarAtor({ tipo: "pe" })          anda na calçada da rota a ~5 km/h
    adicionarAtor({ tipo: "parado" })      apertou "Estou neste ônibus" parado perto da rota
    adicionarAtor({ tipo: "fora" })        longe da rota
    desembarcar(viagemId, t)               passageiro desce e se afasta a pé

  Tudo é determinístico (mesma semente = mesmas amostras), para os testes
  darem sempre o mesmo resultado.
*/
(function (raiz, fabrica) {
  var E = raiz.DaSinalEstimador || (typeof require === "function" ? require("./estimador.js") : null);
  var api = fabrica(E);
  if (typeof module === "object" && module.exports) module.exports = api;
  raiz.DaSinalSimPassageiros = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (E) {
  "use strict";

  var U = E.util;

  function gerador(semente) {
    var a = semente | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(aleatorio) {
    var u = Math.max(aleatorio(), 1e-9), v = aleatorio();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // opcoes: { rota (DaSinalEstimador.prepararRota), semente, inicio (ms), duracaoMs }
  function criar(opcoes) {
    var rota = opcoes.rota;
    var T = rota.total;
    var t0 = opcoes.inicio || 0;
    var duracao = opcoes.duracaoMs || 3600000;
    var semente = opcoes.semente || 1;
    var paradasS = (rota.paradas || []).map(function (p) { return U.projetar(rota, p[0], p[1]).s; });
    var moveis = {};
    var listaOnibus = [];
    var atores = [];
    var cache = null;
    var seq = 0;

    // Posição ao longo da rota, segundo a segundo.
    function linhaDoTempo(s0, sentido, vel, paradaMs, paraNosPontos) {
      var n = Math.ceil(duracao / 1000) + 2;
      var S = [], V = [];
      var s = U.normalizarS(rota, s0), dir = sentido, espera = 0, ultimaParada = -1;
      for (var k = 0; k < n; k++) {
        S.push(s);
        V.push(espera > 0 || vel === 0 ? 0 : dir * vel);
        if (espera > 0) { espera--; continue; }
        if (vel === 0) continue;
        var prox = s + dir * vel;
        if (paraNosPontos) {
          for (var i = 0; i < paradasS.length; i++) {
            if (i === ultimaParada) continue;
            var dist = rota.circular ? (((paradasS[i] - s) * dir) % T + T) % T : (paradasS[i] - s) * dir;
            if (dist > 0 && dist <= vel) {
              prox = paradasS[i];
              espera = Math.round(paradaMs / 1000);
              ultimaParada = i;
              break;
            }
          }
        }
        if (rota.circular) prox = ((prox % T) + T) % T;
        else if (prox >= T) { prox = T; dir = -1; espera = 30; ultimaParada = -1; }
        else if (prox <= 0) { prox = 0; dir = 1; espera = 30; ultimaParada = -1; }
        s = prox;
      }
      return { S: S, V: V, sentido: sentido };
    }

    function estadoEm(movel, t) {
      var x = Math.max(0, (t - t0) / 1000);
      var k = Math.min(Math.floor(x), movel.S.length - 2);
      var f = Math.min(x - k, 1);
      var s = U.normalizarS(rota, movel.S[k] + f * U.difS(rota, movel.S[k], movel.S[k + 1]));
      var v = movel.V[k];
      return { s: s, v: v, sentido: v > 0 ? 1 : v < 0 ? -1 : movel.sentido };
    }

    function novoMovel(s0, sentido, vel, paradaMs, paraNosPontos) {
      var id = "movel-" + (++seq);
      moveis[id] = linhaDoTempo(s0, sentido || 1, vel, paradaMs, paraNosPontos);
      return id;
    }

    function novoAtor(movel, o, lateral) {
      var id = "viagem-" + (++seq);
      atores.push({
        id: id, movel: movel, lateral: lateral,
        precisao: o.precisao || [6, 20],
        intervalo: o.intervalo || 10000,
        inicio: t0 + (o.inicioMs || 0),
        desembarque: null
      });
      cache = null;
      return id;
    }

    function gerar() {
      var aleatorio = gerador(semente);
      var lista = [];
      atores.forEach(function (a) {
        var t = a.inicio + aleatorio() * a.intervalo;
        while (t <= t0 + duracao) {
          lista.push(amostra(a, Math.round(t), aleatorio));
          t += a.intervalo * (0.9 + 0.2 * aleatorio());
        }
      });
      return lista.sort(function (x, y) { return x.t - y.t; });
    }

    function amostra(a, t, aleatorio) {
      var movel = moveis[a.movel];
      var e = estadoEm(movel, t);
      var s = e.s, velocidade = Math.abs(e.v), lateral = a.lateral;
      var rumo = (U.rumoEm(rota, s) + (e.sentido === -1 ? 180 : 0)) % 360;
      if (a.desembarque != null && t >= a.desembarque) {
        // Desceu: fica onde o ônibus estava e se afasta da rua a pé.
        s = estadoEm(movel, a.desembarque).s;
        lateral = a.lateral + 1.4 * (t - a.desembarque) / 1000;
        velocidade = 1.4;
        rumo = (U.rumoEm(rota, s) + 90) % 360;
      }
      var normal = (U.rumoEm(rota, s) + 90) * Math.PI / 180;
      var pos = U.deslocar(U.posicaoEm(rota, s), Math.cos(normal) * lateral, Math.sin(normal) * lateral);
      var precisao = a.precisao[0] + aleatorio() * (a.precisao[1] - a.precisao[0]);
      pos = U.deslocar(pos, gauss(aleatorio) * precisao / 2, gauss(aleatorio) * precisao / 2);
      return {
        viagem_id: a.id,
        lat: pos[0],
        lng: pos[1],
        precisao: Math.round(precisao * 10) / 10,
        velocidade: Math.max(0, Math.round((velocidade + gauss(aleatorio) * 0.3) * 10) / 10),
        direcao: velocidade > 1 ? Math.round(((rumo + gauss(aleatorio) * 8) % 360 + 360) % 360) : null,
        t: t
      };
    }

    return {
      rota: rota,
      paradasS: paradasS,

      // o: { s0, sentido (1|-1), velocidade (m/s), paradaMs, passageiros, precisao: [min,max], intervalo }
      adicionarOnibus: function (o) {
        var movel = novoMovel(o.s0 || 0, o.sentido || 1, o.velocidade != null ? o.velocidade : 8,
          o.paradaMs != null ? o.paradaMs : 20000, true);
        var viagens = [];
        for (var i = 0; i < (o.passageiros || 1); i++) viagens.push(novoAtor(movel, o, (i % 3) - 1));
        listaOnibus.push(movel);
        return { id: movel, viagens: viagens };
      },

      // o: { tipo: "carro" | "pe" | "parado" | "fora", s0, sentido, velocidade, afastamentoM, precisao, intervalo }
      adicionarAtor: function (o) {
        var vel = o.velocidade != null ? o.velocidade
          : o.tipo === "carro" ? 12 : o.tipo === "pe" ? 1.4 : 0;
        var lateral = o.afastamentoM != null ? o.afastamentoM
          : o.tipo === "pe" ? 8 : o.tipo === "fora" ? 250 : o.tipo === "parado" ? 5 : 0;
        return novoAtor(novoMovel(o.s0 || 0, o.sentido || 1, vel, 0, false), o, lateral);
      },

      desembarcar: function (viagemId, t) {
        atores.forEach(function (a) { if (a.id === viagemId) a.desembarque = t; });
        cache = null;
      },

      // Amostras com desde <= t <= ate.
      amostras: function (desde, ate) {
        if (!cache) cache = gerar();
        return cache.filter(function (a) { return a.t >= desde && a.t <= ate; });
      },

      // Posição verdadeira do ônibus (para medir o erro da estimativa).
      posicaoOnibus: function (movelId, t) {
        var e = estadoEm(moveis[movelId], t);
        var p = U.posicaoEm(rota, e.s);
        return { s: e.s, lat: p[0], lng: p[1], velocidade: Math.abs(e.v) };
      },

      // Uma leitura de GPS avulsa de alguém dentro do ônibus, no instante t,
      // no formato de navigator.geolocation (demonstração: "estou neste ônibus"
      // sem sair do computador).
      leituraGps: function (movelId, t) {
        var aleatorio = gerador(semente ^ Math.floor(t / 1000));
        var a = { movel: movelId, lateral: 0, precisao: [5, 15], desembarque: null, id: "gps" };
        var x = amostra(a, t, aleatorio);
        return {
          timestamp: t,
          coords: { latitude: x.lat, longitude: x.lng, accuracy: x.precisao, speed: x.velocidade, heading: x.direcao }
        };
      },

      // Ônibus simulados (para escolher em qual "embarcar" na demonstração).
      onibus: function () { return listaOnibus.slice(); }
    };
  }

  return { criar: criar };
});
