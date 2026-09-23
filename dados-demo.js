/*
  Dados de demonstração.
  Formato igual ao das tabelas do Supabase (supabase/schema.sql).

  O campo "trajeto" de cada linha é uma sequência de coordenadas PELAS QUAIS
  o ônibus passa, na ordem do percurso — não é mais o desenho final da rota.
  O app manda essa sequência para js/rotas.js, que devolve o traçado real
  das ruas entre elas (ver DaSinal.dados.obterGeometriaLinha em servicos.js).

  Linha circular (circular: true): o último ponto do trajeto é igual ao
  primeiro e o ônibus roda em looping, sempre no mesmo sentido.

  Circular 1 (Centro via Santanense). Ruas, na ordem: Av. Getúlio Vargas,
  R. Silva Jardim, R. Manoel Corrêa, Pça. Olandim Tavares, Av. Dr. Miguel
  Augusto Gonçalves, R. Dr. Alcides Gonçalves, Av. Gov. Magalhães Pinto,
  R. Ênio Pereira de Carvalho, Av. João Moreira de Carvalho, Av. Faria Tavares,
  R. Abel José de Faria, R. Augusto Alves de Souza, R. Jair Miguel,
  R. Luiz Ribeiro Filho, R. Pe. Antônio Vivaldi, R. Alexandrina Bernardes,
  R. Delmira Gonçalves, R. Oscar Fonseca, R. Ludovico Dias e volta ao Centro.
  Cada coordenada é o cruzamento entre uma rua e a seguinte (OpenStreetMap).
  Os pontos de parada são aproximados: ajuste quando tiver os pontos reais.
*/
window.DASINAL_DEMO = {
  linhas: [
    {
      id: 1, numero: "01", nome: "Circular 1", origem: "Centro", destino: "Via Santanense", ativo: true, circular: true,
      trajeto: [
        [-20.06960, -44.57862], // Av. Getúlio Vargas × R. Silva Jardim
        [-20.06986, -44.58008], // R. Silva Jardim → R. Manoel Corrêa
        [-20.06994, -44.58051], // R. Manoel Corrêa
        [-20.06883, -44.58082], // Av. Dr. Miguel Augusto Gonçalves
        [-20.06579, -44.60197], // → R. Dr. Alcides Gonçalves
        [-20.06883, -44.60669], // → Av. Gov. Magalhães Pinto
        [-20.07690, -44.60576], // Av. Gov. Magalhães Pinto
        [-20.08072, -44.61181], // R. Ênio Pereira de Carvalho
        [-20.08585, -44.60967], // × Av. João Moreira de Carvalho
        [-20.08559, -44.60901], // × Av. Faria Tavares
        [-20.09332, -44.61369], // × R. Abel José de Faria
        [-20.09554, -44.61377], // R. Abel José de Faria
        [-20.09586, -44.61323], // R. Augusto Alves de Souza
        [-20.09339, -44.61167], // × R. Jair Miguel
        [-20.09326, -44.60955], // × R. Luiz Ribeiro Filho
        [-20.09850, -44.61279], // × R. Pe. Antônio Vivaldi
        [-20.09904, -44.61176], // × R. Alexandrina Bernardes
        [-20.09229, -44.60787], // × R. Delmira Gonçalves
        [-20.09284, -44.60476], // × R. Oscar Fonseca
        [-20.09195, -44.60362], // × R. Ludovico Dias
        [-20.09180, -44.60284], // R. Ludovico Dias
        [-20.06960, -44.57862]  // volta ao Centro (fecha o looping)
      ]
    }
  ],
  pontos: [
    { id: 1, nome: "Centro – Av. Getúlio Vargas", latitude: -20.06960, longitude: -44.57862, linha_id: 1, ordem: 1 },
    { id: 2, nome: "Rua Manoel Corrêa", latitude: -20.06994, longitude: -44.58051, linha_id: 1, ordem: 2 },
    { id: 3, nome: "Av. Dr. Miguel Augusto Gonçalves", latitude: -20.06579, longitude: -44.60197, linha_id: 1, ordem: 3 },
    { id: 4, nome: "Av. Gov. Magalhães Pinto", latitude: -20.06883, longitude: -44.60669, linha_id: 1, ordem: 4 },
    { id: 5, nome: "Rua Ênio Pereira de Carvalho", latitude: -20.08072, longitude: -44.61181, linha_id: 1, ordem: 5 },
    { id: 6, nome: "Av. Faria Tavares", latitude: -20.09332, longitude: -44.61369, linha_id: 1, ordem: 6 },
    { id: 7, nome: "Rua Jair Miguel", latitude: -20.09339, longitude: -44.61167, linha_id: 1, ordem: 7 },
    { id: 8, nome: "Rua Pe. Antônio Vivaldi", latitude: -20.09850, longitude: -44.61279, linha_id: 1, ordem: 8 },
    { id: 9, nome: "Rua Delmira Gonçalves", latitude: -20.09229, longitude: -44.60787, linha_id: 1, ordem: 9 },
    { id: 10, nome: "Rua Ludovico Dias", latitude: -20.09195, longitude: -44.60362, linha_id: 1, ordem: 10 }
  ],
  onibus: [
    { id: 1, identificacao: "BUS-01", linha_id: 1, latitude: -20.06579, longitude: -44.60197, status: "em_movimento" }
  ]
};
