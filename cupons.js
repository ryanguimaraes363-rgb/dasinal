/*
  Troca de pontos por cupons em lojas parceiras (Dá sinal).

  PILOTO COM LOJAS FICTÍCIAS, para demonstração: o app mostra "Loja fictícia".
  Regras no banco (supabase/migracoes/011_cupons.sql); na demonstração, este
  arquivo imita as mesmas regras neste navegador:
    - só com conta cadastrada (usuário e senha);
    - saldo = pontos ganhos - pontos trocados (o nível não cai ao trocar);
    - até 3 cupons por semana; estoque por mês;
    - código único DS-XXXXXX, vale 48 h e uma vez só;
    - a loja valida com código + PIN (todas as fictícias: 1234) e não sabe quem é a pessoa.

  Interface: DaSinal.cupons
    catalogo()                  Promise<[{ id, titulo, descricao, custo, restantes, validadeHoras, loja }]>
    meus()                      Promise<{ saldo, cadastrada, semana, cupons: [...] }>
    resgatar(recompensaId)      Promise<{ codigo, saldo }>   (erros: MENSAGENS_CUPOM em app.js)
    validar(codigo, pin, usar)  Promise<{ ok, erro?, titulo, loja, ... }>   (página da loja)
    linkLoja(codigo)            endereço da página da loja já com o código (vai no QR code)
    aoMudar(cb)
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  var client = S.client;
  var noServidor = S.modo === "supabase" && !!client;
  var ouvintes = [];
  var LIMITE_SEMANA = 3;

  function notificar() { ouvintes.slice().forEach(function (cb) { try { cb(); } catch (e) { /* segue */ } }); }
  function erro(codigo) { return { codigo: codigo, message: codigo }; }

  // Endereço da página da loja (mesma pasta do app), com o código já preenchido.
  function linkLoja(codigo) {
    var base = window.location.href.split("#")[0].split("?")[0].replace(/[^\/]*$/, "");
    return base + "loja.html?codigo=" + encodeURIComponent(codigo);
  }

  // ---------- Demonstração: tudo neste navegador ----------

  // As mesmas lojas e recompensas FICTÍCIAS de 011_cupons.sql.
  var LOJAS = {
    1: { id: 1, nome: "Cantina Sabor do Campus", categoria: "Lanchonete", endereco: "Bloco central (fictícia)", icone: "cafe", ficticia: true },
    2: { id: 2, nome: "Papelaria Ponto & Vírgula", categoria: "Papelaria e cópias", endereco: "Rua das Letras, 100 (fictícia)", icone: "papel", ficticia: true },
    3: { id: 3, nome: "Açaí da Estação", categoria: "Açaí e sorvetes", endereco: "Praça da Estação (fictícia)", icone: "sorvete", ficticia: true },
    4: { id: 4, nome: "Farmácia Bem Viver", categoria: "Farmácia", endereco: "Av. da Saúde, 250 (fictícia)", icone: "farmacia", ficticia: true },
    5: { id: 5, nome: "Cine Lanterna", categoria: "Cinema", endereco: "Shopping Imaginário (fictício)", icone: "cinema", ficticia: true }
  };
  var RECOMPENSAS = [
    { id: 1, loja: 1, titulo: "Pão de queijo + café", descricao: "Um pão de queijo e um café pequeno.", custo: 80, estoque: 60 },
    { id: 2, loja: 1, titulo: "10% no lanche", descricao: "Desconto em qualquer lanche do cardápio.", custo: 120, estoque: 60 },
    { id: 3, loja: 2, titulo: "20 impressões grátis", descricao: "Impressão preto e branco, tamanho A4.", custo: 100, estoque: 40 },
    { id: 4, loja: 2, titulo: "15% em material escolar", descricao: "Cadernos, canetas e afins.", custo: 200, estoque: 30 },
    { id: 5, loja: 3, titulo: "Açaí de 300 ml", descricao: "Com até dois acompanhamentos.", custo: 250, estoque: 25 },
    { id: 6, loja: 4, titulo: "10% em higiene pessoal", descricao: "Não vale para medicamentos.", custo: 150, estoque: 40 },
    { id: 7, loja: 5, titulo: "Ingresso de meia-entrada", descricao: "Para qualquer sessão de segunda a quinta.", custo: 400, estoque: 15 }
  ];
  var VALIDADE_MS = 48 * 3600000;
  var PIN_DEMO = "1234";
  var CHAVE = "dasinal.cupons.v1";
  var ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function ler() {
    try { var d = JSON.parse(window.localStorage.getItem(CHAVE) || "null"); if (d && Array.isArray(d.resgates)) return d; } catch (e) { /* nada */ }
    return { resgates: [] };
  }
  function gravar(d) { try { window.localStorage.setItem(CHAVE, JSON.stringify(d)); } catch (e) { /* nada */ } }

  function inicioDoMes(ms) { var d = new Date(ms - 3 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + 3 * 3600000; }
  function novoCodigo() {
    var b = new Uint8Array(6), c = "DS-";
    window.crypto.getRandomValues(b);
    for (var i = 0; i < 6; i++) c += ALFABETO[b[i] % 32];
    return c;
  }
  function limpar(codigo) {
    var c = String(codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return c.indexOf("DS") === 0 ? "DS-" + c.slice(2) : c;
  }
  function recompensa(id) { return RECOMPENSAS.filter(function (r) { return r.id === Number(id); })[0]; }

  function pontosGanhos() {
    return S.pontos ? S.pontos.resumo().then(function (r) { return r.pontosTotal || 0; }, function () { return 0; }) : Promise.resolve(0);
  }
  function contaCadastrada() {
    return S.conta ? S.conta.estado().then(function (e) { return e.tipo === "cadastrada"; }, function () { return false; }) : Promise.resolve(false);
  }

  var demo = {
    catalogo: function () {
      var d = ler(), desde = inicioDoMes(Date.now());
      return Promise.resolve(RECOMPENSAS.map(function (r) {
        var usados = d.resgates.filter(function (x) { return x.recompensaId === r.id && x.criadoEm >= desde; }).length;
        return { id: r.id, titulo: r.titulo, descricao: r.descricao, custo: r.custo, validadeHoras: 48,
          restantes: Math.max(0, r.estoque - usados), loja: LOJAS[r.loja] };
      }));
    },
    meus: function () {
      return Promise.all([pontosGanhos(), contaCadastrada()]).then(function (x) {
        var d = ler(), agora = Date.now();
        var gastos = d.resgates.reduce(function (s, r) { return s + r.pontos; }, 0);
        return {
          saldo: x[0] - gastos, cadastrada: x[1],
          semana: d.resgates.filter(function (r) { return r.criadoEm > agora - 7 * 86400000; }).length,
          cupons: d.resgates.slice().sort(function (a, b) { return b.criadoEm - a.criadoEm; }).map(function (r) {
            var rec = recompensa(r.recompensaId);
            return { id: r.codigo, codigo: r.codigo, pontos: r.pontos, criadoEm: r.criadoEm, expiraEm: r.expiraEm, usadoEm: r.usadoEm,
              titulo: rec.titulo, descricao: rec.descricao, loja: LOJAS[rec.loja] };
          })
        };
      });
    },
    resgatar: function (id) {
      var rec = recompensa(id);
      if (!rec) return Promise.reject(erro("recompensa_invalida"));
      return demo.meus().then(function (m) {
        if (!m.cadastrada) throw erro("conta_anonima");
        if (m.saldo < rec.custo) throw erro("saldo_insuficiente");
        if (m.semana >= LIMITE_SEMANA) throw erro("limite_semana");
        return demo.catalogo().then(function (cat) {
          if (!cat.filter(function (c) { return c.id === rec.id; })[0].restantes) throw erro("esgotado");
          var d = ler(), agora = Date.now(), codigo = novoCodigo();
          d.resgates.push({ codigo: codigo, recompensaId: rec.id, pontos: rec.custo, criadoEm: agora, expiraEm: agora + VALIDADE_MS, usadoEm: null });
          gravar(d);
          notificar();
          return { codigo: codigo, saldo: m.saldo - rec.custo };
        });
      });
    },
    validar: function (codigo, pin, usar) {
      var d = ler(), c = limpar(codigo);
      var x = d.resgates.filter(function (r) { return r.codigo === c; })[0];
      if (!x) return Promise.resolve({ ok: false, erro: "codigo_invalido" });
      var rec = recompensa(x.recompensaId), loja = LOJAS[rec.loja];
      if (String(pin || "") !== PIN_DEMO) return Promise.resolve({ ok: false, erro: "pin_invalido" });
      if (x.usadoEm) return Promise.resolve({ ok: false, erro: "ja_usado", usadoEm: new Date(x.usadoEm).toISOString(), titulo: rec.titulo, loja: loja.nome });
      if (x.expiraEm < Date.now()) return Promise.resolve({ ok: false, erro: "expirado", titulo: rec.titulo, loja: loja.nome });
      if (usar) { x.usadoEm = Date.now(); gravar(d); notificar(); }
      return Promise.resolve({ ok: true, usado: !!usar, titulo: rec.titulo, descricao: rec.descricao, loja: loja.nome, ficticia: true,
        expiraEm: new Date(x.expiraEm).toISOString(), codigo: x.codigo });
    },
    apagar: function () { try { window.localStorage.removeItem(CHAVE); } catch (e) { /* nada */ } },
    // Mesmo formato de admin_cupons() (painel), com as trocas deste navegador.
    resumoAdmin: function () {
      var d = ler();
      return Promise.resolve(RECOMPENSAS.map(function (r) {
        var deste = d.resgates.filter(function (x) { return x.recompensaId === r.id; });
        return { loja: LOJAS[r.loja].nome, titulo: r.titulo, custo: r.custo, resgatados: deste.length,
          usados: deste.filter(function (x) { return x.usadoEm; }).length };
      }));
    }
  };

  // ---------- Supabase ----------

  function rpc(nome, args) {
    return client.rpc(nome, args || {}).then(function (r) {
      if (r.error) throw erro((String(r.error.message).match(/[a-z_]+/) || ["falha"])[0]);
      return r.data;
    });
  }
  function temSessao() { return client.auth.getSession().then(function (r) { return !!(r.data && r.data.session); }); }
  function paraData(x) { return x == null ? null : Date.parse(x); }

  var servidor = {
    catalogo: function () { return rpc("recompensas_catalogo").then(function (l) { return l || []; }); },
    meus: function () {
      return temSessao().then(function (ok) {
        if (!ok) return { saldo: 0, cadastrada: false, semana: 0, cupons: [] };
        return rpc("meus_cupons").then(function (m) {
          m.cupons = (m.cupons || []).map(function (c) {
            return Object.assign({}, c, { criadoEm: paraData(c.criadoEm), expiraEm: paraData(c.expiraEm), usadoEm: paraData(c.usadoEm) });
          });
          return m;
        });
      });
    },
    resgatar: function (id) {
      return rpc("resgatar_recompensa", { p_recompensa_id: id }).then(function (r) { notificar(); return r; });
    },
    validar: function (codigo, pin, usar) {
      return rpc("validar_cupom", { p_codigo: codigo, p_pin: pin, p_usar: !!usar }).then(function (r) { if (usar) notificar(); return r; });
    },
    apagar: function () { /* excluir_meus_dados apaga a conta e os cupons junto */ },
    resumoAdmin: function () { return rpc("admin_cupons").then(function (l) { return l || []; }); }
  };

  var backend = noServidor ? servidor : demo;

  S.cupons = {
    noServidor: noServidor,
    catalogo: backend.catalogo,
    meus: backend.meus,
    resgatar: backend.resgatar,
    validar: backend.validar,
    apagar: backend.apagar,
    resumoAdmin: backend.resumoAdmin,
    linkLoja: linkLoja,
    LIMITE_SEMANA: LIMITE_SEMANA,
    aoMudar: function (cb) {
      ouvintes.push(cb);
      return function () { var i = ouvintes.indexOf(cb); if (i >= 0) ouvintes.splice(i, 1); };
    }
  };
})();
