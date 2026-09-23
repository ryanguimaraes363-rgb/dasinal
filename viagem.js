/*
  "Estou neste ônibus": coleta de localização no celular (Dá sinal).

  Só começa depois de dois "sim": o consentimento específico (modal do app)
  e a permissão de localização do navegador. Para sozinha quando a pessoa
  toca em "Saí do ônibus" ou quando o servidor percebe que a viagem acabou
  (desceu, saiu da rota, ficou sem sinal, fim da linha).

  Economia de bateria e internet:
    - guarda uma amostra a cada 10 s andando (ou a cada 50 m) e a cada 30 s parado;
    - envia em lotes: a cada 20 s andando e a cada 60 s parado (a primeira vai na hora);
    - descarta leituras com precisão pior que 100 m;
    - sem internet, guarda até 20 amostras de no máximo 2 min e envia ao voltar.

  O que sai do celular: latitude, longitude, precisão, velocidade, direção,
  horário e o id ALEATÓRIO desta viagem. Nada de nome, aparelho ou conta.

  Interface: DaSinal.viagem (veja o final do arquivo).
*/
(function () {
  "use strict";

  var S = window.DaSinal;

  var P = {
    PRECISAO_MAX_M: 100,
    AMOSTRA_MOVENDO_MS: 10000,
    AMOSTRA_PARADO_MS: 30000,
    AMOSTRA_MIN_MS: 5000,
    DIST_NOVA_AMOSTRA_M: 50,
    VEL_MOVENDO_MS: 2,
    ENVIO_MOVENDO_MS: 20000,
    ENVIO_PARADO_MS: 60000,
    LOTE_MAX: 6,
    FILA_MAX: 20,
    FILA_IDADE_MAX_MS: 120000,
    SEM_GPS_MAX_MS: 180000,
    DURACAO_MAX_MS: 3 * 3600000,
    VERIFICAR_MS: 5000
  };

  var VERSAO_CONSENTIMENTO = "2026-09-23";
  var CHAVE_CONSENTIMENTO = "dasinal.consentimento.viagem";
  var CHAVE_VIAGEM = "dasinal.viagem";

  var st = null;       // viagem em andamento
  var iniciando = false;
  var ouvintes = [];

  function lerLocal(chave) {
    try { var v = window.localStorage.getItem(chave); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function gravarLocal(chave, valor) {
    try {
      if (valor == null) window.localStorage.removeItem(chave);
      else window.localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) { /* sem armazenamento */ }
  }

  function backend() { return window.DaSinalColaborativo && window.DaSinalColaborativo.viagens; }

  function publico() {
    if (!st) return null;
    return {
      viagemId: st.viagemId,
      linhaId: st.linhaId,
      linhaNumero: st.linhaNumero,
      inicio: st.inicio,
      situacao: st.situacao,
      onibus: st.onibus,
      gpsFraco: st.gpsFraco,
      semSinal: !st.ultimaFix,
      enviadas: st.enviadas,
      simulada: st.simulada
    };
  }

  function notificar(evento) {
    var p = publico();
    ouvintes.slice().forEach(function (cb) {
      try { cb(p, evento); } catch (e) { /* uma tela com erro não derruba as outras */ }
    });
  }

  // ---------- Tela ligada (o navegador pausa a localização com a tela apagada) ----------

  function manterTelaLigada() {
    if (!st || !navigator.wakeLock) return;
    var v = st;
    navigator.wakeLock.request("screen").then(function (w) {
      if (st === v) v.wake = w; else w.release();
    }, function () { /* sem suporte ou bateria baixa: segue sem */ });
  }

  document.addEventListener("visibilitychange", function () {
    if (st && document.visibilityState === "visible" && (!st.wake || st.wake.released)) manterTelaLigada();
  });

  // ---------- Coleta ----------

  function aoPosicao(p) {
    if (!st) return;
    var c = p.coords;
    var t = p.timestamp || Date.now();
    if (!(c.accuracy <= P.PRECISAO_MAX_M)) {
      if (!st.gpsFraco) { st.gpsFraco = true; notificar({ tipo: "situacao" }); }
      return;
    }
    var mudou = st.gpsFraco || !st.ultimaFix;
    st.gpsFraco = false;
    st.ultimaFix = t;

    var velocidade = c.speed != null && !isNaN(c.speed) ? c.speed : null;
    var direcao = c.heading != null && !isNaN(c.heading) && velocidade != null && velocidade > 0.5 ? c.heading : null;
    var ultima = st.ultimaGuardada;
    var dt = ultima ? t - ultima.t : Infinity;
    var d = ultima ? S.util.distanciaM([ultima.lat, ultima.lng], [c.latitude, c.longitude]) : Infinity;

    if (velocidade != null) st.movendo = velocidade >= P.VEL_MOVENDO_MS;
    else if (ultima && dt > 0) st.movendo = d / (dt / 1000) >= P.VEL_MOVENDO_MS;

    var guardar = !ultima || (st.movendo
      ? dt >= P.AMOSTRA_MOVENDO_MS || (d >= P.DIST_NOVA_AMOSTRA_M && dt >= P.AMOSTRA_MIN_MS)
      : dt >= P.AMOSTRA_PARADO_MS);
    if (guardar) {
      var a = {
        lat: Math.round(c.latitude * 1e6) / 1e6,
        lng: Math.round(c.longitude * 1e6) / 1e6,
        precisao: Math.round(c.accuracy * 10) / 10,
        velocidade: velocidade == null ? null : Math.round(velocidade * 10) / 10,
        direcao: direcao == null ? null : Math.round(direcao),
        t: t
      };
      st.fila.push(a);
      st.ultimaGuardada = a;
      tentarEnviar();
    }
    if (mudou) notificar({ tipo: "situacao" });
  }

  function aoErro(err) {
    if (!st) return;
    if (err && err.code === 1) { finalizar("permissao_negada", true); return; }
    // Sem sinal ou demora: continua tentando; verificar() encerra se passar do limite.
    if (!st.gpsFraco) { st.gpsFraco = true; notificar({ tipo: "situacao" }); }
  }

  function tentarEnviar() {
    if (!st || st.enviando || !st.fila.length) return;
    var agora = Date.now();
    st.fila = st.fila.filter(function (a) { return agora - a.t <= P.FILA_IDADE_MAX_MS; });
    if (st.fila.length > P.FILA_MAX) st.fila = st.fila.slice(-P.FILA_MAX);
    if (!st.fila.length || navigator.onLine === false) return;
    var intervalo = st.movendo ? P.ENVIO_MOVENDO_MS : P.ENVIO_PARADO_MS;
    if (st.ultimoEnvio && st.fila.length < P.LOTE_MAX && agora - st.ultimoEnvio < intervalo) return;

    var lote = st.fila.splice(0, P.LOTE_MAX);
    var id = st.viagemId;
    st.enviando = true;
    backend().enviar(id, lote).then(function (resp) {
      if (!st || st.viagemId !== id) return;
      st.enviando = false;
      st.ultimoEnvio = Date.now();
      st.enviadas += lote.length;
      if (resp && resp.encerrada) { finalizar(resp.encerrada, false); return; }
      notificar({ tipo: "envio" });
    }, function () {
      // Falhou (sem rede): devolve para a fila e tenta no próximo ciclo.
      if (!st || st.viagemId !== id) return;
      st.enviando = false;
      st.fila = lote.concat(st.fila);
    });
  }

  function verificar() {
    if (!st) return;
    var agora = Date.now();
    if (agora - st.inicio > P.DURACAO_MAX_MS) { finalizar("tempo_max", true); return; }
    if (agora - (st.ultimaFix || st.inicio) > P.SEM_GPS_MAX_MS) { finalizar("sem_sinal_gps", true); return; }
    tentarEnviar();
  }

  function aoSituacao(info) {
    if (!st) return;
    st.situacao = info.situacao;
    st.onibus = info.onibus;
    if (info.fim) { finalizar(info.fim, false); return; }
    notificar({ tipo: "situacao" });
  }

  function finalizar(motivo, avisarServidor) {
    if (!st) return;
    var v = st;
    st = null;
    if (v.watchId != null && v.fonte) v.fonte.clearWatch(v.watchId);
    clearInterval(v.timer);
    if (v.cancelarAcompanhamento) v.cancelarAcompanhamento();
    if (v.wake) { try { v.wake.release(); } catch (e) { /* já liberado */ } }
    gravarLocal(CHAVE_VIAGEM, null);
    // O que ainda estava na fila é descartado: a pessoa já saiu da viagem.
    if (avisarServidor) backend().encerrar(v.viagemId, motivo).catch(function () { /* o servidor encerra por inatividade */ });
    ouvintes.slice().forEach(function (cb) {
      try {
        cb(null, {
          tipo: "fim", motivo: motivo, viagemId: v.viagemId, linhaId: v.linhaId, linhaNumero: v.linhaNumero,
          inicio: v.inicio, duracaoMs: Date.now() - v.inicio, enviadas: v.enviadas,
          validada: !!(v.situacao && v.situacao.validada),
          // Última situação calculada pelo estimador (segundos válidos, maior grupo...).
          situacao: v.situacao
        });
      } catch (e) { /* segue */ }
    });
  }

  // ---------- Interface pública ----------

  S.viagem = {
    // A funcionalidade está ligada e o navegador tem como obter localização?
    disponivel: function () {
      return !!(S.posicao.colaborativa && backend() && (navigator.geolocation || window.DaSinalColaborativo.simulando()));
    },
    ativa: function () { return !!st; },
    atual: publico,

    consentimentoAceito: function () {
      var c = lerLocal(CHAVE_CONSENTIMENTO);
      return !!(c && c.versao === VERSAO_CONSENTIMENTO);
    },
    registrarConsentimento: function () {
      gravarLocal(CHAVE_CONSENTIMENTO, { versao: VERSAO_CONSENTIMENTO, aceitoEm: new Date().toISOString() });
    },
    revogarConsentimento: function () {
      gravarLocal(CHAVE_CONSENTIMENTO, null);
      if (st) finalizar("consentimento_revogado", true);
      return backend().revogarConsentimento().catch(function () { /* sem rede: o servidor encerra por inatividade */ });
    },

    // Direito de exclusão (LGPD): encerra a viagem e apaga viagens, consentimentos e perfil.
    excluirMeusDados: function () {
      if (st) finalizar("consentimento_revogado", false);
      gravarLocal(CHAVE_CONSENTIMENTO, null);
      return backend().excluirMeusDados();
    },

    // opcoes.simularGps: usa o GPS simulado da demonstração em vez do real.
    // Resolve quando a coleta começou (a permissão do navegador ainda pode ser negada depois).
    iniciar: function (linha, opcoes) {
      opcoes = opcoes || {};
      if (st || iniciando) return Promise.reject({ codigo: "ja_ativa" });
      if (!S.viagem.disponivel()) return Promise.reject({ codigo: "sem_suporte" });
      if (!S.viagem.consentimentoAceito()) return Promise.reject({ codigo: "sem_consentimento" });
      var b = backend();
      iniciando = true;
      var fim = function (x) { iniciando = false; return x; };
      return b.iniciar(linha, { versaoConsentimento: VERSAO_CONSENTIMENTO }).then(function (r) {
        var usarSimulado = opcoes.simularGps && window.DaSinalColaborativo.gpsDemonstracao;
        return (usarSimulado ? window.DaSinalColaborativo.gpsDemonstracao(linha) : Promise.resolve(null)).then(function (gpsSimulado) {
          var fonte = gpsSimulado || navigator.geolocation;
          if (!fonte) { b.encerrar(r.viagemId, "sem_suporte"); throw { codigo: "sem_suporte" }; }
          st = {
            viagemId: r.viagemId, linhaId: linha.id, linhaNumero: linha.numero, inicio: Date.now(),
            fila: [], ultimaGuardada: null, ultimaFix: null, ultimoEnvio: 0, enviando: false, enviadas: 0,
            movendo: true, gpsFraco: false, situacao: null, onibus: null,
            fonte: fonte, simulada: !!gpsSimulado, watchId: null, timer: null, cancelarAcompanhamento: null, wake: null
          };
          st.watchId = fonte.watchPosition(aoPosicao, aoErro, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
          st.timer = setInterval(verificar, P.VERIFICAR_MS);
          st.cancelarAcompanhamento = b.acompanhar(st.viagemId, aoSituacao);
          manterTelaLigada();
          gravarLocal(CHAVE_VIAGEM, { linhaId: linha.id, linhaNumero: linha.numero, inicio: st.inicio });
          notificar({ tipo: "inicio" });
        });
      }).then(fim, function (e) { fim(); throw e; });
    },

    // motivo: "usuario" (tocou em "Saí do ônibus") ou outro motivo do app.
    encerrar: function (motivo) { finalizar(motivo || "usuario", true); },

    // cb(viagemAtualOuNull, evento). evento.tipo: "inicio" | "situacao" | "envio" | "fim".
    aoMudar: function (cb) {
      ouvintes.push(cb);
      return function () {
        var i = ouvintes.indexOf(cb);
        if (i >= 0) ouvintes.splice(i, 1);
      };
    },

    // Viagem que ficou aberta quando o app foi fechado. A coleta NÃO é
    // retomada sozinha: a pessoa decide se volta a compartilhar.
    interrompida: function () {
      var v = lerLocal(CHAVE_VIAGEM);
      gravarLocal(CHAVE_VIAGEM, null);
      return v && Date.now() - v.inicio < P.DURACAO_MAX_MS ? v : null;
    },

    parametros: P
  };
})();
