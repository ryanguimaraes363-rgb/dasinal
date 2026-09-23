/*
  Conta com usuário e senha ("Salvar meus pontos") · Dá sinal

  Sem e-mail de verdade: o nome de usuário vira um endereço interno
  (ryan123 -> ryan123@usuarios.dasinal.app) e a conta anônima de quem já usa
  o app vira permanente, com o mesmo id. Pontos, conquistas e ranking
  continuam. Senha esquecida: código de recuperação mostrado no cadastro
  (supabase/migracoes/007_contas.sql e a Edge Function recuperar-conta).

  Na demonstração, a conta fica só neste navegador.

  Interface: DaSinal.conta
    estado()                          Promise<{ tipo: "nenhuma" | "anonima" | "cadastrada", usuario }>
    validarUsuario(u), validarSenha(s)  null ou o código do problema
    criar(usuario, senha)             Promise<{ codigo }>  (código de recuperação, mostrado uma vez)
    entrar(usuario, senha)            Promise
    sair()                            Promise
    recuperar(usuario, codigo, senha) Promise<{ codigo }>  (troca a senha, entra e devolve um código novo)
    novoCodigo()                      Promise<{ codigo }>  (o anterior deixa de valer)
    aoMudar(cb)                       cb(estado) quando entra, sai ou cria a conta
  Erros: { codigo } com um dos códigos de MENSAGENS_CONTA em app.js.
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  var client = S.client;
  var noServidor = S.modo === "supabase" && !!client;
  var DOMINIO = "usuarios.dasinal.app"; // o mesmo da Edge Function recuperar-conta
  var ouvintes = [];

  function erro(codigo) { return { codigo: codigo, message: codigo }; }

  function normalizar(u) { return String(u || "").trim().toLowerCase(); }

  function validarUsuario(u) {
    u = normalizar(u);
    if (u.length < 3 || u.length > 20) return "usuario_tamanho";
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(u)) return "usuario_caracteres";
    return null;
  }

  function validarSenha(s) {
    s = String(s || "");
    if (s.length < 8) return "senha_curta";
    if (s.length > 72) return "senha_longa";
    if (/^(.)\1+$/.test(s) || /^(12345678|87654321|senha123|password)/i.test(s)) return "senha_fraca";
    return null;
  }

  function emailDe(u) { return normalizar(u) + "@" + DOMINIO; }

  function usuarioDe(email) {
    var e = String(email || "").toLowerCase();
    var fim = "@" + DOMINIO;
    return e.slice(-fim.length) === fim ? e.slice(0, -fim.length) : (e || null);
  }

  function notificar() {
    backend.estado().then(function (e) {
      ouvintes.slice().forEach(function (cb) { try { cb(e); } catch (x) { /* segue */ } });
    });
  }

  function validar(usuario, senha) {
    var p = validarUsuario(usuario) || validarSenha(senha);
    return p ? Promise.reject(erro(p)) : null;
  }

  // ---------- Demonstração: tudo neste navegador ----------

  var CHAVE = "dasinal.conta.demo.v1";
  var ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function ler() {
    try { var d = JSON.parse(window.localStorage.getItem(CHAVE) || "null"); if (d && d.contas) return d; } catch (e) { /* nada */ }
    return { contas: {}, atual: null };
  }
  function gravar(d) { try { window.localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* nada */ } }

  // Só para a demonstração (não é segurança de verdade: no servidor quem guarda a senha é o Supabase).
  function resumoDe(t) {
    var h = 5381;
    for (var i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function codigoNovo() {
    var c = "";
    var b = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
    for (var i = 0; i < 12; i++) c += ALFABETO[b[i] % 32];
    return c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8);
  }
  function limparCodigo(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

  var demo = {
    estado: function () {
      var d = ler();
      return Promise.resolve(d.atual ? { tipo: "cadastrada", usuario: d.atual } : { tipo: "anonima", usuario: null });
    },
    criar: function (usuario, senha) {
      var v = validar(usuario, senha); if (v) return v;
      var u = normalizar(usuario);
      var d = ler();
      if (d.contas[u]) return Promise.reject(erro("usuario_em_uso"));
      var codigo = codigoNovo();
      d.contas[u] = { senha: resumoDe(senha), codigo: resumoDe(limparCodigo(codigo)) };
      d.atual = u;
      gravar(d);
      notificar();
      return Promise.resolve({ codigo: codigo });
    },
    entrar: function (usuario, senha) {
      var u = normalizar(usuario);
      var d = ler();
      if (!d.contas[u] || d.contas[u].senha !== resumoDe(String(senha || ""))) return Promise.reject(erro("login_invalido"));
      d.atual = u;
      gravar(d);
      notificar();
      return Promise.resolve();
    },
    sair: function () {
      var d = ler(); d.atual = null; gravar(d); notificar();
      return Promise.resolve();
    },
    recuperar: function (usuario, codigo, senha) {
      var p = validarSenha(senha); if (p) return Promise.reject(erro(p));
      var u = normalizar(usuario);
      var d = ler();
      if (!d.contas[u] || d.contas[u].codigo !== resumoDe(limparCodigo(codigo))) return Promise.reject(erro("codigo_invalido"));
      var novo = codigoNovo();
      d.contas[u] = { senha: resumoDe(senha), codigo: resumoDe(limparCodigo(novo)) };
      d.atual = u;
      gravar(d);
      notificar();
      return Promise.resolve({ codigo: novo });
    },
    novoCodigo: function () {
      var d = ler();
      if (!d.atual) return Promise.reject(erro("conta_anonima"));
      var novo = codigoNovo();
      d.contas[d.atual].codigo = resumoDe(limparCodigo(novo));
      gravar(d);
      return Promise.resolve({ codigo: novo });
    },
    apagar: function () {
      var d = ler();
      if (d.atual) delete d.contas[d.atual];
      d.atual = null;
      gravar(d);
      notificar();
    }
  };

  // ---------- Supabase ----------

  function rpc(nome, args) {
    return client.rpc(nome, args || {}).then(function (r) { if (r.error) throw r.error; return r.data; });
  }

  function garantirSessao() {
    return client.auth.getSession().then(function (r) {
      if (r.data && r.data.session) return r.data.session;
      return client.auth.signInAnonymously().then(function (x) { if (x.error) throw x.error; return x.data.session; });
    });
  }

  function codigoDoErro(e) {
    var c = String((e && (e.code || e.error_code)) || "");
    var m = String((e && e.message) || "");
    if (c === "email_exists" || c === "user_already_exists" || /already (been )?registered|already exists/i.test(m)) return "usuario_em_uso";
    if (c === "weak_password" || /password/i.test(m) && /weak|short|characters/i.test(m)) return "senha_fraca";
    if (c === "invalid_credentials" || /invalid login/i.test(m)) return "login_invalido";
    if (c === "over_email_send_rate_limit" || c === "email_address_not_authorized") return "confirmacao_ligada";
    if (c === "over_request_rate_limit" || /rate limit/i.test(m)) return "muitas_tentativas";
    return "falha";
  }

  var servidor = {
    estado: function () {
      return client.auth.getSession().then(function (r) {
        var sessao = r.data && r.data.session;
        if (!sessao) return { tipo: "nenhuma", usuario: null };
        var u = sessao.user;
        if (u.is_anonymous) return { tipo: "anonima", usuario: null };
        return { tipo: "cadastrada", usuario: usuarioDe(u.email) };
      });
    },
    criar: function (usuario, senha) {
      var v = validar(usuario, senha); if (v) return v;
      return garantirSessao().then(function (sessao) {
        if (!sessao.user.is_anonymous) throw erro("ja_cadastrada");
        return client.auth.updateUser({ email: emailDe(usuario), password: senha });
      }).then(function (r) {
        if (r.error) throw erro(codigoDoErro(r.error));
        // Com "Confirm email" ligado no Supabase, o endereço fica pendente e a conta continua anônima.
        if (!r.data.user || !r.data.user.email) throw erro("confirmacao_ligada");
        // O token ainda diz "anônimo" até ser renovado.
        return client.auth.refreshSession();
      }).then(function () {
        return rpc("gerar_codigo_recuperacao");
      }).then(function (codigo) {
        notificar();
        return { codigo: codigo };
      }, function (e) { throw e && e.codigo ? e : erro(codigoDoErro(e)); });
    },
    entrar: function (usuario, senha) {
      return client.auth.signInWithPassword({ email: emailDe(usuario), password: String(senha || "") }).then(function (r) {
        if (r.error) throw erro(codigoDoErro(r.error));
        notificar();
      });
    },
    sair: function () {
      return client.auth.signOut({ scope: "local" }).then(function () { notificar(); });
    },
    recuperar: function (usuario, codigo, senha) {
      var p = validarSenha(senha); if (p) return Promise.reject(erro(p));
      return client.functions.invoke("recuperar-conta", { body: { usuario: normalizar(usuario), codigo: codigo, senha: senha } }).then(function (r) {
        if (!r.error) return r.data;
        var resp = r.error.context;
        return (resp && resp.json ? resp.json() : Promise.reject(r.error)).then(function (corpo) {
          throw erro((corpo && corpo.erro) || "falha");
        }, function () { throw erro("falha"); });
      }).then(function (d) {
        return client.auth.signInWithPassword({ email: emailDe(usuario), password: senha }).then(function (r) {
          if (r.error) throw erro(codigoDoErro(r.error));
          notificar();
          return { codigo: d.codigo };
        });
      });
    },
    novoCodigo: function () {
      return rpc("gerar_codigo_recuperacao").then(function (codigo) { return { codigo: codigo }; },
        function (e) { throw erro(/conta_anonima/.test(String(e && e.message)) ? "conta_anonima" : "falha"); });
    },
    apagar: function () { notificar(); } // excluir_meus_dados já apaga a conta no servidor
  };

  var backend = noServidor ? servidor : demo;

  // Sem client.auth.onAuthStateChange de propósito: com ele registrado, as
  // chamadas seguintes a getSession() travavam (supabase-js 2.45). Cada ação
  // acima já avisa as telas com notificar().

  S.conta = {
    noServidor: noServidor,
    estado: backend.estado,
    validarUsuario: validarUsuario,
    validarSenha: validarSenha,
    normalizar: normalizar,
    criar: backend.criar,
    entrar: backend.entrar,
    sair: backend.sair,
    recuperar: backend.recuperar,
    novoCodigo: backend.novoCodigo,
    apagar: backend.apagar,
    aoMudar: function (cb) {
      ouvintes.push(cb);
      return function () { var i = ouvintes.indexOf(cb); if (i >= 0) ouvintes.splice(i, 1); };
    }
  };
})();
