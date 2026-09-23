/*
  Pontos, níveis, conquistas e ranking (Dá sinal).

  As regras ficam em regras-pontos.js. Este arquivo decide ONDE elas rodam:
    - demonstração: aqui mesmo, quando a viagem termina, e tudo fica guardado
      só neste navegador (localStorage);
    - Supabase: no servidor (Edge Function), que é quem sabe se a viagem foi
      validada. O app só lê o resultado. Assim ninguém ganha pontos editando
      o próprio celular.

  Interface: DaSinal.pontos
    resumo()                    Promise<{ pontosTotal, nivel, viagensValidadas, minutos, confiabilidade,
                                          semana, conquistas[], historico[], perfil }>
    ranking()                   Promise<[{ posicao, apelido, pontos, voce }]>
    atualizarPerfil(apelido, aparece)   Promise (apelido público e aparecer no ranking)
    apagar()                    Promise (junto com "Excluir meus dados")
    aoMudar(cb)                 cb({ tipo: "pontuada" | "nao_pontuada", ... }) quando uma viagem é pontuada
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  var P = window.DaSinalPontos;
  var client = S.client;
  var noServidor = S.modo === "supabase" && !!client;
  var CHAVE = "dasinal.pontos.v1";
  var ouvintes = [];

  function notificar(evento) {
    ouvintes.slice().forEach(function (cb) { try { cb(evento); } catch (e) { /* segue */ } });
  }

  function inicioDaSemana(ms) {
    // Segunda-feira 00:00 no horário de Brasília.
    var d = new Date(ms - 3 * 3600000);
    var diaSemana = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diaSemana) + 3 * 3600000;
  }

  function confiabilidade(rep) {
    return rep >= 0.6 ? "alta" : rep >= 0.35 ? "normal" : "baixa";
  }

  function montarConquistas(obtidas) {
    return P.CONQUISTAS.map(function (c) {
      var em = obtidas[c.codigo];
      return { codigo: c.codigo, nome: c.nome, descricao: c.descricao, obtida: !!em, em: em || null };
    });
  }

  // ---------- Demonstração: tudo neste navegador ----------

  function ler() {
    try {
      var v = JSON.parse(window.localStorage.getItem(CHAVE) || "null");
      if (v && v.resumo) return v;
    } catch (e) { /* sem armazenamento */ }
    return { resumo: P.resumoVazio(), historico: [], conquistasEm: {}, perfil: { apelido: null, aparece: false } };
  }

  function gravar(d) {
    try { window.localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* sem armazenamento */ }
  }

  // Participantes fictícios, só para o ranking da demonstração não ficar vazio.
  var RANKING_DEMO = [
    ["Marina_09", 142], ["Seu Zé do 01", 118], ["Lu Ribeiro", 96], ["Caio.bus", 73],
    ["Tati", 51], ["Rafa Itaúna", 38], ["Dona Cida", 24], ["Pedro H.", 12]
  ];

  var demo = {
    resumo: function () {
      var d = ler();
      var desde = inicioDaSemana(Date.now());
      return Promise.resolve({
        pontosTotal: d.resumo.pontosTotal,
        nivel: P.nivelDe(d.resumo.pontosTotal),
        viagensValidadas: d.resumo.viagensValidadas,
        minutos: Math.round(d.resumo.segundos / 60),
        confiabilidade: confiabilidade(d.resumo.reputacao),
        semana: d.historico.filter(function (h) { return h.em >= desde; }).reduce(function (s, h) { return s + h.pontos; }, 0),
        conquistas: montarConquistas(d.conquistasEm),
        // Viagens mais recentes primeiro; dentro de cada viagem, na ordem em que os pontos foram dados.
        historico: d.historico.map(function (h, i) { return Object.assign({ ordem: i }, h); })
          .sort(function (a, b) { return b.em - a.em || a.ordem - b.ordem; }).slice(0, 50),
        perfil: d.perfil
      });
    },
    ranking: function () {
      return demo.resumo().then(function (r) {
        var lista = RANKING_DEMO.map(function (p) { return { apelido: p[0], pontos: p[1], voce: false }; });
        if (r.perfil.aparece && r.perfil.apelido) lista.push({ apelido: r.perfil.apelido, pontos: r.semana, voce: true });
        lista.sort(function (a, b) { return b.pontos - a.pontos; });
        return lista.map(function (p, i) { return Object.assign({ posicao: i + 1 }, p); });
      });
    },
    atualizarPerfil: function (apelido, aparece) {
      var d = ler();
      d.perfil = { apelido: apelido || null, aparece: !!aparece && !!apelido };
      gravar(d);
      return Promise.resolve(d.perfil);
    },
    apagar: function () {
      try { window.localStorage.removeItem(CHAVE); } catch (e) { /* nada */ }
      return Promise.resolve();
    },
    // Aviso confirmado por passageiros simulados (avisos.js). No servidor, isso
    // acontece no banco, em confirmar_aviso.
    creditarAvisoDemo: function (ev) {
      var d = ler();
      var agora = Date.now();
      var hoje = P.diaDe(agora);
      if (d.resumo.dia !== hoje) { d.resumo.dia = hoje; d.resumo.pontosHoje = 0; d.resumo.viagensPontuadasHoje = 0; }
      var pts = Math.min(P.REGRAS.PONTOS_AVISO_CONFIRMADO, Math.max(0, P.REGRAS.LIMITE_PONTOS_DIA - d.resumo.pontosHoje));
      if (pts <= 0) return;
      d.resumo.pontosTotal += pts;
      d.resumo.pontosHoje += pts;
      d.historico.push({ em: agora, avisoId: ev.avisoId, linhaNumero: ev.linhaNumero, tipo: "aviso_confirmado", pontos: pts, descricao: "Aviso confirmado por outros passageiros" });
      gravar(d);
      notificar({ tipo: "aviso_confirmado", linhaNumero: ev.linhaNumero, total: pts, nivel: P.nivelDe(d.resumo.pontosTotal) });
    },
    // Chamado quando uma viagem termina (ver final do arquivo).
    pontuar: function (ev) {
      var s = ev.situacao || {};
      var d = ler();
      var agora = Date.now();
      var viagem = {
        id: ev.viagemId, linhaId: ev.linhaId, iniciadaEm: ev.inicio, encerradaEm: agora,
        validada: !!s.validada, segundosValidos: s.segundosValidos || 0, maxJuntos: s.maxJuntos || 0
      };
      var r = P.pontuarViagem(viagem, d.resumo);
      d.resumo = r.resumo;
      r.itens.forEach(function (i) {
        d.historico.push({ em: agora, viagemId: ev.viagemId, linhaNumero: ev.linhaNumero, tipo: i.tipo, pontos: i.pontos, descricao: i.descricao });
      });
      r.conquistasNovas.forEach(function (c) { d.conquistasEm[c] = agora; });
      d.historico = d.historico.slice(-300);
      gravar(d);
      notificar({
        tipo: r.total > 0 ? "pontuada" : "nao_pontuada",
        linhaNumero: ev.linhaNumero, total: r.total, itens: r.itens, motivo: r.motivo,
        duracaoMs: ev.duracaoMs,
        conquistas: P.CONQUISTAS.filter(function (c) { return r.conquistasNovas.indexOf(c.codigo) >= 0; }),
        nivel: P.nivelDe(d.resumo.pontosTotal)
      });
    }
  };

  // ---------- Supabase: o servidor calcula, o app lê ----------

  function temSessao() {
    return client.auth.getSession().then(function (r) { return !!(r.data && r.data.session); });
  }

  function rpc(nome, args) {
    return client.rpc(nome, args || {}).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  function resumoVazioPublico() {
    return {
      pontosTotal: 0, nivel: P.nivelDe(0), viagensValidadas: 0, minutos: 0, confiabilidade: "normal", semana: 0,
      conquistas: montarConquistas({}), historico: [], perfil: { apelido: null, aparece: false }
    };
  }

  var servidor = {
    resumo: function () {
      return temSessao().then(function (ok) {
        if (!ok) return resumoVazioPublico();
        return rpc("meu_resumo_pontos").then(function (d) {
          var obtidas = {};
          (d.conquistas || []).forEach(function (c) { obtidas[c.codigo] = Date.parse(c.obtida_em); });
          return {
            pontosTotal: d.pontos_total || 0,
            nivel: P.nivelDe(d.pontos_total || 0),
            viagensValidadas: d.viagens_validadas || 0,
            minutos: Math.round((d.segundos || 0) / 60),
            confiabilidade: confiabilidade(d.reputacao == null ? 0.5 : Number(d.reputacao)),
            semana: d.semana || 0,
            conquistas: montarConquistas(obtidas),
            historico: (d.historico || []).map(function (h) {
              return { em: Date.parse(h.criado_em), viagemId: h.viagem_id, avisoId: h.aviso_id || null, linhaNumero: h.linha_numero, tipo: h.tipo, pontos: h.pontos, descricao: h.descricao };
            }),
            perfil: { apelido: d.apelido || null, aparece: !!d.aparece_no_ranking }
          };
        });
      });
    },
    ranking: function () {
      return rpc("ranking_semanal").then(function (lista) {
        return (lista || []).map(function (p) { return { posicao: p.posicao, apelido: p.apelido, pontos: p.pontos, voce: !!p.voce }; });
      });
    },
    atualizarPerfil: function (apelido, aparece) {
      return temSessao().then(function (ok) {
        if (!ok) throw { message: "sem_sessao" };
        return rpc("atualizar_perfil_publico", { p_apelido: apelido || null, p_aparece: !!aparece });
      });
    },
    apagar: function () { return Promise.resolve(); }, // o servidor apaga junto com excluir_meus_dados
    // O servidor pontua alguns segundos depois do fim da viagem: consulta até achar.
    pontuar: function (ev) {
      var tentativas = 0;
      function tentar() {
        tentativas++;
        servidor.resumo().then(function (r) {
          var itens = r.historico.filter(function (h) { return h.viagemId === ev.viagemId; });
          if (itens.length) {
            notificar({
              tipo: "pontuada", linhaNumero: ev.linhaNumero, total: itens.reduce(function (s, i) { return s + i.pontos; }, 0), itens: itens,
              // Conquistas ganhas desde o começo desta viagem.
              conquistas: r.conquistas.filter(function (c) { return c.obtida && c.em >= ev.inicio; }),
              nivel: r.nivel
            });
          } else if (tentativas < 4) setTimeout(tentar, 12000);
          else if (!ev.validada) notificar({ tipo: "nao_pontuada", linhaNumero: ev.linhaNumero, total: 0, itens: [], motivo: "nao_validada", duracaoMs: ev.duracaoMs, conquistas: [] });
        }, function () { if (tentativas < 4) setTimeout(tentar, 12000); });
      }
      setTimeout(tentar, 15000);
    }
  };

  var backend = noServidor ? servidor : demo;

  S.pontos = {
    noServidor: noServidor,
    resumo: backend.resumo,
    ranking: backend.ranking,
    atualizarPerfil: backend.atualizarPerfil,
    apagar: backend.apagar,
    creditarAvisoDemo: noServidor ? null : demo.creditarAvisoDemo,
    aoMudar: function (cb) {
      ouvintes.push(cb);
      return function () { var i = ouvintes.indexOf(cb); if (i >= 0) ouvintes.splice(i, 1); };
    }
  };

  // Viagem terminou -> pontua (se foi validada). Retirar a autorização não pontua.
  if (S.viagem) {
    S.viagem.aoMudar(function (v, ev) {
      if (!ev || ev.tipo !== "fim" || ev.motivo === "consentimento_revogado") return;
      backend.pontuar(ev);
    });
  }
})();
