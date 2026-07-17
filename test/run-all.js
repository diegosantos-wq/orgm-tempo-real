'use strict';

/**
 * Testes de lógica pura (sem rede, sem credenciais) - rodam com
 * `npm test` ou `node test/run-all.js`. Cobrem especificamente os dois
 * bugs de negócio já corrigidos no .gs original, pra garantir que a
 * migração pro Node não os reintroduz:
 *   1. BIN partido entre Almoxarifados diferentes (a1250kg "duplicado").
 *   2. Quantidade "pela metade" (só reservas ativas devem contar/somar).
 */

const assert = require('assert');
const {
  extrairOcPc,
  extrairNotaFiscal,
  extrairGalpao,
  corrigirLocalCorrompido,
  localJaSeparado,
} = require('../src/util');
const {
  construirMapasEstoque,
  calcularBinsParaConsultar,
  podarBinsNaoReservados,
  atualizarLocalDeTodosOsBins,
  aplicarResultadoLote,
  COLUNAS_RESERVAS,
} = require('../src/reservasLogica');
const { colIndexToLetter } = require('../src/sheetsClient');

let passou = 0;
let falhou = 0;

function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`OK   - ${nome}`);
  } catch (e) {
    falhou++;
    console.error(`FALHOU - ${nome}`);
    console.error(e);
  }
}

// --- util.js ---

teste('extrairOcPc pega o primeiro pedaço antes do 1º "-"', () => {
  assert.strictEqual(extrairOcPc('186364-L04005-19-323756'), '186364');
  assert.strictEqual(extrairOcPc(''), '');
});

teste('extrairNotaFiscal pega o último pedaço', () => {
  assert.strictEqual(extrairNotaFiscal('186364-L04005-19-323756'), '323756');
});

teste('extrairGalpao pega o prefixo numérico do Local', () => {
  assert.strictEqual(extrairGalpao('03A01'), 3);
  assert.strictEqual(extrairGalpao('04A02'), 4);
  assert.strictEqual(extrairGalpao(''), '');
});

teste('corrigirLocalCorrompido reconstrói notação científica (07E07)', () => {
  assert.strictEqual(corrigirLocalCorrompido(70000000), '07E07');
  assert.strictEqual(corrigirLocalCorrompido('07E07'), '07E07'); // já é string, não mexe
  assert.strictEqual(corrigirLocalCorrompido(123), 123); // sem zeros finais suficientes, não é o bug
});

teste('localJaSeparado só é true pra Local começando com Z', () => {
  assert.strictEqual(localJaSeparado('Z01A01'), true);
  assert.strictEqual(localJaSeparado('z01a01'), true);
  assert.strictEqual(localJaSeparado('03A01'), false);
  assert.strictEqual(localJaSeparado(''), false);
});

teste('colIndexToLetter converte índice 0-based pra letra de coluna', () => {
  assert.strictEqual(colIndexToLetter(0), 'A');
  assert.strictEqual(colIndexToLetter(12), 'M'); // 13 colunas em COLUNAS_RESERVAS
  assert.strictEqual(colIndexToLetter(25), 'Z');
  assert.strictEqual(colIndexToLetter(26), 'AA');
});

// --- reservasLogica.js: bug do BIN partido entre Almoxarifados ---

teste('construirMapasEstoque usa o Almoxarifado da divisão que TEM reserva, e soma o Reservado real', () => {
  // Cenário real reportado: BIN 10077693 com 1250kg reservados no total,
  // mas partido em duas linhas de Estoque - uma em AVARIAJ1 (sem reserva) e
  // outra no Almoxarifado normal (com a reserva de verdade).
  const idx = { bin: 1, reservado: 6, almoxarifado: 0, local: 7 };
  const linhasEstoque = [
    ['AVARIAJ1', '10077693', 'ITEM1', 'desc', 500, 0, 0, '02A01'], // divisão sem reserva
    ['ALMOX-01', '10077693', 'ITEM1', 'desc', 750, 1250, 1250, 'Z05B02'], // divisão com a reserva real
  ];
  const { almoxarifadoPorBin, localPorBin, reservadoPorBinComEstoque, listaBins } = construirMapasEstoque(linhasEstoque, idx);
  assert.strictEqual(almoxarifadoPorBin['10077693'], 'ALMOX-01', 'deve pegar o Almoxarifado da divisão com reserva, não a primeira que aparecer');
  assert.strictEqual(localPorBin['10077693'], 'Z05B02', 'deve pegar o Local da mesma divisão com reserva (endereço físico atual), não a primeira que aparecer');
  assert.strictEqual(reservadoPorBinComEstoque['10077693'], 1250, 'deve somar o Reservado das duas divisões, não duplicar nem ficar só com uma');
  assert.deepStrictEqual(listaBins, ['10077693']);
});

teste('construirMapasEstoque não inclui BIN sem nenhuma reserva em nenhuma divisão', () => {
  const idx = { bin: 1, reservado: 6, almoxarifado: 0 };
  const linhasEstoque = [
    ['ALMOX-01', '99999999', 'ITEM1', 'desc', 100, 0, 0],
  ];
  const { listaBins } = construirMapasEstoque(linhasEstoque, idx);
  assert.deepStrictEqual(listaBins, []);
});

// --- reservasLogica.js: bug da quantidade pela metade (Baixado) ---

teste('aplicarResultadoLote conta só reservas ativas (Baixado != 1) e não divide a Qtde', () => {
  // Cenário real reportado: bipado 800kg, mas o relatório antigo (que
  // dividia pelo total de linhas, incluindo já baixadas) mostrava só 400.
  const mapaLinhasPorBin = {};
  const estadoConferidoPorBin = {};
  const resultadosLote = [
    {
      ok: true,
      linhas: [
        { BIN: '123', Item: 'X', TipoPedido: 'OV', Pedido: '555', OrdemVenda: '555', OrdemProducao: '', Qtde: 800, Baixado: 0, Local: '03A01' },
        { BIN: '123', Item: 'X', TipoPedido: 'OV', Pedido: '444', OrdemVenda: '444', OrdemProducao: '', Qtde: 300, Baixado: 1, Local: '03A01' }, // já executada - não deve contar
      ],
    },
  ];
  const { reservasEncontradas, binsSemReservaAtiva } = aplicarResultadoLote({
    resultadosLote,
    loteBins: ['123'],
    almoxarifadoPorBin: { 123: 'ALMOX-01' },
    localPorBin: { 123: 'Z09C03' },
    reservadoPorBinComEstoque: { 123: 800 },
    mapaLinhasPorBin,
    estadoConferidoPorBin,
    colunas: COLUNAS_RESERVAS,
  });
  assert.strictEqual(reservasEncontradas, 1, 'só a reserva ativa (Baixado=0) deve contar');
  assert.strictEqual(binsSemReservaAtiva, 0);
  const linhaGravada = mapaLinhasPorBin['123'][0];
  const colQtde = COLUNAS_RESERVAS.indexOf('Qtde');
  const colLocal = COLUNAS_RESERVAS.indexOf('Local');
  assert.strictEqual(linhaGravada[colQtde], 800, 'a Qtde tem que ser o valor cheio (800), nunca dividido por nada');
  assert.strictEqual(
    linhaGravada[colLocal],
    'Z09C03',
    'o Local gravado tem que vir do Estoque (localPorBin), nunca do Local devolvido pela busca por BIN - esse fica desatualizado quando o BIN é movido pra um endereço de separação'
  );
  assert.strictEqual(estadoConferidoPorBin['123'], 800);
});

teste('aplicarResultadoLote marca binsSemReservaAtiva quando só sobram reservas já baixadas', () => {
  const mapaLinhasPorBin = { 456: [['linha-antiga']] };
  const resultadosLote = [
    { ok: true, linhas: [{ BIN: '456', Qtde: 200, Baixado: 1 }] },
  ];
  const { binsSemReservaAtiva } = aplicarResultadoLote({
    resultadosLote,
    loteBins: ['456'],
    almoxarifadoPorBin: {},
    localPorBin: {},
    reservadoPorBinComEstoque: { 456: 0 },
    mapaLinhasPorBin,
    estadoConferidoPorBin: {},
  });
  assert.strictEqual(binsSemReservaAtiva, 1);
  assert.strictEqual(mapaLinhasPorBin['456'], undefined, 'entrada antiga deve ser removida quando não sobra reserva ativa');
});

teste('aplicarResultadoLote não mexe no mapa quando a consulta falhou (ok=false)', () => {
  const mapaLinhasPorBin = { 789: [['linha-preservada']] };
  const estadoConferidoPorBin = { 789: 42 };
  const resultadosLote = [{ ok: false, linhas: [] }];
  aplicarResultadoLote({
    resultadosLote,
    loteBins: ['789'],
    almoxarifadoPorBin: {},
    localPorBin: {},
    reservadoPorBinComEstoque: { 789: 42 },
    mapaLinhasPorBin,
    estadoConferidoPorBin,
  });
  assert.deepStrictEqual(mapaLinhasPorBin['789'], [['linha-preservada']], 'falha pontual não pode apagar dado já confirmado');
  assert.strictEqual(estadoConferidoPorBin['789'], 42, 'estado conferido não deve mudar numa falha pontual');
});

// --- reservasLogica.js: bug do Local congelado quando o BIN muda de
// endereço SEM a quantidade reservada mudar (caso do OP 25786) ---

teste('atualizarLocalDeTodosOsBins atualiza o Local de um BIN mesmo que ele não tenha sido reconsultado nesta rodada', () => {
  const colQtde = COLUNAS_RESERVAS.indexOf('Qtde');
  const colLocal = COLUNAS_RESERVAS.indexOf('Local');
  const colAlmox = COLUNAS_RESERVAS.indexOf('Almoxarifado');

  // BIN '321' já tinha uma linha gravada numa rodada anterior, com Local
  // ainda no endereço de armazém antigo ('03A01'). Nesta rodada, a
  // quantidade reservada NÃO mudou (por isso calcularBinsParaConsultar não
  // o selecionaria pra reconsultar na ORGM), mas o Estoque já mostra que ele
  // foi fisicamente movido pra um endereço de separação ('Z07C01').
  const linhaAntiga = COLUNAS_RESERVAS.map(() => '');
  linhaAntiga[colQtde] = 800;
  linhaAntiga[colLocal] = '03A01';
  linhaAntiga[colAlmox] = 'ALMOX-01';
  const mapaLinhasPorBin = { 321: [linhaAntiga] };

  atualizarLocalDeTodosOsBins(
    mapaLinhasPorBin,
    { 321: 'ALMOX-01' },
    { 321: 'Z07C01' },
    COLUNAS_RESERVAS
  );

  assert.strictEqual(
    mapaLinhasPorBin['321'][0][colLocal],
    'Z07C01',
    'o Local deve ser atualizado pro endereço de separação atual mesmo sem reconsulta à ORGM nesta rodada'
  );
  assert.strictEqual(mapaLinhasPorBin['321'][0][colAlmox], 'ALMOX-01');
  assert.strictEqual(mapaLinhasPorBin['321'][0][colQtde], 800, 'Qtde não deve ser mexida por esta função');
});

teste('atualizarLocalDeTodosOsBins não mexe em BINs que não têm mais dado nenhum no Estoque desta rodada', () => {
  const colLocal = COLUNAS_RESERVAS.indexOf('Local');
  const linha = COLUNAS_RESERVAS.map(() => '');
  linha[colLocal] = '04B02';
  const mapaLinhasPorBin = { 999: [linha] };

  atualizarLocalDeTodosOsBins(mapaLinhasPorBin, {}, {}, COLUNAS_RESERVAS);

  assert.strictEqual(mapaLinhasPorBin['999'][0][colLocal], '04B02', 'sem dado novo no Estoque, o Local não deve ser apagado nem alterado');
});

// --- delta / upsert ---

teste('calcularBinsParaConsultar só devolve BINs novos ou cujo Reservado mudou', () => {
  const listaBins = ['1', '2', '3'];
  const estadoConferidoPorBin = { 1: 100, 2: 200 }; // 3 nunca foi conferido
  const reservadoPorBinComEstoque = { 1: 100, 2: 250, 3: 50 }; // 2 mudou (200->250)
  const resultado = calcularBinsParaConsultar(listaBins, estadoConferidoPorBin, reservadoPorBinComEstoque);
  assert.deepStrictEqual(resultado.sort(), ['2', '3']);
});

teste('podarBinsNaoReservados remove só o que não está mais reservado', () => {
  const mapa = { 1: 'a', 2: 'b', 3: 'c' };
  podarBinsNaoReservados(mapa, { 1: true, 3: true });
  assert.deepStrictEqual(Object.keys(mapa).sort(), ['1', '3']);
});

console.log(`\n${passou} passaram, ${falhou} falharam.`);
if (falhou > 0) process.exitCode = 1;
