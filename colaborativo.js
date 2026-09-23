/*
  Posição colaborativa do ônibus: o lado "servidor" (Dá sinal).

  Recebe as localizações de quem tocou em "Estou neste ônibus", roda o
  estimador (estimador.js) a cada CICLO_ESTIMATIVA_MS e entrega às telas só
  a posição ESTIMADA de cada ônibus. Nenhuma tela recebe a localização de
  um passageiro.

  Dois modos, com a mesma interface:
    - demonstração: tudo roda no navegador. Uma "central" por linha junta os
      passageiros SIMULADOS (simulador-passageiros.js) e a sua própria viagem;
    - Supabase: o servidor estima (Edge Function estimar-onibus) e este arquivo
      só lê a tabela onibus_estimados e chama as RPCs de viagem.
  As telas (app.js) e a coleta no celular (viagem.js) não sabem qual está ativo.

  Interface usada pelo resto do app:
    assinar(linha, pontos, cb)      posição do ônibus (via DaSinal.posicao.assinar)
    statusPorLinha(linhas)          { linha_id: "em_movimento" | "parado" | "sem_sinal" }
    viagens.iniciar/enviar/encerrar/acompanhar   usado por viagem.js
    gpsDemonstracao(linha)          GPS simulado dentro de um ônibus (só demonstração)

  O callback de assinar recebe o ônibus principal (maior confiança) com os
  mesmos campos da posição simulada, mais:
    { indisponivel, confianca, score, qtdPassageiros, desatualizado, onibus: [todos] }
*/
window.DaSinalColaborativo = (function () {
  "use strict";

  var S = window.DaSinal;
  var CFG = S.config;
  var E = window.DaSinalEstimador;
  var Sim = window.DaSinalSimPassageiros;
  var CICLO_MS = CFG.CICLO_ESTIMATIVA_MS || 5000;
  var JANELA_MS = E.PADRAO.JANELA_MS;
  var AQUECIMENTO_MS = 180000;  // ao abrir, calcula os últimos 3 min para já ter histórico
  var DURACAO_SIM_MS = 6 * 3600000;

  var centrais = {};            // linha.id -> Promise<central>
  var centralDaViagem = {};     // viagemId -> central

  function simularPassageiros() {
    return S.modo === "demo" && CFG.DEMO_PASSAGEIROS_SIMULADOS !== false && !!Sim;
  }

  function novoId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // Pontos da linha com a posição "s" de cada um na rota, na ordem do percurso.
  function ordenarParadas(rota, pontos, circular) {
    var anterior = null;
    return (pontos || []).slice().sort(function (a, b) { return a.ordem - b.ordem; }).map(function (p) {
      var s = E.util.projetar(rota, p.latitude, p.longitude, circular ? anterior : null).s;
      anterior = s;
      return { id: p.id, nome: p.nome, s: s };
    }).sort(function (a, b) { return a.s - b.s; });
  }

  function proximoPonto(c, o) {
    var ps = c.paradas;
    if (!ps.length) return null;
    var s = o.s, alvo = null, dist, i, aproximado = false;
    if (c.rota.circular) {
      for (i = 0; i < ps.length; i++) { if (ps[i].s > s + 1) { alvo = ps[i]; break; } }
      if (alvo) dist = alvo.s - s;
      else { alvo = ps[0]; dist = c.rota.total - s + alvo.s; }
    } else if (o.sentido === "ida") {
      for (i = 0; i < ps.length; i++) { if (ps[i].s > s + 1) { alvo = ps[i]; break; } }
      if (!alvo) alvo = ps[ps.length - 1];
      dist = Math.abs(alvo.s - s);
    } else if (o.sentido === "volta") {
      for (i = ps.length - 1; i >= 0; i--) { if (ps[i].s < s - 1) { alvo = ps[i]; break; } }
      if (!alvo) alvo = ps[0];
      dist = Math.abs(s - alvo.s);
    } else {
      // Sentido ainda desconhecido: o ponto mais próximo.
      alvo = ps.reduce(function (x, p) { return Math.abs(p.s - s) < Math.abs(x.s - s) ? p : x; });
      dist = Math.abs(alvo.s - s);
      aproximado = true;
    }
    return { id: alvo.id, nome: alvo.nome, distancia: Math.round(dist), aproximado: aproximado };
  }

  function paraPosicao(c, o) {
    return {
      id: o.id,
      lat: o.lat,
      lng: o.lng,
      status: o.desatualizado ? "sem_sinal" : o.velocidade < 1 ? "parado" : "em_movimento",
      atualizadoEm: new Date(o.ultimaAmostraEm),
      sentido: o.sentido,
      velocidade: o.velocidade,
      confianca: o.confianca,
      score: o.score,
      qtdPassageiros: o.qtdPassageiros,
      desatualizado: o.desatualizado,
      proximoPonto: proximoPonto(c, o)
    };
  }

  function montarResultado(c, r) {
    var lista = r.onibus.map(function (o) { return paraPosicao(c, o); });
    lista.sort(function (a, b) { return (a.desatualizado ? 1 : 0) - (b.desatualizado ? 1 : 0) || b.score - a.score; });
    if (!lista.length) {
      return { indisponivel: true, onibus: [], lat: null, lng: null, status: "sem_sinal", atualizadoEm: null, proximoPonto: null };
    }
    return Object.assign({}, lista[0], { indisponivel: false, onibus: lista });
  }

  function montarSimulacao(c, agora) {
    var T = c.rota.total;
    var inicio = agora - 600000;
    c.sim = Sim.criar({ rota: c.rota, semente: (Number(c.linha.id) || 1) * 97, inicio: inicio, duracaoMs: DURACAO_SIM_MS });
    c.fimSim = inicio + DURACAO_SIM_MS;
    // Um ônibus cheio (confiança alta), um com só 1 passageiro (baixa),
    // e dois "ruídos" que o estimador precisa ignorar: um carro e um pedestre.
    c.sim.adicionarOnibus({ s0: T * 0.12, passageiros: 4 });
    c.sim.adicionarOnibus({ s0: T * 0.55, passageiros: 1 });
    c.sim.adicionarAtor({ tipo: "carro", s0: T * 0.3 });
    c.sim.adicionarAtor({ tipo: "pe", s0: T * 0.8 });
  }

  function ciclo(c, t) {
    if (c.sim && t > c.fimSim) montarSimulacao(c, t);
    c.reais = c.reais.filter(function (a) { return a.t >= t - JANELA_MS; });
    var amostras = c.reais.filter(function (a) { return a.t <= t; });
    if (c.sim) amostras = amostras.concat(c.sim.amostras(t - JANELA_MS, t));

    var r = E.estimar({ rota: c.rota, amostras: amostras, agora: t, estado: c.estado });
    c.estado = r.estado;
    c.ultimo = montarResultado(c, r);

    Object.keys(c.viagens).forEach(function (id) {
      var v = c.viagens[id];
      if (v.fim) return;
      v.situacao = r.viagens[id] || null;
      if (v.situacao && v.situacao.sugerirFim) v.fim = v.situacao.sugerirFim;
      var onibus = v.situacao && v.situacao.onibusId
        ? c.ultimo.onibus.filter(function (o) { return o.id === v.situacao.onibusId; })[0] || null
        : null;
      v.ouvintes.slice().forEach(function (cb) { cb({ situacao: v.situacao, onibus: onibus, fim: v.fim }); });
    });
    c.ouvintes.slice().forEach(function (cb) { cb(c.ultimo); });
  }

  function criarCentral(linha, pontos, geo) {
    var pts = geo && geo.pontos && geo.pontos.length > 1 ? geo.pontos : linha.trajeto;
    var paradasLatLng = (pontos || []).map(function (p) { return [p.latitude, p.longitude]; });
    var rota = E.prepararRota(pts, { circular: !!linha.circular, paradas: paradasLatLng });
    var c = {
      linha: linha, rota: rota, paradas: ordenarParadas(rota, pontos, !!linha.circular),
      sim: null, fimSim: 0, estado: null, ultimo: null, ouvintes: [], reais: [], viagens: {}
    };
    var agora = Date.now();
    if (simularPassageiros()) montarSimulacao(c, agora);
    for (var t = agora - AQUECIMENTO_MS; t < agora; t += CICLO_MS) ciclo(c, t);
    ciclo(c, agora);
    c.timer = setInterval(function () { ciclo(c, Date.now()); }, CICLO_MS);
    return c;
  }

  function obterCentral(linha, pontos) {
    if (!centrais[linha.id]) {
      centrais[linha.id] = Promise.all([
        pontos ? Promise.resolve(pontos) : S.dados.listarPontos(linha.id),
        S.dados.obterGeometriaLinha(linha)
      ]).then(function (r) { return criarCentral(linha, r[0], r[1]); });
    }
    return centrais[linha.id];
  }

  // ---------- Leitura (telas) ----------

  function assinar(linha, pontos, cb) {
    var cancelado = false;
    var central = null;
    obterCentral(linha, pontos).then(function (c) {
      if (cancelado) return;
      central = c;
      c.ouvintes.push(cb);
      if (c.ultimo) cb(c.ultimo);
    });
    return function () {
      cancelado = true;
      if (central) {
        var i = central.ouvintes.indexOf(cb);
        if (i >= 0) central.ouvintes.splice(i, 1);
      }
    };
  }

  function statusPorLinha(linhas) {
    return Promise.all(linhas.map(function (l) {
      return obterCentral(l).then(function (c) { return [l.id, c.ultimo]; });
    })).then(function (pares) {
      var r = {};
      pares.forEach(function (p) { r[p[0]] = !p[1] || p[1].indisponivel ? "sem_sinal" : p[1].status; });
      return r;
    });
  }

  // ---------- Viagens (usado por viagem.js) ----------
  // Mesma forma que as funções do servidor (RPCs no Supabase, mais abaixo).

  var viagens = {
    iniciar: function (linha) {
      return obterCentral(linha).then(function (c) {
        var id = novoId();
        c.viagens[id] = { inicio: Date.now(), fim: null, situacao: null, ouvintes: [] };
        centralDaViagem[id] = c;
        return { viagemId: id };
      });
    },

    // lote: [{ lat, lng, precisao, velocidade, direcao, t }]
    enviar: function (viagemId, lote) {
      var c = centralDaViagem[viagemId];
      if (!c) return Promise.resolve({ encerrada: "viagem_desconhecida" });
      var v = c.viagens[viagemId];
      if (v.fim) return Promise.resolve({ encerrada: v.fim });
      var agora = Date.now();
      // As mesmas checagens que o servidor fará: horário plausível e precisão mínima.
      lote.forEach(function (a) {
        if (a.t > agora + 5000 || a.t < agora - 120000 || !(a.precisao <= 100)) return;
        c.reais.push({ viagem_id: viagemId, lat: a.lat, lng: a.lng, precisao: a.precisao,
          velocidade: a.velocidade, direcao: a.direcao, t: a.t });
      });
      return Promise.resolve({ encerrada: null, situacao: v.situacao });
    },

    encerrar: function (viagemId, motivo) {
      var c = centralDaViagem[viagemId];
      if (!c) return Promise.resolve();
      var v = c.viagens[viagemId];
      if (!v.fim) v.fim = motivo || "usuario";
      v.ouvintes = [];
      // Na demonstração, as localizações da viagem são apagadas ao sair.
      c.reais = c.reais.filter(function (a) { return a.viagem_id !== viagemId; });
      delete centralDaViagem[viagemId];
      return Promise.resolve();
    },

    // cb({ situacao, onibus, fim }) a cada ciclo de estimativa.
    acompanhar: function (viagemId, cb) {
      var c = centralDaViagem[viagemId];
      if (!c) return function () {};
      var v = c.viagens[viagemId];
      v.ouvintes.push(cb);
      return function () {
        var i = v.ouvintes.indexOf(cb);
        if (i >= 0) v.ouvintes.splice(i, 1);
      };
    },

    // Na demonstração não há dados guardados fora deste navegador.
    revogarConsentimento: function () { return Promise.resolve(); },
    excluirMeusDados: function () { return Promise.resolve(); }
  };

  // Painel (demonstração): quantas viagens mandaram localização nos últimos
  // 2 min e quantos ônibus estão estimados agora. Só contagens.
  function resumoAgora(linhas) {
    return Promise.all(linhas.map(function (l) { return obterCentral(l); })).then(function (cs) {
      var agora = Date.now();
      var r = { compartilhando: 0, onibusAtivos: 0, linhasComOnibus: 0 };
      cs.forEach(function (c) {
        var vs = (c.estado && c.estado.viagens) || {};
        Object.keys(vs).forEach(function (k) {
          if (!vs[k].fim && agora - vs[k].ultimaAmostraT < 120000) r.compartilhando++;
        });
        var ativos = c.ultimo ? c.ultimo.onibus.filter(function (o) { return !o.desatualizado; }).length : 0;
        r.onibusAtivos += ativos;
        if (c.ultimo && c.ultimo.onibus.length) r.linhasComOnibus++;
      });
      return r;
    });
  }

  // GPS simulado de alguém dentro do ônibus simulado mais cheio da linha, no
  // formato de navigator.geolocation. Só existe na demonstração.
  function gpsDemonstracao(linha) {
    if (!simularPassageiros()) return Promise.resolve(null);
    return obterCentral(linha).then(function (c) {
      if (!c.sim || !c.sim.onibus().length) return null;
      var movel = c.sim.onibus()[0];
      var timers = {};
      var seq = 0;
      return {
        watchPosition: function (sucesso) {
          var id = ++seq;
          var emitir = function () { sucesso(c.sim.leituraGps(movel, Date.now())); };
          setTimeout(emitir, 500);
          timers[id] = setInterval(emitir, 1000);
          return id;
        },
        clearWatch: function (id) { clearInterval(timers[id]); delete timers[id]; }
      };
    });
  }

  // =====================================================================
  // Com o Supabase: o servidor estima (Edge Function estimar-onibus) e o app
  // só lê a tabela onibus_estimados. Veja supabase/migracoes/002.
  // =====================================================================

  var client = S.client;
  var LEITURA_MS = 10000;               // leitura de reserva, além do Realtime
  var SERVIDOR_PARADO_MS = 60000;       // servidor sem atualizar: marca como desatualizado
  var EXPIRA_MS = 5 * 60000;            // sem atualização há 5 min: não mostra
  var feeds = {};                       // linha.id -> Promise<feed>

  function noop() {}

  // Traçado e pontos da linha, para calcular o próximo ponto de cada ônibus.
  function obterContexto(linha, pontos) {
    return Promise.all([
      pontos ? Promise.resolve(pontos) : S.dados.listarPontos(linha.id),
      S.dados.obterGeometriaLinha(linha)
    ]).then(function (r) {
      var pts = r[1] && r[1].pontos && r[1].pontos.length > 1 ? r[1].pontos : linha.trajeto;
      var rota = E.prepararRota(pts, { circular: !!linha.circular });
      return { linha: linha, rota: rota, paradas: ordenarParadas(rota, r[0], !!linha.circular) };
    });
  }

  // Linha da tabela onibus_estimados -> formato do estimador (usado por paraPosicao).
  function doBanco(c, r, agora) {
    var atualizado = Date.parse(r.atualizado_em);
    if (!(agora - atualizado <= EXPIRA_MS)) return null;
    return {
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      // Recalcula "s" no traçado deste aparelho (o próximo ponto sai dele).
      s: E.util.projetar(c.rota, r.lat, r.lng, r.s_rota).s,
      sentido: r.sentido,
      velocidade: r.velocidade_ms || 0,
      confianca: r.confianca,
      score: r.score,
      qtdPassageiros: r.qtd_passageiros,
      desatualizado: !!r.desatualizado || agora - atualizado > SERVIDOR_PARADO_MS,
      ultimaAmostraEm: Date.parse(r.ultima_amostra_em)
    };
  }

  function lerServidor(f) {
    return client.from("onibus_estimados")
      .select("id,lat,lng,s_rota,sentido,velocidade_ms,confianca,score,qtd_passageiros,desatualizado,ultima_amostra_em,atualizado_em")
      .eq("linha_id", f.c.linha.id)
      .eq("ativo", true)
      .then(function (resp) {
        if (resp.error) throw resp.error;
        var agora = Date.now();
        var lista = (resp.data || []).map(function (r) { return doBanco(f.c, r, agora); }).filter(Boolean);
        f.ultimo = montarResultado(f.c, { onibus: lista });
        f.ouvintes.slice().forEach(function (cb) { cb(f.ultimo); });
      });
  }

  // Várias mudanças seguidas (uma por ônibus) viram uma leitura só.
  function agendarLeitura(f) {
    if (f.pendente) return;
    f.pendente = setTimeout(function () { f.pendente = null; lerServidor(f).catch(noop); }, 300);
  }

  function ligarFeed(f) {
    if (f.timer) return;
    lerServidor(f).catch(noop);
    f.timer = setInterval(function () { lerServidor(f).catch(noop); }, LEITURA_MS);
    f.canal = client.channel("onibus-estimados-" + f.c.linha.id)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "onibus_estimados", filter: "linha_id=eq." + f.c.linha.id },
        function () { agendarLeitura(f); })
      .subscribe();
  }

  function desligarFeed(f) {
    clearInterval(f.timer);
    f.timer = null;
    if (f.canal) { client.removeChannel(f.canal); f.canal = null; }
  }

  function obterFeed(linha, pontos) {
    if (!feeds[linha.id]) {
      feeds[linha.id] = obterContexto(linha, pontos).then(function (c) {
        return { c: c, ouvintes: [], ultimo: null, timer: null, canal: null, pendente: null };
      });
    }
    return feeds[linha.id];
  }

  function assinarServidor(linha, pontos, cb) {
    var cancelado = false;
    var feed = null;
    obterFeed(linha, pontos).then(function (f) {
      if (cancelado) return;
      feed = f;
      f.ouvintes.push(cb);
      if (f.ultimo) cb(f.ultimo);
      ligarFeed(f);
    });
    return function () {
      cancelado = true;
      if (!feed) return;
      var i = feed.ouvintes.indexOf(cb);
      if (i >= 0) feed.ouvintes.splice(i, 1);
      if (!feed.ouvintes.length) desligarFeed(feed);
    };
  }

  function statusPorLinhaServidor(linhas) {
    return client.from("onibus_estimados").select("linha_id,velocidade_ms,desatualizado,atualizado_em").eq("ativo", true)
      .then(function (resp) {
        if (resp.error) throw resp.error;
        var agora = Date.now();
        var r = {};
        linhas.forEach(function (l) { r[l.id] = "sem_sinal"; });
        (resp.data || []).forEach(function (o) {
          if (o.desatualizado || agora - Date.parse(o.atualizado_em) > SERVIDOR_PARADO_MS) return;
          var st = (o.velocidade_ms || 0) < 1 ? "parado" : "em_movimento";
          if (r[o.linha_id] !== "em_movimento") r[o.linha_id] = st;
        });
        return r;
      });
  }

  // Quem compartilha precisa de uma sessão: login anônimo (sem cadastro),
  // criado só quando a pessoa começa a primeira viagem.
  function garantirSessao() {
    return client.auth.getSession().then(function (r) {
      if (r.data && r.data.session) return r.data.session;
      return client.auth.signInAnonymously().then(function (x) {
        if (x.error) throw x.error;
        return x.data.session;
      });
    });
  }

  function temSessao() {
    return client.auth.getSession().then(function (r) { return !!(r.data && r.data.session); });
  }

  function rpc(nome, args) {
    return client.rpc(nome, args || {}).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  var viagensServidor = {
    iniciar: function (linha, opcoes) {
      return garantirSessao().then(function () {
        return rpc("iniciar_viagem", {
          p_linha_id: linha.id,
          p_versao_consentimento: (opcoes && opcoes.versaoConsentimento) || "desconhecida"
        });
      }).then(function (id) { return { viagemId: id }; });
    },
    enviar: function (viagemId, lote) {
      return rpc("enviar_localizacoes", { p_viagem_id: viagemId, p_lote: lote }).then(function (d) {
        return { encerrada: (d && d.encerrada) || null };
      });
    },
    encerrar: function (viagemId, motivo) {
      return rpc("encerrar_viagem", { p_viagem_id: viagemId, p_motivo: motivo || "usuario" });
    },
    // O servidor recalcula a cada 10 s; o app consulta a situação no mesmo ritmo.
    acompanhar: function (viagemId, cb) {
      var parado = false;
      function ler() {
        rpc("situacao_viagem", { p_viagem_id: viagemId }).then(function (d) {
          if (!parado && d) cb({ situacao: d.situacao || null, onibus: d.onibus || null, fim: d.fim || null });
        }, noop);
      }
      var primeira = setTimeout(ler, 3000);
      var timer = setInterval(ler, LEITURA_MS);
      return function () { parado = true; clearTimeout(primeira); clearInterval(timer); };
    },
    revogarConsentimento: function () {
      return temSessao().then(function (ok) { return ok ? rpc("revogar_consentimento_viagem") : null; });
    },
    excluirMeusDados: function () {
      return temSessao().then(function (ok) {
        if (!ok) return null;
        return rpc("excluir_meus_dados").then(function () { return client.auth.signOut(); });
      });
    }
  };

  if (S.modo === "supabase" && client) {
    return {
      assinar: assinarServidor,
      statusPorLinha: statusPorLinhaServidor,
      viagens: viagensServidor,
      gpsDemonstracao: function () { return Promise.resolve(null); },
      simulando: function () { return false; },
      noServidor: true
    };
  }

  return {
    assinar: assinar,
    statusPorLinha: statusPorLinha,
    viagens: viagens,
    gpsDemonstracao: gpsDemonstracao,
    simulando: simularPassageiros,
    resumoAgora: resumoAgora,
    noServidor: false
  };
})();
