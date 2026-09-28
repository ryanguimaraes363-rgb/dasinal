/*
  Painel de diagnóstico do GPS (Dá sinal) — só aparece com ?diag=1 no endereço:
    https://ryanguimaraes363-rgb.github.io/dasinal/?diag=1

  Para testes em campo: mostra na tela o que o console mostraria (no celular
  ninguém vê o console). Não mostra coordenadas, não grava nada e não envia
  nada: só lê o estado de servicos.js (mapa) e viagem.js (Estou neste ônibus).
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  if (!S || !S.gps || !S.gps.diagnostico) return;

  var permissao = "…";
  function lerPermissao() { S.gps.estadoPermissao().then(function (s) { permissao = s; }); }
  lerPermissao();
  setInterval(lerPermissao, 5000);

  var caixa = document.createElement("aside");
  caixa.className = "diag-gps";
  caixa.setAttribute("aria-label", "Diagnóstico do GPS");
  var texto = document.createElement("pre");
  var fechar = document.createElement("button");
  fechar.type = "button";
  fechar.textContent = "×";
  fechar.setAttribute("aria-label", "Minimizar diagnóstico");
  fechar.addEventListener("click", function () { caixa.classList.toggle("mini"); });
  caixa.append(fechar, texto);
  document.body.append(caixa);

  function sim(v) { return v ? "sim" : "NÃO"; }
  function seg(ms) { return ms == null ? "—" : Math.round((Date.now() - ms) / 1000) + " s atrás"; }

  function desenhar() {
    var linhas = [
      "DIAGNÓSTICO DO GPS (?diag=1)",
      "suporte à localização: " + sim(!!navigator.geolocation),
      "endereço seguro (https): " + sim(window.isSecureContext !== false),
      "navegador de aplicativo: " + (S.gps.navegadorEmbutido() || "não"),
      "permissão (informativo): " + permissao,
      ""
    ];
    var m = S.localizacao.diag();
    linhas.push("MINHA LOCALIZAÇÃO (mapa): " + m.estado);
    if (m.inicio) {
      linhas.push("  leituras: " + m.leituras + " | precisão: " + (m.precisao != null ? "±" + m.precisao + " m" : "—"));
      if (m.erro) linhas.push("  último erro: " + m.erro.code + " " + m.erro.nome + " (" + seg(m.erro.em) + ")");
    }
    var v = S.viagem.diag && S.viagem.diag();
    linhas.push("", "ESTOU NESTE ÔNIBUS: " + (v ? v.estado : "desligado"));
    if (v) {
      var atual = S.viagem.atual();
      linhas.push("  viagem no servidor: " + (atual && atual.viagemId ? "criada" : "aguardando…"));
      linhas.push("  leituras: " + v.lidas + " | aceitas: " + v.aceitas + " | imprecisas (>100 m): " + v.imprecisas);
      linhas.push("  precisão: última " + (v.ultimaPrecisao != null ? "±" + v.ultimaPrecisao + " m" : "—") +
        " | melhor " + (v.melhorPrecisao != null ? "±" + v.melhorPrecisao + " m" : "—"));
      linhas.push("  1ª posição após: " + (v.primeiraPosicaoS != null ? v.primeiraPosicaoS + " s" : "—") +
        " | tela ligada: " + sim(v.telaLigada));
      var erros = Object.keys(v.erros).map(function (k) { return k + "×" + v.erros[k]; }).join(", ");
      linhas.push("  erros (1 negada, 2 indisponível, 3 demorou): " + (erros || "nenhum"));
      linhas.push("  enviadas ao servidor: " + (atual ? atual.enviadas : 0));
    }
    texto.textContent = linhas.join("\n");
  }
  desenhar();
  setInterval(desenhar, 1000);
})();
