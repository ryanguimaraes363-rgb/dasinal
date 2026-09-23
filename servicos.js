/*
  Serviços do Dá sinal.

  Tudo o que o app precisa de dados passa por aqui, para que a troca do modo
  demonstração pelo Supabase (e da posição simulada por GPS real) não exija
  mexer nas telas:

    DaSinal.dados        linhas, pontos e status (demo ou Supabase)
    DaSinal.eventos      registro de eventos de demanda (sem dados pessoais)
    DaSinal.localizacao  geolocalização SOMENTE com consentimento
    DaSinal.posicao      posição do ônibus (simulada ou lida do Supabase)
    DaSinal.agregar      agregações usadas pelo painel no modo demonstração

  A lista de pontos de cada linha (linha.trajeto) é usada como uma sequência
  de PARADAS, na ordem do percurso — não é mais desenhada como o trajeto em
  si. dados.obterGeometriaLinha() manda essa sequência para DaSinalRotas
  (js/rotas.js), que devolve o traçado real das ruas entre elas. Enquanto
  isso não roda (arquivo rotas.js ausente, por exemplo), tudo cai de volta
  para o traçado reto entre os pontos.
*/
(function () {
  "use strict";

  var CFG = window.DASINAL_CONFIG || {};
  var DEMO = window.DASINAL_DEMO || { linhas: [], pontos: [], onibus: [] };

  var configurado = !!CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("COLE_") !== 0 &&
    !!CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf("COLE_") !== 0;
  var client = (configurado && window.supabase)
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
    : null;
  var modo = client ? "supabase" : "demo";

  // ---------- Utilidades geográficas ----------

  function rad(g) { return g * Math.PI / 180; }

  function distanciaM(a, b) {
    var R = 6371000;
    var dLat = rad(b[0] - a[0]);
    var dLng = rad(b[1] - a[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Região aproximada: grade de 0,01 grau (cerca de 1 km). Nunca guardamos a posição exata.
  function celulaRegiao(lat, lng) {
    return lat.toFixed(2) + "," + lng.toFixed(2);
  }

  function lerRegiao(texto) {
    var p = String(texto).split(",");
    return [Number(p[0]), Number(p[1])];
  }

  var CORES = ["#1548C9", "#0E7C86", "#7A3EB8", "#C77700", "#C62828", "#1B7F4B"];
  function corDaLinha(linha) {
    var n = parseInt(linha.numero, 10);
    if (isNaN(n)) n = Number(linha.id) || 0;
    return CORES[Math.abs(n) % CORES.length];
  }

  function criarRota(trajeto) {
    var acum = [0];
    var total = 0;
    for (var i = 1; i < trajeto.length; i++) {
      total += distanciaM(trajeto[i - 1], trajeto[i]);
      acum.push(total);
    }
    return { pts: trajeto, acum: acum, total: total };
  }

  function posicaoEm(rota, s) {
    s = Math.max(0, Math.min(rota.total, s));
    for (var i = 1; i < rota.pts.length; i++) {
      if (s <= rota.acum[i]) {
        var d = rota.acum[i] - rota.acum[i - 1];
        var k = d ? (s - rota.acum[i - 1]) / d : 0;
        var a = rota.pts[i - 1];
        var b = rota.pts[i];
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      }
    }
    return rota.pts[rota.pts.length - 1];
  }

  // Distância (em metros, ao longo da rota) do ponto da rota mais próximo de lat/lng.
  // Com sMin (usado na circular): ignora os trechos antes dessa distância e,
  // se a rota passa perto do ponto mais de uma vez, fica com a primeira passagem.
  function projetarNaRota(rota, lat, lng, sMin) {
    var circular = sMin != null;
    var TOLERANCIA_M = 30;
    var melhor = { d: Infinity, s: sMin || 0 };
    var candidatos = [];
    var kx = Math.cos(rad(lat)) * 111320;
    var ky = 110540;
    for (var i = 1; i < rota.pts.length; i++) {
      if (circular && rota.acum[i] < sMin) continue;
      var a = rota.pts[i - 1];
      var b = rota.pts[i];
      var ax = (a[1] - lng) * kx, ay = (a[0] - lat) * ky;
      var bx = (b[1] - lng) * kx, by = (b[0] - lat) * ky;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      var px = ax + t * dx, py = ay + t * dy;
      var d = Math.sqrt(px * px + py * py);
      var s = rota.acum[i - 1] + t * (rota.acum[i] - rota.acum[i - 1]);
      if (circular) candidatos.push({ d: d, s: s });
      if (d < melhor.d) {
        melhor.d = d;
        melhor.s = s;
      }
    }
    if (circular) {
      for (var c = 0; c < candidatos.length; c++) {
        if (candidatos[c].d <= melhor.d + TOLERANCIA_M) return candidatos[c].s;
      }
    }
    return melhor.s;
  }

  function pontoMaisProximo(pontos, pos) {
    var melhor = null;
    (pontos || []).forEach(function (p) {
      var d = distanciaM(pos, [p.latitude, p.longitude]);
      if (!melhor || d < melhor.distancia) melhor = { id: p.id, nome: p.nome, distancia: d };
    });
    return melhor;
  }

  // ---------- Dados (linhas, pontos, status) ----------

  function verificar(resposta) {
    if (resposta.error) throw resposta.error;
    return resposta.data;
  }

  // Uma geometria por linha, guardada em memória para a sessão (o módulo de
  // rotas já mantém seu próprio cache entre sessões).
  var geometriasEmCache = {};

  var dados = {
    modo: modo,

    // Devolve { pontos: [[lat,lng],...], fonte: "banco" | "osrm" | "reta" } com o
    // traçado da linha seguindo as ruas de verdade, calculado a partir das
    // paradas em linha.trajeto (nessa ordem). Sem o módulo de rotas
    // carregado, ou sem paradas suficientes, cai para o traçado reto.
    obterGeometriaLinha: function (linha) {
      if (geometriasEmCache[linha.id]) return geometriasEmCache[linha.id];
      // Traçado já guardado no banco (linhas.geometria, preenchido pelo servidor):
      // app e estimador usam exatamente o mesmo.
      if (Array.isArray(linha.geometria) && linha.geometria.length >= 2) {
        geometriasEmCache[linha.id] = Promise.resolve({ pontos: linha.geometria, fonte: "banco" });
        return geometriasEmCache[linha.id];
      }
      var pontos = linha.trajeto || [];
      var promessa = (window.DaSinalRotas && pontos.length >= 2)
        ? window.DaSinalRotas.obterRota(pontos)
        : Promise.resolve({ pontos: pontos, fonte: "reta" });
      geometriasEmCache[linha.id] = promessa;
      return promessa;
    },

    listarLinhas: function () {
      if (!client) return Promise.resolve(DEMO.linhas.filter(function (l) { return l.ativo; }));
      // "*" traz "circular" quando a coluna existe, sem quebrar bancos antigos que não a têm.
      return client.from("linhas")
        .select("*")
        .eq("ativo", true).order("numero").then(verificar);
    },

    listarPontos: function (linhaId) {
      if (!client) {
        return Promise.resolve(DEMO.pontos
          .filter(function (p) { return p.linha_id === linhaId; })
          .sort(function (a, b) { return a.ordem - b.ordem; }));
      }
      return client.from("pontos")
        .select("id,nome,latitude,longitude,linha_id,ordem")
        .eq("linha_id", linhaId).order("ordem").then(verificar);
    },

    listarTodosPontos: function () {
      if (!client) return Promise.resolve(DEMO.pontos.slice());
      return client.from("pontos").select("id,nome,latitude,longitude,linha_id,ordem").then(verificar);
    },

    // Mapa { linha_id: "em_movimento" | "parado" | "sem_sinal" }
    statusPorLinha: function () {
      if (posicao.colaborativa && window.DaSinalColaborativo) {
        return dados.listarLinhas().then(window.DaSinalColaborativo.statusPorLinha);
      }
      var simulada = !(CFG.POSICAO_ONIBUS === "supabase" && client);
      if (simulada) {
        // Com posição simulada, todas as linhas ativas aparecem em movimento.
        return dados.listarLinhas().then(function (ls) {
          var r = {};
          ls.forEach(function (l) { r[l.id] = "em_movimento"; });
          return r;
        });
      }
      return client.from("onibus").select("linha_id,status").then(verificar).then(function (rows) {
        var r = {};
        rows.forEach(function (o) {
          if (o.linha_id == null) return;
          if (o.status === "em_movimento" || !r[o.linha_id]) r[o.linha_id] = o.status;
        });
        return r;
      });
    }
  };

  // ---------- Geolocalização (somente com consentimento) ----------

  var loc = { watchId: null, ultima: null, contou: false };

  var localizacao = {
    disponivel: function () { return !!navigator.geolocation; },
    ativa: function () { return loc.watchId !== null; },
    ultima: function () { return loc.ultima; },

    // Só devolve uma região enquanto a pessoa estiver compartilhando a localização.
    regiaoAtual: function () {
      return (loc.watchId !== null && loc.ultima) ? celulaRegiao(loc.ultima[0], loc.ultima[1]) : null;
    },

    permissaoJaConcedida: function () {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          return navigator.permissions.query({ name: "geolocation" }).then(
            function (r) { return r.state === "granted"; },
            function () { return false; });
        }
      } catch (e) { /* navegador sem suporte */ }
      return Promise.resolve(false);
    },

    // Chame somente depois que a pessoa clicou em "Permitir localização".
    iniciar: function (aoPosicao, aoErro) {
      if (!navigator.geolocation) { aoErro({ code: 0 }); return; }
      if (loc.watchId !== null) return;
      loc.watchId = navigator.geolocation.watchPosition(
        function (p) {
          loc.ultima = [p.coords.latitude, p.coords.longitude];
          if (!loc.contou) {
            loc.contou = true;
            eventos.registrar({ tipo: "localizacao_permitida" });
          }
          aoPosicao(loc.ultima);
        },
        function (err) {
          if (err && err.code === 1) {
            localizacao.parar();
            eventos.registrar({ tipo: "localizacao_negada" });
          }
          aoErro(err);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
      );
    },

    parar: function () {
      if (loc.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(loc.watchId);
      loc.watchId = null;
      loc.ultima = null;
    },

    // A pessoa escolheu "Agora não".
    recusar: function () { eventos.registrar({ tipo: "localizacao_negada" }); }
  };

  // ---------- Eventos de demanda ----------
  // Guardamos: tipo, linha, ponto, horário e (só com consentimento) uma região de ~1 km.
  // Não existe identificador de pessoa, de aparelho nem de sessão nesses registros.

  var TIPOS_EVENTO = ["acesso", "consulta_linha", "ponto_selecionado", "interacao_linha",
    "localizacao_permitida", "localizacao_negada"];
  var CHAVE_EVENTOS_DEMO = "dasinal.demo.eventos";

  function lerEventosDemo() {
    try { return JSON.parse(window.localStorage.getItem(CHAVE_EVENTOS_DEMO) || "[]"); } catch (e) { return []; }
  }
  function gravarEventosDemo(lista) {
    try { window.localStorage.setItem(CHAVE_EVENTOS_DEMO, JSON.stringify(lista.slice(-5000))); } catch (e) { /* sem armazenamento */ }
  }

  var eventos = {
    registrar: function (e) {
      if (TIPOS_EVENTO.indexOf(e.tipo) < 0) return;
      var reg = {
        linha_id: e.linha_id || null,
        ponto_id: e.ponto_id || null,
        regiao_aprox: localizacao.regiaoAtual(),
        tipo_interacao: e.tipo
      };
      if (client) {
        // O horário é gravado pelo banco (data_hora tem valor padrão now()).
        client.from("eventos_demanda").insert(reg).then(function () { /* melhor esforço */ }, function () { /* ignora */ });
      } else {
        var lista = lerEventosDemo();
        reg.id = "d" + Date.now() + Math.random().toString(36).slice(2, 6);
        reg.data_hora = new Date().toISOString();
        lista.push(reg);
        gravarEventosDemo(lista);
      }
    },

    // Um "acesso" por visita (aba aberta), não por tela.
    registrarAcessoUmaVez: function () {
      try {
        if (window.sessionStorage.getItem("dasinal.acesso")) return;
        window.sessionStorage.setItem("dasinal.acesso", "1");
      } catch (e) { /* segue sem a trava */ }
      eventos.registrar({ tipo: "acesso" });
    },

    lerDemo: lerEventosDemo,
    limparDemo: function () { try { window.localStorage.removeItem(CHAVE_EVENTOS_DEMO); } catch (e) { /* nada */ } }
  };

  // ---------- Posição do ônibus ----------
  // Interface: assinar(linha, pontos, callback) devolve uma função para cancelar.
  // O callback recebe { lat, lng, status, atualizadoEm, proximoPonto }.
  // Para usar GPS real, basta gravar na tabela "onibus" e ligar POSICAO_ONIBUS = "supabase".

  var Simulador = (function () {
    var instancias = {};
    // Linhas cuja geometria (traçado pelas ruas) ainda está sendo buscada:
    // linha.id -> { ouvintes: [callback, ...] }.
    var pendentes = {};
    var timer = null;
    var dt = (CFG.INTERVALO_SIMULACAO_MS || 1000) / 1000;
    var velocidadeKmHora = (CFG.VELOCIDADE_SIMULADA_KMH != null)
      ? CFG.VELOCIDADE_SIMULADA_KMH
      : ((CFG.VELOCIDADE_SIMULADA_MS != null) ? CFG.VELOCIDADE_SIMULADA_MS * 3.6 : 16);
    var velocidade = velocidadeKmHora / 3.6;

    // pontosRota: o traçado que o ônibus percorre — a geometria real das
    // ruas quando disponível, senão o traçado reto (linha.trajeto).
    function criar(linha, pontos, pontosRota) {
      var rota = criarRota(pontosRota && pontosRota.length >= 2 ? pontosRota : linha.trajeto);
      var pts;
      if (linha.circular) {
        // Na circular a rota passa perto do mesmo lugar mais de uma vez: cada
        // parada é projetada adiante da anterior, na ordem cadastrada.
        var sAnterior = 0;
        pts = (pontos || []).slice().sort(function (a, b) { return a.ordem - b.ordem; }).map(function (p) {
          sAnterior = Math.max(sAnterior, projetarNaRota(rota, p.latitude, p.longitude, sAnterior));
          return { id: p.id, nome: p.nome, s: sAnterior };
        });
      } else {
        pts = (pontos || []).map(function (p) {
          return { id: p.id, nome: p.nome, s: projetarNaRota(rota, p.latitude, p.longitude) };
        }).sort(function (a, b) { return a.s - b.s; });
      }
      var indice = ((Number(linha.id) || 1) - 1) % 3;
      return {
        rota: rota,
        pts: pts,
        circular: !!linha.circular,
        s: rota.total * (0.1 + 0.3 * indice),
        dir: (linha.circular || indice % 2 === 0) ? 1 : -1,
        ouvintes: [],
        ultimo: null,
        pausado: false,
        pausaAte: 0,
        pausaMs: 6000
      };
    }

    function estado(inst) {
      var pos = posicaoEm(inst.rota, inst.s);
      var alvo = null;
      var i;
      var distancia = null;
      if (inst.circular) {
        // Depois da última parada, a próxima é a primeira da volta seguinte.
        for (i = 0; i < inst.pts.length; i++) { if (inst.pts[i].s > inst.s + 1) { alvo = inst.pts[i]; break; } }
        if (!alvo && inst.pts.length) {
          alvo = inst.pts[0];
          distancia = inst.rota.total - inst.s + alvo.s;
        }
      } else if (inst.dir === 1) {
        for (i = 0; i < inst.pts.length; i++) { if (inst.pts[i].s > inst.s + 1) { alvo = inst.pts[i]; break; } }
        if (!alvo && inst.pts.length) alvo = inst.pts[inst.pts.length - 1];
      } else {
        for (i = inst.pts.length - 1; i >= 0; i--) { if (inst.pts[i].s < inst.s - 1) { alvo = inst.pts[i]; break; } }
        if (!alvo && inst.pts.length) alvo = inst.pts[0];
      }
      return {
        lat: pos[0],
        lng: pos[1],
        status: inst.pausado ? "parado" : "em_movimento",
        atualizadoEm: new Date(),
        sentido: inst.dir === 1 ? "ida" : "volta",
        proximoPonto: alvo ? { id: alvo.id, nome: alvo.nome, distancia: Math.round(distancia != null ? distancia : Math.abs(alvo.s - inst.s)) } : null
      };
    }

    function avancar(inst) {
      if (inst.pausado) {
        if (Date.now() >= inst.pausaAte) {
          inst.pausado = false;
          inst.pausaAte = 0;
        } else {
          inst.ultimo = estado(inst);
          inst.ouvintes.slice().forEach(function (cb) { cb(inst.ultimo); });
          return;
        }
      }

      inst.s += inst.dir * velocidade * dt;
      if (inst.circular) {
        // Fim da volta: para um pouco no ponto inicial e começa a próxima.
        if (inst.s >= inst.rota.total) {
          inst.s = 0;
          inst.pausado = true;
          inst.pausaAte = Date.now() + inst.pausaMs;
        }
      } else if (inst.s >= inst.rota.total) {
        inst.s = inst.rota.total;
        inst.dir = -1;
        inst.pausado = true;
        inst.pausaAte = Date.now() + inst.pausaMs;
      } else if (inst.s <= 0) {
        inst.s = 0;
        inst.dir = 1;
        inst.pausado = true;
        inst.pausaAte = Date.now() + inst.pausaMs;
      }
      inst.ultimo = estado(inst);
      inst.ouvintes.slice().forEach(function (cb) { cb(inst.ultimo); });
    }

    function garantirTimer() {
      if (timer) return;
      timer = setInterval(function () {
        Object.keys(instancias).forEach(function (k) { avancar(instancias[k]); });
      }, dt * 1000);
    }

    return {
      // Assina a posição simulada da linha. Na primeira chamada para uma
      // linha, busca o traçado real das ruas (dados.obterGeometriaLinha)
      // antes de criar o ônibus simulado; chamadas seguintes reaproveitam
      // o mesmo ônibus, já em movimento, mesmo enquanto essa busca roda.
      assinar: function (linha, pontos, cb) {
        if (!linha.trajeto || linha.trajeto.length < 2) return function () { /* sem rota */ };

        var inst = instancias[linha.id];
        if (inst) {
          inst.ouvintes.push(cb);
          if (inst.ultimo) cb(inst.ultimo);
          garantirTimer();
          return function () {
            var i = inst.ouvintes.indexOf(cb);
            if (i >= 0) inst.ouvintes.splice(i, 1);
          };
        }

        var pend = pendentes[linha.id];
        if (!pend) {
          pend = pendentes[linha.id] = { ouvintes: [] };
          dados.obterGeometriaLinha(linha).then(function (geo) {
            var criado = instancias[linha.id] = criar(linha, pontos, geo.pontos);
            criado.ouvintes = pend.ouvintes;
            delete pendentes[linha.id];
            criado.ultimo = estado(criado);
            criado.ouvintes.slice().forEach(function (fn) { fn(criado.ultimo); });
            garantirTimer();
          });
        }
        pend.ouvintes.push(cb);

        return function () {
          var p = pendentes[linha.id];
          if (p) { var i = p.ouvintes.indexOf(cb); if (i >= 0) p.ouvintes.splice(i, 1); return; }
          var ins = instancias[linha.id];
          if (ins) { var j = ins.ouvintes.indexOf(cb); if (j >= 0) ins.ouvintes.splice(j, 1); }
        };
      },
      // Somente para testes
      _instancias: instancias,
      _pendentes: pendentes,
      _avancarTodos: function () { Object.keys(instancias).forEach(function (k) { avancar(instancias[k]); }); }
    };
  })();

  function assinarSupabase(linha, pontos, cb) {
    function mapear(r) {
      if (!r || r.latitude == null || r.longitude == null) return null;
      var perto = pontoMaisProximo(pontos, [r.latitude, r.longitude]);
      return {
        lat: r.latitude,
        lng: r.longitude,
        status: r.status || "sem_sinal",
        atualizadoEm: r.ultima_atualizacao ? new Date(r.ultima_atualizacao) : null,
        proximoPonto: perto ? { id: perto.id, nome: perto.nome, distancia: Math.round(perto.distancia), aproximado: true } : null
      };
    }
    function ler() {
      client.from("onibus").select("latitude,longitude,status,ultima_atualizacao")
        .eq("linha_id", linha.id).limit(1).then(function (resp) {
          var m = resp.data && resp.data[0] ? mapear(resp.data[0]) : null;
          if (m) cb(m);
        }, function () { /* tenta de novo no próximo ciclo */ });
    }
    ler();
    var timer = setInterval(ler, 5000);
    var canal = client.channel("onibus-linha-" + linha.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "onibus", filter: "linha_id=eq." + linha.id },
        function (payload) { var m = mapear(payload.new); if (m) cb(m); })
      .subscribe();
    return function () {
      clearInterval(timer);
      client.removeChannel(canal);
    };
  }

  // "colaborativa": posição ESTIMADA a partir dos passageiros (colaborativo.js).
  // Na demonstração o cálculo roda no navegador; com o Supabase, no servidor.
  var colaborativa = CFG.POSICAO_ONIBUS === "colaborativa";

  var posicao = {
    colaborativa: colaborativa,
    simulada: !colaborativa && !(CFG.POSICAO_ONIBUS === "supabase" && client),
    // De quanto em quanto tempo chega uma posição nova (para animar o marcador).
    intervaloMs: colaborativa ? (CFG.CICLO_ESTIMATIVA_MS || 5000) : (CFG.INTERVALO_SIMULACAO_MS || 1000),
    assinar: function (linha, pontos, cb) {
      if (posicao.colaborativa && window.DaSinalColaborativo) return window.DaSinalColaborativo.assinar(linha, pontos, cb);
      if (!posicao.simulada) return assinarSupabase(linha, pontos, cb);
      return Simulador.assinar(linha, pontos, cb);
    },
    _simulador: Simulador
  };

  // ---------- Agregação (modo demonstração) ----------
  // No Supabase, as mesmas contas vêm das views admin_* (veja supabase/schema.sql).

  function agregar(evs, linhas, pontos) {
    var linhaPorId = {};
    linhas.forEach(function (l) { linhaPorId[l.id] = l; });
    var pontoPorId = {};
    pontos.forEach(function (p) { pontoPorId[p.id] = p; });

    var resumo = { acessos: 0, consultas: 0, permitidas: 0, negadas: 0 };
    var porLinha = {};
    var horas = [];
    var i;
    for (i = 0; i < 24; i++) horas.push(0);
    var porRegiao = {};
    var porPonto = {};

    evs.forEach(function (e) {
      switch (e.tipo_interacao) {
        case "acesso": resumo.acessos++; break;
        case "consulta_linha":
          resumo.consultas++;
          if (e.linha_id) porLinha[e.linha_id] = (porLinha[e.linha_id] || 0) + 1;
          horas[new Date(e.data_hora).getHours()]++;
          break;
        case "localizacao_permitida": resumo.permitidas++; break;
        case "localizacao_negada": resumo.negadas++; break;
        case "ponto_selecionado":
          if (e.ponto_id) porPonto[e.ponto_id] = (porPonto[e.ponto_id] || 0) + 1;
          break;
        default: break;
      }
      if (e.regiao_aprox) porRegiao[e.regiao_aprox] = (porRegiao[e.regiao_aprox] || 0) + 1;
    });

    return {
      resumo: resumo,
      linhas: Object.keys(porLinha).map(function (id) {
        var l = linhaPorId[id] || { numero: "?", nome: "Linha removida" };
        return { linha_id: Number(id), numero: l.numero, nome: l.nome, consultas: porLinha[id] };
      }).sort(function (a, b) { return b.consultas - a.consultas; }),
      horas: horas,
      regioes: Object.keys(porRegiao).map(function (r) { return { regiao_aprox: r, eventos: porRegiao[r] }; })
        .sort(function (a, b) { return b.eventos - a.eventos; }),
      pontos: Object.keys(porPonto).map(function (id) {
        var p = pontoPorId[id];
        if (!p) return null;
        var l = linhaPorId[p.linha_id];
        return { ponto_id: p.id, nome: p.nome, latitude: p.latitude, longitude: p.longitude,
          linha_numero: l ? l.numero : "?", selecoes: porPonto[id] };
      }).filter(Boolean).sort(function (a, b) { return b.selecoes - a.selecoes; })
    };
  }

  // Gera eventos FICTÍCIOS para demonstrar o painel sem precisar de tráfego real.
  function gerarExemplo(linhas, pontos) {
    var semente = 42;
    function rnd() {
      semente = (semente + 0x6D2B79F5) | 0;
      var t = Math.imul(semente ^ (semente >>> 15), 1 | semente);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function sortear(pesos) {
      var soma = pesos.reduce(function (a, b) { return a + b; }, 0);
      var x = rnd() * soma;
      for (var i = 0; i < pesos.length; i++) { x -= pesos[i]; if (x < 0) return i; }
      return pesos.length - 1;
    }
    var pesosHora = [0, 0, 0, 0, 1, 3, 6, 10, 8, 4, 3, 4, 7, 5, 3, 3, 5, 9, 10, 6, 3, 2, 1, 0];
    var pesosLinha = linhas.map(function (l, i) { return [45, 35, 20][i] || 10; });
    var lista = lerEventosDemo();
    var agora = Date.now();

    for (var n = 0; n < 400; n++) {
      var linha = linhas[sortear(pesosLinha)];
      var dia = Math.floor(rnd() * 7);
      var d = new Date(agora - dia * 86400000);
      d.setHours(sortear(pesosHora), Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
      if (d.getTime() > agora) d = new Date(agora - Math.floor(rnd() * 3600000));

      var tipo = ["consulta_linha", "ponto_selecionado", "acesso", "interacao_linha", "localizacao_permitida", "localizacao_negada"][sortear([60, 16, 10, 6, 5, 3])];
      var pontosDaLinha = pontos.filter(function (p) { return p.linha_id === linha.id; });
      var ponto = pontosDaLinha[Math.floor(rnd() * pontosDaLinha.length)];
      var regiao = null;
      if (ponto && rnd() < 0.6 && (tipo === "consulta_linha" || tipo === "ponto_selecionado" || tipo === "localizacao_permitida")) {
        regiao = celulaRegiao(ponto.latitude + (rnd() - 0.5) * 0.024, ponto.longitude + (rnd() - 0.5) * 0.024);
      }
      lista.push({
        id: "x" + n + "-" + d.getTime(),
        linha_id: tipo === "acesso" || tipo.indexOf("localizacao") === 0 ? null : linha.id,
        ponto_id: tipo === "ponto_selecionado" && ponto ? ponto.id : null,
        regiao_aprox: regiao,
        tipo_interacao: tipo,
        data_hora: d.toISOString()
      });
    }
    gravarEventosDemo(lista);
  }

  window.DaSinal = {
    config: CFG,
    modo: modo,
    client: client,
    dados: dados,
    eventos: eventos,
    localizacao: localizacao,
    posicao: posicao,
    agregar: agregar,
    gerarExemplo: gerarExemplo,
    util: {
      distanciaM: distanciaM,
      celulaRegiao: celulaRegiao,
      lerRegiao: lerRegiao,
      corDaLinha: corDaLinha,
      criarRota: criarRota,
      posicaoEm: posicaoEm,
      projetarNaRota: projetarNaRota,
      pontoMaisProximo: pontoMaisProximo
    }
  };
})();
