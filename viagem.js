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
    // Nos primeiros 60 s de uma parada continua lendo como se estivesse andando:
    // é assim que o estimador vê que o ônibus PAROU NO PONTO (precisa de 2
    // leituras paradas). Só depois disso economiza bateria.
    PARADA_DETALHADA_MS: 60000,
    AMOSTRA_MIN_MS: 5000,
    DIST_NOVA_AMOSTRA_M: 50,
    VEL_MOVENDO_MS: 2,
    ENVIO_MOVENDO_MS: 20000,
    // Na rodovia (acima de ~54 km/h), envia mais vezes: em 20 s o ônibus anda 500 m.
    ENVIO_RAPIDO_MS: 10000,
    VEL_RAPIDO_MS: 15,
    ENVIO_PARADO_MS: 60000,
    LOTE_MAX: 6,
    FILA_MAX: 20,
    FILA_IDADE_MAX_MS: 120000,
    SEM_GPS_MAX_MS: 180000,       // nenhuma posição do GPS por 3 min: encerra ("sem_sinal_gps")
    // Só posições imprecisas (pior que PRECISAO_MAX_M) por 10 min: encerra ("gps_impreciso").
    // Até lá a viagem continua e o app avisa o servidor que está vivo (lote vazio).
    GPS_IMPRECISO_MAX_MS: 600000,
    SINAL_DE_VIDA_MS: 30000,
    DURACAO_MAX_MS: 3 * 3600000,
    VERIFICAR_MS: 5000
  };
  // enableHighAccuracy ligado: sem ele o celular usa antena/Wi-Fi (centenas de metros).
  var OPCOES_GPS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
  var NOME_ERRO_GPS = { 1: "PERMISSION_DENIED", 2: "POSITION_UNAVAILABLE", 3: "TIMEOUT" };
  function logGps() { if (S.gps) S.gps.log.apply(null, arguments); }

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

  // O que o GPS está fazendo, separado em três situações (e mais duas de erro):
  //   "procurando"   nenhuma posição ainda (ou o GPS demorou: TIMEOUT)
  //   "indisponivel" o celular disse que não consegue localizar (GPS desligado?)
  //   "impreciso"    há posições, mas piores que PRECISAO_MAX_M: descartadas
  //   "ok"           posições boas sendo aceitas
  function estadoGps(s) {
    if (s.simulada) return "ok";
    if (!s.ultimaLeitura) return s.ultimoErro === 2 ? "indisponivel" : "procurando";
    if (!s.ultimaFix || s.ultimaLeitura - s.ultimaFix > 15000) return "impreciso";
    return "ok";
  }

  // Só contagens, para o servidor (010) e o painel ?diag=1. Nunca coordenadas.
  function resumoDiag(s) {
    var d = s.diag;
    return {
      lidas: d.lidas, aceitas: d.aceitas, imprecisas: d.imprecisas,
      melhorPrecisao: d.melhorPrecisao, ultimaPrecisao: d.ultimaPrecisao,
      primeiraPosicaoS: d.primeiraPosicaoMs == null ? null : Math.round(d.primeiraPosicaoMs / 1000),
      erros: d.erros, estado: estadoGps(s),
      navegadorEmbutido: d.navegadorEmbutido, https: d.https, telaLigada: !!(s.wake && !s.wake.released)
    };
  }

  function publico() {
    if (!st) return null;
    return {
      viagemId: st.viagemId,
      linhaId: st.linhaId,
      linhaNumero: st.linhaNumero,
      inicio: st.inicio,
      situacao: st.situacao,
      onibus: st.onibus,
      estadoGps: estadoGps(st),
      precisao: st.diag.ultimaPrecisao,
      gpsFraco: estadoGps(st) === "impreciso",
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
    var antes = estadoGps(st);
    var d0 = st.diag;
    d0.lidas++;
    d0.ultimaPrecisao = Math.round(c.accuracy);
    if (d0.melhorPrecisao == null || c.accuracy < d0.melhorPrecisao) d0.melhorPrecisao = Math.round(c.accuracy);
    if (d0.primeiraPosicaoMs == null) d0.primeiraPosicaoMs = Date.now() - st.inicio;
    st.ultimaLeitura = Date.now();
    logGps("posição (viagem) lat", c.latitude, "lng", c.longitude, "precisão", Math.round(c.accuracy) + " m",
      "horário", new Date(t).toISOString(), c.accuracy <= P.PRECISAO_MAX_M ? "ACEITA" : "DESCARTADA (imprecisa)");
    // Posição com precisão ruim: não serve para estimar o ônibus. Não é enviada,
    // mas conta como "o GPS está funcionando" (a tela mostra "GPS impreciso").
    if (!(c.accuracy <= P.PRECISAO_MAX_M)) {
      d0.imprecisas++;
      if (estadoGps(st) !== antes) notificar({ tipo: "situacao" });
      return;
    }
    d0.aceitas++;
    st.ultimaFix = Date.now();
    var mudou = estadoGps(st) !== antes;

    var velocidade = c.speed != null && !isNaN(c.speed) ? c.speed : null;
    var direcao = c.heading != null && !isNaN(c.heading) && velocidade != null && velocidade > 0.5 ? c.heading : null;
    var ultima = st.ultimaGuardada;
    var dt = ultima ? t - ultima.t : Infinity;
    var d = ultima ? S.util.distanciaM([ultima.lat, ultima.lng], [c.latitude, c.longitude]) : Infinity;

    var vAgora = velocidade != null ? velocidade : (ultima && dt > 0 ? d / (dt / 1000) : null);
    if (vAgora != null) {
      st.movendo = vAgora >= P.VEL_MOVENDO_MS;
      st.rapido = vAgora >= P.VEL_RAPIDO_MS;
    }
    if (st.movendo) st.paradoDesde = null;
    else if (st.paradoDesde == null) st.paradoDesde = t;
    st.detalhado = st.movendo || t - st.paradoDesde < P.PARADA_DETALHADA_MS;

    var guardar = !ultima || (st.detalhado
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
    var code = err ? err.code : 0;
    st.diag.erros[code] = (st.diag.erros[code] || 0) + 1;
    logGps("erro (viagem)", code, NOME_ERRO_GPS[code] || "", err && err.message);
    if (code === 1) { finalizar("permissao_negada", true); return; }
    // 2 (indisponível) ou 3 (demorou): o watchPosition continua tentando;
    // verificar() encerra se passar do limite.
    var antes = estadoGps(st);
    st.ultimoErro = code;
    if (estadoGps(st) !== antes) notificar({ tipo: "situacao" });
  }

  function tentarEnviar() {
    // Sem viagemId: o GPS já começou, mas o servidor ainda não criou a viagem.
    if (!st || st.enviando || !st.viagemId) return;
    var agora = Date.now();
    st.fila = st.fila.filter(function (a) { return agora - a.t <= P.FILA_IDADE_MAX_MS; });
    if (st.fila.length > P.FILA_MAX) st.fila = st.fila.slice(-P.FILA_MAX);
    if (navigator.onLine === false) return;
    var lote;
    if (st.fila.length) {
      var intervalo = st.rapido ? P.ENVIO_RAPIDO_MS : st.detalhado !== false ? P.ENVIO_MOVENDO_MS : P.ENVIO_PARADO_MS;
      if (st.ultimoEnvio && st.fila.length < P.LOTE_MAX && agora - st.ultimoEnvio < intervalo) return;
      lote = st.fila.splice(0, P.LOTE_MAX);
    } else {
      // "Ainda estou aqui": o GPS está respondendo (mesmo que impreciso), mas não há
      // posição boa para mandar. Sem isso o servidor encerraria por inatividade.
      var vivo = st.ultimaLeitura && agora - st.ultimaLeitura < 60000;
      if (!vivo || (st.ultimoEnvio && agora - st.ultimoEnvio < P.SINAL_DE_VIDA_MS)) return;
      lote = [];
    }

    var id = st.viagemId;
    st.enviando = true;
    backend().enviar(id, lote, resumoDiag(st)).then(function (resp) {
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
    // Nenhuma posição (nem imprecisa) há 3 min: o GPS não está respondendo.
    if (agora - (st.ultimaLeitura || st.inicio) > P.SEM_GPS_MAX_MS) { finalizar("sem_sinal_gps", true); return; }
    // Há posições, mas só imprecisas há 10 min: não dá para ajudar a mostrar o ônibus.
    if (agora - (st.ultimaFix || st.inicio) > P.GPS_IMPRECISO_MAX_MS) { finalizar("gps_impreciso", true); return; }
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
    v.fimMotivo = motivo;
    if (v.watchId != null && v.fonte) v.fonte.clearWatch(v.watchId);
    logGps("viagem encerrada:", motivo, "| diagnóstico:", JSON.stringify(resumoDiag(v)));
    clearInterval(v.timer);
    if (v.cancelarAcompanhamento) v.cancelarAcompanhamento();
    if (v.wake) { try { v.wake.release(); } catch (e) { /* já liberado */ } }
    gravarLocal(CHAVE_VIAGEM, null);
    // O que ainda estava na fila é descartado: a pessoa já saiu da viagem.
    // Sem viagemId (terminou antes de o servidor responder): iniciar() encerra lá.
    if (avisarServidor && v.viagemId) {
      // Manda antes o diagnóstico final (só contagens), para ficar registrado também
      // quando o GPS nunca deu posição (erros 2/3).
      var b = backend();
      b.enviar(v.viagemId, [], resumoDiag(v)).catch(function () {}).then(function () {
        return b.encerrar(v.viagemId, motivo);
      }).catch(function () { /* o servidor encerra por inatividade */ });
    }
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

  function novoEstado(linha, fonte, simulada) {
    return {
      viagemId: null, linhaId: linha.id, linhaNumero: linha.numero, inicio: Date.now(),
      fila: [], ultimaGuardada: null, ultimaFix: null, ultimaLeitura: null, ultimoErro: null,
      ultimoEnvio: 0, enviando: false, enviadas: 0,
      movendo: true, situacao: null, onibus: null,
      fonte: fonte, simulada: simulada, watchId: null, timer: null, cancelarAcompanhamento: null, wake: null,
      diag: {
        lidas: 0, aceitas: 0, imprecisas: 0, melhorPrecisao: null, ultimaPrecisao: null, primeiraPosicaoMs: null,
        erros: {}, https: window.isSecureContext !== false,
        navegadorEmbutido: (S.gps && S.gps.navegadorEmbutido()) || null
      }
    };
  }

  // A viagem existe no servidor e o GPS está ligado: começa a acompanhar e enviar.
  function comecar(b, linha) {
    st.timer = setInterval(verificar, P.VERIFICAR_MS);
    st.cancelarAcompanhamento = b.acompanhar(st.viagemId, aoSituacao);
    manterTelaLigada();
    gravarLocal(CHAVE_VIAGEM, { linhaId: linha.id, linhaNumero: linha.numero, inicio: st.inicio });
    notificar({ tipo: "inicio" });
    tentarEnviar(); // o que o GPS já mandou enquanto esperava o servidor
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
      var usarSimulado = opcoes.simularGps && window.DaSinalColaborativo.gpsDemonstracao;
      logGps("Estou neste ônibus: linha", linha.numero, "| suporte:", !!navigator.geolocation, "| https:", window.isSecureContext,
        "| navegador de aplicativo:", (S.gps && S.gps.navegadorEmbutido()) || "não");
      if (S.gps) S.gps.estadoPermissao().then(function (s) { logGps("permissão (informativo):", s); });

      // GPS de verdade: liga JÁ, no mesmo toque, antes de esperar o servidor criar a
      // viagem (1–3 s, mais na rede do ônibus). O pedido de permissão fica ligado ao
      // toque e a primeira posição chega antes. As leituras esperam na fila.
      var antecipado = null;
      if (!usarSimulado) {
        if (!navigator.geolocation) { fim(); return Promise.reject({ codigo: "sem_suporte" }); }
        if (window.isSecureContext === false) { fim(); return Promise.reject({ codigo: "sem_https" }); }
        antecipado = st = novoEstado(linha, navigator.geolocation, false);
        st.watchId = navigator.geolocation.watchPosition(aoPosicao, aoErro, OPCOES_GPS);
        logGps("watchPosition chamado (viagem), id", st.watchId, "opções", JSON.stringify(OPCOES_GPS));
      }

      return b.iniciar(linha, { versaoConsentimento: VERSAO_CONSENTIMENTO }).then(function (r) {
        if (antecipado) {
          // Terminou enquanto esperava o servidor (ex.: permissão negada): encerra lá também.
          if (st !== antecipado) {
            b.encerrar(r.viagemId, antecipado.fimMotivo || "usuario").catch(function () {});
            throw { codigo: antecipado.fimMotivo === "permissao_negada" ? "permissao_negada" : "cancelada" };
          }
          st.viagemId = r.viagemId;
          return comecar(b, linha);
        }
        return window.DaSinalColaborativo.gpsDemonstracao(linha).then(function (gpsSimulado) {
          var fonte = gpsSimulado || navigator.geolocation;
          if (!fonte) { b.encerrar(r.viagemId, "sem_suporte"); throw { codigo: "sem_suporte" }; }
          st = novoEstado(linha, fonte, !!gpsSimulado);
          st.viagemId = r.viagemId;
          st.watchId = fonte.watchPosition(aoPosicao, aoErro, OPCOES_GPS);
          return comecar(b, linha);
        });
      }, function (e) {
        // O servidor não criou a viagem: desliga o GPS que já estava ligado.
        if (antecipado && st === antecipado) {
          if (st.watchId != null) navigator.geolocation.clearWatch(st.watchId);
          st = null;
          notificar({ tipo: "cancelada" });
        }
        throw e;
      }).then(fim, function (e) { fim(); throw e; });
    },

    // Contagens do GPS da viagem atual, para o painel ?diag=1.
    diag: function () { return st ? resumoDiag(st) : null; },

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
