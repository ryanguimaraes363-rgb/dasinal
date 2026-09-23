/*
  Avisos dos passageiros (Dá sinal): atraso, lotação, ônibus com defeito…

  Um aviso vale para UMA linha e some sozinho (45 min; cada "Também vi" estende
  15 min, até 2 h). Quem avisou nunca aparece. Regras (limites, filtro de
  texto, pontos) ficam no banco: supabase/migracoes/006_avisos.sql. Na
  demonstração, este arquivo imita as mesmas regras neste navegador.

  Interface: DaSinal.avisos
    TIPOS                         [{ codigo, nome, icone }]
    tipo(codigo)                  um item de TIPOS
    listar(linhaId)               Promise<[{ id, tipo, texto, criadoEm, expiraEm, confirmacoes, naViagem, meu, confirmei }]>
    resumo()                      Promise<{ linhaId: quantidade }>
    criar(linha, tipo, texto)     Promise<{ id, juntou }>   (erros: ver MENSAGENS em app.js)
    confirmar(id)                 Promise ("Também vi")
    retirar(id)                   Promise (o autor tira o próprio aviso)
    textoRecusado(texto)          null ou o motivo ("link" | "contato" | "palavra"), antes de enviar
    aoMudar(cb)                   cb(linhaId) quando os avisos de uma linha mudam por ação deste app
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  var CFG = S.config;
  var client = S.client;
  var noServidor = S.modo === "supabase" && !!client;

  var TIPOS = [
    { codigo: "atrasado", nome: "Atrasado", icone: "relogio" },
    { codigo: "nao_passou", nome: "Não passou", icone: "proibido" },
    { codigo: "lotado", nome: "Lotado", icone: "grupo" },
    { codigo: "defeito", nome: "Ônibus com defeito", icone: "ferramenta" },
    { codigo: "transito", nome: "Acidente ou trânsito", icone: "alerta" },
    { codigo: "ponto", nome: "Problema no ponto", icone: "pin" },
    { codigo: "outro", nome: "Outro problema", icone: "megafone" }
  ];

  var DURACAO_MS = 45 * 60000;
  var EXTENSAO_MS = 15 * 60000;
  var MAXIMO_MS = 2 * 3600000;
  var ouvintes = [];

  function tipo(codigo) {
    return TIPOS.filter(function (t) { return t.codigo === codigo; })[0] || TIPOS[TIPOS.length - 1];
  }

  function notificar(linhaId) {
    ouvintes.slice().forEach(function (cb) { try { cb(linhaId); } catch (e) { /* segue */ } });
  }

  // Mesmo filtro do banco (aviso_texto_recusado), para avisar antes de enviar.
  function textoRecusado(texto) {
    var t = String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (/(https?:\/\/|www\.|\.com\b|\.br\b|\.net\b)/.test(t)) return "link";
    if (t.indexOf("@") >= 0 || /[0-9]{4}[ .-]?[0-9]{4}/.test(t)) return "contato";
    if (/(^|[^a-z0-9_])(porra|caralh\w*|merda\w*|puta\w*|puto\w*|fdp|pqp|vsf|viad\w*|bucet\w*|cu|cuzao|arromb\w*|desgrac\w*|vagabund\w*|otari\w*|idiota\w*|imbecil\w*|corn[oa]\w*|piranh\w*|fod\w*|foder|cacete|babac\w*|retardad\w*)(?![a-z0-9_])/.test(t)) return "palavra";
    return null;
  }

  function limparTexto(texto) {
    var t = String(texto || "").replace(/\s+/g, " ").trim();
    return t || null;
  }

  function erro(codigo) { return { message: codigo }; }

  // ---------- Demonstração: tudo neste navegador ----------

  var CHAVE = "dasinal.avisos.v1";
  var simular = CFG.DEMO_PASSAGEIROS_SIMULADOS !== false;

  function ler() {
    try {
      var d = JSON.parse(window.localStorage.getItem(CHAVE) || "null");
      if (d && Array.isArray(d.avisos)) return d;
    } catch (e) { /* sem armazenamento */ }
    return { avisos: [], confirmei: [], semeado: {} };
  }

  function gravar(d) {
    try { window.localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* sem armazenamento */ }
  }

  function ativos(d, linhaId, agora) {
    return d.avisos.filter(function (a) {
      return String(a.linhaId) === String(linhaId) && !a.oculto && a.expiraEm > agora;
    });
  }

  // Na primeira vez que alguém olha a linha, aparece um aviso fictício de "outro passageiro".
  function semear(d, linhaId, agora) {
    if (!simular || d.semeado[linhaId]) return;
    d.semeado[linhaId] = true;
    d.avisos.push({
      id: "demo-" + linhaId + "-" + agora, linhaId: linhaId, tipo: "lotado", texto: null, naViagem: true,
      confirmacoes: 2, meu: false, criadoEm: agora - 9 * 60000, expiraEm: agora + 36 * 60000 + 2 * EXTENSAO_MS
    });
  }

  function somar(a, agora) {
    a.confirmacoes++;
    a.expiraEm = Math.min(a.criadoEm + MAXIMO_MS, Math.max(a.expiraEm, agora) + EXTENSAO_MS);
  }

  // Passageiros simulados confirmam o aviso de quem usa a demonstração;
  // com 2 confirmações o autor ganha os pontos (como no servidor).
  function simularConfirmacoes(id, linha) {
    if (!simular) return;
    [25000, 55000].forEach(function (espera) {
      setTimeout(function () {
        var d = ler();
        var a = d.avisos.filter(function (x) { return x.id === id; })[0];
        if (!a || a.expiraEm <= Date.now()) return;
        somar(a, Date.now());
        gravar(d);
        if (a.confirmacoes === 2 && S.pontos && S.pontos.creditarAvisoDemo) S.pontos.creditarAvisoDemo({ avisoId: id, linhaNumero: linha.numero });
        notificar(a.linhaId);
      }, espera);
    });
  }

  var demo = {
    listar: function (linhaId) {
      var d = ler();
      var agora = Date.now();
      semear(d, linhaId, agora);
      gravar(d);
      return Promise.resolve(ativos(d, linhaId, agora).sort(function (a, b) {
        return b.confirmacoes - a.confirmacoes || b.criadoEm - a.criadoEm;
      }).map(function (a) {
        return Object.assign({}, a, { confirmei: d.confirmei.indexOf(a.id) >= 0 });
      }));
    },
    resumo: function () {
      var d = ler();
      var agora = Date.now();
      var r = {};
      d.avisos.forEach(function (a) {
        if (!a.oculto && a.expiraEm > agora) r[a.linhaId] = (r[a.linhaId] || 0) + 1;
      });
      return Promise.resolve(r);
    },
    criar: function (linha, codigo, texto) {
      var d = ler();
      var agora = Date.now();
      var t = limparTexto(texto);
      if (codigo === "outro" && !t) return Promise.reject(erro("texto_obrigatorio"));
      if (t && t.length > 80) return Promise.reject(erro("texto_longo"));
      if (t && t.length < 3) return Promise.reject(erro("texto_curto"));
      if (t && textoRecusado(t)) return Promise.reject(erro("texto_recusado:" + textoRecusado(t)));
      var naHora = d.avisos.filter(function (a) { return a.meu && a.criadoEm > agora - 3600000; });
      if (naHora.length >= 5) return Promise.reject(erro("limite_avisos"));
      if (codigo !== "outro") {
        var igual = ativos(d, linha.id, agora).filter(function (a) { return a.tipo === codigo; })[0];
        if (igual) {
          if (igual.meu) return Promise.reject(erro("aviso_repetido"));
          if (d.confirmei.indexOf(igual.id) < 0) { d.confirmei.push(igual.id); somar(igual, agora); }
          gravar(d);
          notificar(linha.id);
          return Promise.resolve({ id: igual.id, juntou: true });
        }
      }
      var v = S.viagem && S.viagem.atual();
      var novo = {
        id: "meu-" + agora, linhaId: linha.id, tipo: codigo, texto: t, confirmacoes: 0, meu: true,
        naViagem: !!(v && String(v.linhaId) === String(linha.id) && v.situacao && v.situacao.emRota),
        criadoEm: agora, expiraEm: agora + DURACAO_MS
      };
      d.avisos.push(novo);
      d.avisos = d.avisos.filter(function (a) { return a.criadoEm > agora - 7 * 86400000; });
      gravar(d);
      simularConfirmacoes(novo.id, linha);
      notificar(linha.id);
      return Promise.resolve({ id: novo.id, juntou: false });
    },
    confirmar: function (id) {
      var d = ler();
      var agora = Date.now();
      var a = d.avisos.filter(function (x) { return x.id === id; })[0];
      if (!a || a.expiraEm <= agora) return Promise.reject(erro("aviso_encerrado"));
      if (a.meu) return Promise.reject(erro("proprio_aviso"));
      if (d.confirmei.indexOf(id) < 0) { d.confirmei.push(id); somar(a, agora); }
      gravar(d);
      notificar(a.linhaId);
      return Promise.resolve();
    },
    retirar: function (id) {
      var d = ler();
      var a = d.avisos.filter(function (x) { return x.id === id && x.meu; })[0];
      if (a) { a.expiraEm = Date.now(); gravar(d); notificar(a.linhaId); }
      return Promise.resolve();
    }
  };

  // ---------- Supabase ----------

  function rpc(nome, args) {
    return client.rpc(nome, args || {}).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  // Avisar precisa de uma sessão (login anônimo, como em "Estou neste ônibus").
  function garantirSessao() {
    return client.auth.getSession().then(function (r) {
      if (r.data && r.data.session) return r.data.session;
      return client.auth.signInAnonymously().then(function (x) {
        if (x.error) throw x.error;
        return x.data.session;
      });
    });
  }

  function doServidor(a) {
    return {
      id: a.id, tipo: a.tipo, texto: a.texto || null, confirmacoes: a.confirmacoes || 0,
      naViagem: !!a.na_viagem, meu: !!a.meu, confirmei: !!a.confirmei,
      criadoEm: Date.parse(a.criado_em), expiraEm: Date.parse(a.expira_em)
    };
  }

  var servidor = {
    listar: function (linhaId) {
      return rpc("avisos_da_linha", { p_linha_id: linhaId }).then(function (l) { return (l || []).map(doServidor); });
    },
    resumo: function () {
      return rpc("avisos_resumo").then(function (r) { return r || {}; });
    },
    criar: function (linha, codigo, texto) {
      return garantirSessao().then(function () {
        return rpc("criar_aviso", { p_linha_id: linha.id, p_tipo: codigo, p_texto: limparTexto(texto) });
      }).then(function (r) { notificar(linha.id); return r; });
    },
    confirmar: function (id, linhaId) {
      return garantirSessao().then(function () {
        return rpc("confirmar_aviso", { p_aviso_id: id });
      }).then(function () { notificar(linhaId); });
    },
    retirar: function (id, linhaId) {
      return rpc("retirar_meu_aviso", { p_aviso_id: id }).then(function () { notificar(linhaId); });
    }
  };

  var backend = noServidor ? servidor : demo;

  S.avisos = {
    TIPOS: TIPOS,
    tipo: tipo,
    noServidor: noServidor,
    listar: backend.listar,
    resumo: backend.resumo,
    criar: backend.criar,
    confirmar: backend.confirmar,
    retirar: backend.retirar,
    textoRecusado: textoRecusado,
    // Apaga o que a demonstração guardou (junto com "Excluir meus dados").
    apagarDemo: function () { try { window.localStorage.removeItem(CHAVE); } catch (e) { /* nada */ } },
    aoMudar: function (cb) {
      ouvintes.push(cb);
      return function () { var i = ouvintes.indexOf(cb); if (i >= 0) ouvintes.splice(i, 1); };
    }
  };
})();
