/*
  Assistente de dúvidas (Dá sinal).

  Um botão redondo com o personagem, no canto da tela, que abre um balão com
  perguntas prontas. Não é um chat: as respostas são fixas (sempre certas, sem
  custo e sem mandar nada para fora do aparelho).

  Para mudar ou acrescentar perguntas, edite a lista PERGUNTAS abaixo.
  acoes: botões no fim da resposta. "ir" troca de tela; "ajuda" abre um passo a
  passo do app.js (window.DaSinalAjuda).
*/
(function () {
  "use strict";

  var PERGUNTAS = [
    {
      p: "Como o app sabe onde o ônibus está?",
      r: ["Os ônibus não têm GPS. Quem está dentro toca em “Estou neste ônibus” e compartilha a localização durante a viagem.",
        "O Dá sinal junta as pessoas que estão no mesmo ônibus e mostra no mapa a posição estimada dele."]
    },
    {
      p: "Por que não aparece ônibus na minha linha?",
      r: ["O ônibus só aparece quando alguém dentro dele está compartilhando a viagem.",
        "Com uma pessoa só, leva uns 2 minutos e o ônibus precisa parar em um ponto. Com mais gente, aparece mais rápido.",
        "Está no ônibus? Toque em “Estou neste ônibus” e ajude quem está esperando."],
      acoes: [{ rotulo: "Ver as linhas", ir: "#/linhas" }]
    },
    {
      p: "O que é confiança alta, média e baixa?",
      r: ["É o quanto dá para confiar na posição mostrada.",
        "Alta: 3 ou mais passageiros juntos. Média: 2 passageiros. Baixa: 1 passageiro só."]
    },
    {
      p: "Preciso deixar o app aberto?",
      r: ["Sim. Com a tela bloqueada ou outro aplicativo na frente, o navegador para de ler a localização.",
        "Se o app fechar e você voltar em até 2 minutos, a mesma viagem continua."]
    },
    {
      p: "A localização não funciona. O que eu faço?",
      r: ["Quase sempre é a permissão de localização do navegador que está bloqueada para o Dá sinal.",
        "Veja o passo a passo para liberar no seu celular."],
      acoes: [{ rotulo: "Ver o passo a passo", ajuda: "localizacao" }]
    },
    {
      p: "Alguém vê onde eu estou?",
      r: ["Não. O mapa mostra só a posição estimada do ônibus, nunca a de uma pessoa.",
        "Sua localização vai ligada a um código aleatório da viagem e é apagada em até 24 horas."]
    },
    {
      p: "Como ganho pontos e troco por cupons?",
      r: ["Cada viagem validada (3 minutos junto de um ônibus) vale pontos. Avisos confirmados por outras pessoas também.",
        "Os pontos sobem o seu nível e podem ser trocados por cupons. Para trocar, crie a sua conta."],
      acoes: [{ rotulo: "Meus pontos", ir: "#/meus-pontos" }, { rotulo: "Cupons", ir: "#/cupons" }]
    },
    {
      p: "Como coloco o app na tela inicial?",
      r: ["Dá para deixar o Dá sinal com ícone próprio, igual a um aplicativo."],
      acoes: [{ rotulo: "Ver como fazer", ajuda: "instalar" }]
    }
  ];

  function el(tag, atributos) {
    var n = document.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      if (k === "text") n.textContent = atributos[k]; else n.setAttribute(k, atributos[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) n.append(arguments[i]);
    return n;
  }

  var botao = el("button", { type: "button", class: "assistente-botao", "aria-label": "Tirar dúvidas", "aria-expanded": "false", "aria-controls": "assistente-balao" },
    el("img", { src: "assistente-rosto.png", alt: "", width: "56", height: "56" }));
  var figura = el("img", { class: "assistente-figura", src: "assistente-ola.png", alt: "", width: "92", height: "86" });
  var titulo = el("strong", { text: "Oi! Posso ajudar?" });
  var subtitulo = el("small", { text: "Toque em uma dúvida." });
  var fechar = el("button", { type: "button", class: "assistente-fechar", "aria-label": "Fechar" }, "×");
  var corpo = el("div", { class: "assistente-corpo" });
  var balao = el("section", { class: "assistente-balao", id: "assistente-balao", role: "dialog", "aria-label": "Assistente de dúvidas", hidden: "" },
    el("header", { class: "assistente-topo" }, figura, el("div", {}, titulo, subtitulo), fechar),
    corpo);

  function mostrarLista() {
    figura.src = "assistente-ola.png";
    figura.className = "assistente-figura acenando";
    titulo.textContent = "Oi! Posso ajudar?";
    subtitulo.textContent = "Toque em uma dúvida.";
    corpo.replaceChildren();
    var lista = el("ul", { class: "assistente-lista" });
    PERGUNTAS.forEach(function (q) {
      var b = el("button", { type: "button", text: q.p });
      b.addEventListener("click", function () { mostrarResposta(q); });
      lista.append(el("li", {}, b));
    });
    corpo.append(lista);
    corpo.scrollTop = 0;
  }

  function mostrarResposta(q) {
    figura.src = "assistente-ideia.png";
    figura.className = "assistente-figura animada";
    titulo.textContent = q.p;
    subtitulo.textContent = "";
    corpo.replaceChildren();
    var caixa = el("div", { class: "assistente-resposta" });
    q.r.forEach(function (t) { caixa.append(el("p", { text: t })); });
    var acoes = el("div", { class: "assistente-acoes" });
    (q.acoes || []).forEach(function (a) {
      var b = el("button", { type: "button", class: "btn btn-amarelo btn-pequeno", text: a.rotulo });
      b.addEventListener("click", function () {
        abrirOuFechar(false);
        if (a.ir) location.hash = a.ir;
        else if (a.ajuda && window.DaSinalAjuda && window.DaSinalAjuda[a.ajuda]) window.DaSinalAjuda[a.ajuda]();
      });
      acoes.append(b);
    });
    var voltar = el("button", { type: "button", class: "btn btn-contorno btn-pequeno", text: "Outra dúvida" });
    voltar.addEventListener("click", mostrarLista);
    acoes.append(voltar);
    caixa.append(acoes);
    corpo.append(caixa);
    corpo.scrollTop = 0;
    voltar.focus();
  }

  function abrirOuFechar(abrir) {
    var aberto = abrir == null ? balao.hidden : abrir;
    balao.hidden = !aberto;
    botao.setAttribute("aria-expanded", String(aberto));
    botao.classList.toggle("aberto", aberto);
    if (aberto) { mostrarLista(); try { window.localStorage.setItem("dasinal.assistente.visto", "1"); } catch (e) { /* segue */ } botao.classList.remove("novo"); }
  }

  botao.addEventListener("click", function () { abrirOuFechar(); });
  fechar.addEventListener("click", function () { abrirOuFechar(false); botao.focus(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !balao.hidden) { abrirOuFechar(false); botao.focus(); } });
  // Tocar fora fecha.
  document.addEventListener("click", function (e) {
    // (O botão de uma pergunta sai da tela ao ser tocado: sem esta checagem contaria como "fora".)
    if (!document.body.contains(e.target)) return;
    if (!balao.hidden && !balao.contains(e.target) && !botao.contains(e.target)) abrirOuFechar(false);
  });
  // Mudou de tela: fecha (o balão não fica por cima da tela nova).
  window.addEventListener("hashchange", function () { abrirOuFechar(false); });

  // Quem nunca abriu vê o botão chamar atenção (um aceno) nas primeiras vezes.
  try { if (!window.localStorage.getItem("dasinal.assistente.visto")) botao.classList.add("novo"); } catch (e) { /* segue */ }

  document.body.append(botao, balao);
})();
