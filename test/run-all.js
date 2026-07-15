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
  assert.strictEqual(colIndexToLetter(13), 'N'); // 14 colunas em COLUNAS_RESERVAS
  assert.strictEqual(colIndexToLetter(25), 'Z');
  assert.strictEqual(colIndexToLetter(26), 'AA');
});

// --- reservasLogica.js: bug do BIN partido entre Almoxarifados ---

teste('construirMapasEstoque usa o Almoxarifado da divisão que TEM reserva, e soma o Reservado real', () => {
  // Cenário real reportado: BIN 10077693 com 1250kg reservados no total,
  // mas partido em duas linhas de Estoque - uma em AVARIAJ1 (sem reserva) e
  // outra no Almoxarifado normal (com a reserva de verdade).
  const idx = { bin: 1, reservado: 6, almoxarifado: 0 };
  const linhasEstoque = [
    ['AVARIAJ1', '10077693', 'ITEM1', 'desc', 500, 0, 0], // divisão sem reserva
    ['ALMOX-01', '10077693', 'ITEM1', 'desc', 750, 1250, 1250], // divisão com a reserva real
  ];
  const { almoxarifadoPorBin, reservadoPorBinComEstoque, listaBins } = construirMapasEstoque(linhasEstoque, idx);
  assert.strictEqual(almoxarifadoPorBin['10077693'], 'ALMOX-01', 'deve pegar o Almoxarifado da divisão com reserva, não a primeira que aparecer');
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
        { BIN: '123', Item: 'X', TipoPedido: 'OV', Pedido: '555', OrdemVenda: '555', OrdemProducao: '', Qtde: 800, Baixado: 0 },
        { BIN: '123', Item: 'X', TipoPedido: 'OV', Pedido: '444', OrdemVenda: '444', OrdemProducao: '', Qtde: 300, Baixado: 1 }, // já executada - não deve contar
      ],
    },
  ];
  const { reservasEncontradas, binsSemReservaAtiva } = aplicarResultadoLote({
    resultadosLote,
    loteBins: ['123'],
    almoxarifadoPorBin: { 123: 'ALMOX-01' },
    reservadoPorBinComEstoque: { 123: 800 },
    mapaLinhasPorBin,
    estadoConferidoPorBin,
    colunas: COLUNAS_RESERVAS,
  });
  assert.strictEqual(reservasEncontradas, 1, 'só a reserva ativa (Baixado=0) deve contar');
  assert.strictEqual(binsSemReservaAtiva, 0);
  const linhaGravada = mapaLinhasPorBin['123'][0];
  const colQtde = COLUNAS_RESERVAS.indexOf('Qtde');
  assert.strictEqual(linhaGravada[colQtde], 800, 'a Qtde tem que ser o valor cheio (800), nunca dividido por nada');
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
    reservadoPorBinComEstoque: { 789: 42 },
    mapaLinhasPorBin,
    estadoConferidoPorBin,
  });
  assert.deepStrictEqual(mapaLinhasPorBin['789'], [['linha-preservada']], 'falha pontual não pode apagar dado já confirmado');
  assert.strictEqual(estadoConferidoPorBin['789'], 42, 'estado conferido não deve mudar numa falha pontual');
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
