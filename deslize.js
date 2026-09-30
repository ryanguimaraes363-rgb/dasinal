/*
  Ônibus deslizando pela rota entre uma atualização e outra (Dá sinal).

  A posição estimada chega a cada ~10 s. Entre uma e outra, o marcador segue
  pela rota na velocidade do ônibus, por no máximo MAX_S segundos.

  Estimativa nova ATRÁS de onde o marcador já está (até RECUO_MAX_M): o marcador
  não volta para trás, mas FICA PARADO até a estimativa alcançá-lo. (Antes ele
  continuava andando a partir de onde estava, e o adiantamento não sumia nunca:
  o ônibus parecia mais rápido que o real.)

  Funções puras, usadas pelo app (app.js) e pelo teste testes/adiantamento.html:
    receber(anterior, o, agora, cfg) -> novo estado   (o: { s, velocidade, sentido, rota })
    posicao(estado, agora, cfg)      -> s exibido na rota
*/
(function (raiz) {
  "use strict";

  // PARA_NO_PONTO: o deslize não passa do próximo ponto de ônibus (o ônibus
  // costuma parar ali; se não parar, a próxima atualização o leva adiante).
  var PADRAO = { MAX_S: 10, RECUO_MAX_M: 150, CONGELAR: true, PARA_NO_PONTO: true };

  function util() { return raiz.DaSinalEstimador.util; }

  function sentidoNaRota(o) {
    if (o.rota && o.rota.circular) return 1;
    return o.sentido === "ida" ? 1 : o.sentido === "volta" ? -1 : 0;
  }

  function posicao(e, agora, cfg) {
    cfg = cfg || PADRAO;
    if (!e) return null;
    var dt = Math.min(Math.max(agora - e.t0, 0) / 1000, cfg.MAX_S);
    if (cfg.PARA_NO_PONTO) return util().projetarAdiante(e.rota, e.s, e.v, dt, { PROJECAO_PARA_NO_PONTO: true });
    var s = e.s + e.v * dt;
    return e.rota.circular ? util().normalizarS(e.rota, s) : Math.max(0, Math.min(e.rota.total, s));
  }

  // Parado, sem sentido conhecido ou sem rota: v = 0 (o marcador fica na estimativa).
  function receber(anterior, o, agora, cfg) {
    cfg = cfg || PADRAO;
    var dir = sentidoNaRota(o);
    var v = dir && o.velocidade >= 1 ? o.velocidade * dir : 0;
    var novo = { rota: o.rota, s: o.s, v: v, t0: agora };
    if (anterior && anterior.rota === o.rota && dir) {
      var exibido = posicao(anterior, agora, cfg);
      var afrente = util().difS(o.rota, exibido, o.s) * dir; // > 0: estimativa à frente do marcador
      if (afrente < 0 && afrente > -cfg.RECUO_MAX_M) {
        novo.s = exibido;
        if (cfg.CONGELAR) novo.v = 0; // espera a estimativa alcançar
      }
    }
    return novo;
  }

  raiz.DaSinalDeslize = { PADRAO: PADRAO, receber: receber, posicao: posicao, sentidoNaRota: sentidoNaRota };
})(typeof globalThis !== "undefined" ? globalThis : this);
