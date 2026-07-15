'use strict';

/**
 * Porte de criarDashboardSeparacao() do .gs original: Dashboard de
 * Separação (picking) a partir da aba "Reservas x Pedidos".
 *
 * Regra de negócio (definida pelo usuário): todo Local que começa com "Z"
 * já foi separado; qualquer outro Local ainda está aguardando separação.
 */

const { colIndexToLetter } = require('./sheetsClient');
const { localJaSeparado, agoraBrasilia } = require('./util');

const NOME_ABA_RESERVAS = 'Reservas x Pedidos';
const NOME_ABA_DASHBOARD_SEPARACAO = 'Dashboard Separação';
const FORMATO_KG = '#,##0.00 "kg"';
const FORMATO_PCT = '0.0%';

function a1(row1, col1) {
  return `${colIndexToLetter(col1 - 1)}${row1}`;
}
function a1Range(row1, col1, numRows, numCols) {
  return `${a1(row1, col1)}:${a1(row1 + numRows - 1, col1 + numCols - 1)}`;
}

function novoResumoSeparacao() {
  return { linhas: 0, linhasSeparadas: 0, qtdeTotal: 0, qtdeSeparada: 0 };
}
function acumularSeparacao(resumo, qtde, separado) {
  resumo.linhas++;
  resumo.qtdeTotal += qtde;
  if (separado) {
    resumo.linhasSeparadas++;
    resumo.qtdeSeparada += qtde;
  }
}
function pct(parte, total) {
  return total > 0 ? parte / total : 0;
}

function montarListaPorPedido(mapaPorPedido) {
  return Object.keys(mapaPorPedido)
    .map((pedido) => {
      const entrada = mapaPorPedido[pedido];
      const r = entrada.resumo;
      const almoxarifadosDoPedido = Object.keys(entrada.almoxarifados)
        .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)))
        .join(', ');
      return [pedido, almoxarifadosDoPedido, r.linhas, r.qtdeTotal, r.qtdeSeparada, pct(r.qtdeSeparada, r.qtdeTotal), r.qtdeTotal - r.qtdeSeparada];
    })
    .sort((a, b) => b[3] - a[3]);
}

async function criarDashboardSeparacao(sheetsClient) {
  const dadosReservas = await sheetsClient.getValues(NOME_ABA_RESERVAS);
  if (!dadosReservas.length || dadosReservas.length < 5) {
    console.log('criarDashboardSeparacao: abortado, aba "Reservas x Pedidos" ainda vazia ou inexistente.');
    return;
  }

  // Cabeçalho está na linha 4 (índice 3); dados a partir da linha 5 (índice 4).
  const cabecalho = dadosReservas[3];
  const idx = {
    almoxarifado: cabecalho.indexOf('Almoxarifado'),
    bin: cabecalho.indexOf('BIN'),
    tipoPedido: cabecalho.indexOf('TipoPedido'),
    pedido: cabecalho.indexOf('Pedido'),
    qtde: cabecalho.indexOf('Qtde'),
    local: cabecalho.indexOf('Local'),
  };
  if (idx.almoxarifado < 0) idx.almoxarifado = 0;
  if (idx.bin < 0) idx.bin = 1;
  if (idx.tipoPedido < 0) idx.tipoPedido = 3;
  if (idx.pedido < 0) idx.pedido = 4;
  if (idx.qtde < 0) idx.qtde = 8;
  if (idx.local < 0) idx.local = 11;

  const linhas = dadosReservas.slice(4).filter((linha) => linha[idx.bin] !== '' && linha[idx.bin] !== null && linha[idx.bin] !== undefined);

  if (!linhas.length) {
    console.log('criarDashboardSeparacao: abortado, "Reservas x Pedidos" sem linhas de dados.');
    return;
  }

  const geral = novoResumoSeparacao();
  const porTipo = {};
  const porAlmoxarifado = {};
  const porOV = {};
  const porOP = {};

  linhas.forEach((linha) => {
    const qtde = Number(linha[idx.qtde]) || 0;
    const separado = localJaSeparado(linha[idx.local]);
    const tipo = linha[idx.tipoPedido] || '(sem tipo)';
    const pedido = linha[idx.pedido];
    let almox = linha[idx.almoxarifado];
    if (almox === '' || almox === null || almox === undefined) almox = '(sem almox)';

    acumularSeparacao(geral, qtde, separado);

    if (!porTipo[tipo]) porTipo[tipo] = novoResumoSeparacao();
    acumularSeparacao(porTipo[tipo], qtde, separado);

    if (!porAlmoxarifado[almox]) porAlmoxarifado[almox] = novoResumoSeparacao();
    acumularSeparacao(porAlmoxarifado[almox], qtde, separado);

    const mapaDoTipo = tipo === 'OV' ? porOV : tipo === 'OP' ? porOP : null;
    if (mapaDoTipo && pedido !== '' && pedido !== null && pedido !== undefined) {
      const chavePedido = String(pedido);
      if (!mapaDoTipo[chavePedido]) {
        mapaDoTipo[chavePedido] = { resumo: novoResumoSeparacao(), almoxarifados: {} };
      }
      acumularSeparacao(mapaDoTipo[chavePedido].resumo, qtde, separado);
      mapaDoTipo[chavePedido].almoxarifados[almox] = true;
    }
  });

  const ordemTipoFixa = ['OV', 'OP'];
  const listaTipos = Object.keys(porTipo).sort((a, b) => {
    let posA = ordemTipoFixa.indexOf(a);
    let posB = ordemTipoFixa.indexOf(b);
    if (posA < 0) posA = 99;
    if (posB < 0) posB = 99;
    if (posA !== posB) return posA - posB;
    return porTipo[b].qtdeTotal - porTipo[a].qtdeTotal;
  });
  const listaAlmoxarifados = Object.keys(porAlmoxarifado).sort((a, b) => porAlmoxarifado[b].qtdeTotal - porAlmoxarifado[a].qtdeTotal);
  const listaLinhasOV = montarListaPorPedido(porOV);
  const listaLinhasOP = montarListaPorPedido(porOP);

  const sheetId = await sheetsClient.clearSheetCompletamente(NOME_ABA_DASHBOARD_SEPARACAO);

  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'A1:A1', [['Dashboard de Separação (Picking) - ORGM']]);
  await sheetsClient.setFont(sheetId, 0, 0, 1, 1, { size: 16, bold: true });
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'A2:B2', [['Atualizado em:', agoraBrasilia()]]);
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'A3:A3', [
    ['Regra: Local começando com "Z" = já separado. Qualquer outro Local = aguardando separação.'],
  ]);
  await sheetsClient.setFont(sheetId, 2, 0, 1, 1, { italic: true, color: '#666666' });

  const pctGeral = pct(geral.qtdeSeparada, geral.qtdeTotal);
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'A5:A5', [['% JÁ SEPARADO (geral, por quantidade)']]);
  await sheetsClient.setFont(sheetId, 4, 0, 1, 1, { bold: true });
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'A6:A6', [[pctGeral]]);
  await sheetsClient.setNumberFormat(sheetId, 5, 0, 1, 1, FORMATO_PCT);
  await sheetsClient.setFont(sheetId, 5, 0, 1, 1, {
    size: 36,
    bold: true,
    color: pctGeral >= 0.7 ? '#137333' : pctGeral >= 0.4 ? '#b06000' : '#c5221f',
  });

  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'D5:G5', [
    ['Total de reservas (linhas)', 'Qtde total reservada', 'Qtde já separada', 'Qtde aguardando'],
  ]);
  await sheetsClient.setFont(sheetId, 4, 3, 1, 4, { bold: true });
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, 'D6:G6', [
    [geral.linhas, geral.qtdeTotal, geral.qtdeSeparada, geral.qtdeTotal - geral.qtdeSeparada],
  ]);
  await sheetsClient.setNumberFormat(sheetId, 5, 3, 1, 1, '#,##0');
  await sheetsClient.setNumberFormat(sheetId, 5, 4, 1, 3, FORMATO_KG);

  // --- Situação Geral (mini tabela) ---
  let linhaSituacao = 9;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1(linhaSituacao, 1), [['Situação Geral (por quantidade)']]);
  await sheetsClient.setFont(sheetId, linhaSituacao - 1, 0, 1, 1, { bold: true });
  linhaSituacao++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaSituacao, 1, 1, 3), [['Situação', 'Qtde (kg)', '%']]);
  await sheetsClient.setFont(sheetId, linhaSituacao - 1, 0, 1, 3, { bold: true });
  const linhaDadosSituacao = linhaSituacao + 1;
  const qtdeAguardandoGeral = geral.qtdeTotal - geral.qtdeSeparada;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaDadosSituacao, 1, 2, 3), [
    ['Já separado', geral.qtdeSeparada, pctGeral],
    ['Aguardando separação', qtdeAguardandoGeral, 1 - pctGeral],
  ]);
  await sheetsClient.setNumberFormat(sheetId, linhaDadosSituacao - 1, 1, 2, 1, FORMATO_KG);
  await sheetsClient.setNumberFormat(sheetId, linhaDadosSituacao - 1, 2, 2, 1, FORMATO_PCT);

  // --- Por Tipo de Pedido ---
  let linha = linhaDadosSituacao + 4;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1(linha, 1), [
    ['Separação por Tipo de Pedido (OV = Ordem de Venda, OP = Ordem de Produção)'],
  ]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linha, 1, 1, 6), [
    ['Tipo', 'Linhas', 'Qtde Total (kg)', 'Qtde Separada (kg)', '% Separado', 'Qtde Aguardando (kg)'],
  ]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 6, { bold: true });
  const linhaDadosTipo = linha + 1;
  linha++;
  const listaLinhasTipo = listaTipos.map((tipo) => {
    const r = porTipo[tipo];
    return [tipo, r.linhas, r.qtdeTotal, r.qtdeSeparada, pct(r.qtdeSeparada, r.qtdeTotal), r.qtdeTotal - r.qtdeSeparada];
  });
  if (listaLinhasTipo.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaDadosTipo, 1, listaLinhasTipo.length, 6), listaLinhasTipo);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosTipo - 1, 1, listaLinhasTipo.length, 1, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosTipo - 1, 2, listaLinhasTipo.length, 2, FORMATO_KG);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosTipo - 1, 4, listaLinhasTipo.length, 1, FORMATO_PCT);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosTipo - 1, 5, listaLinhasTipo.length, 1, FORMATO_KG);
    linha = linhaDadosTipo + listaLinhasTipo.length;
  }
  linha += 2;

  // --- Por Almoxarifado ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1(linha, 1), [['Separação por Almoxarifado']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linha, 1, 1, 6), [
    ['Almoxarifado', 'Linhas', 'Qtde Total (kg)', 'Qtde Separada (kg)', '% Separado', 'Qtde Aguardando (kg)'],
  ]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 6, { bold: true });
  const linhaDadosAlmox = linha + 1;
  linha++;
  const listaLinhasAlmox = listaAlmoxarifados.map((almox) => {
    const r = porAlmoxarifado[almox];
    return [almox, r.linhas, r.qtdeTotal, r.qtdeSeparada, pct(r.qtdeSeparada, r.qtdeTotal), r.qtdeTotal - r.qtdeSeparada];
  });
  if (listaLinhasAlmox.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaDadosAlmox, 1, listaLinhasAlmox.length, 6), listaLinhasAlmox);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmox - 1, 1, listaLinhasAlmox.length, 1, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmox - 1, 2, listaLinhasAlmox.length, 2, FORMATO_KG);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmox - 1, 4, listaLinhasAlmox.length, 1, FORMATO_PCT);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmox - 1, 5, listaLinhasAlmox.length, 1, FORMATO_KG);
    linha = linhaDadosAlmox + listaLinhasAlmox.length;
  }
  linha += 2;

  // --- Por Pedido (OV) ---
  const colunasPorPedidoOV = ['OV', 'Almoxarifado(s)', 'Linhas', 'Qtde Total (kg)', 'Qtde Separada (kg)', '% Separado', 'Qtde Aguardando (kg)'];
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1(linha, 1), [['Separação por Pedido - OV (Ordem de Venda), individual']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linha, 1, 1, 7), [colunasPorPedidoOV]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 7, { bold: true });
  const linhaDadosOV = linha + 1;
  linha++;
  if (listaLinhasOV.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaDadosOV, 1, listaLinhasOV.length, 7), listaLinhasOV);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOV - 1, 2, listaLinhasOV.length, 1, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOV - 1, 3, listaLinhasOV.length, 2, FORMATO_KG);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOV - 1, 5, listaLinhasOV.length, 1, FORMATO_PCT);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOV - 1, 6, listaLinhasOV.length, 1, FORMATO_KG);
    linha = linhaDadosOV + listaLinhasOV.length;
  }
  linha += 2;

  // --- Por Pedido (OP) ---
  const colunasPorPedidoOP = colunasPorPedidoOV.slice();
  colunasPorPedidoOP[0] = 'OP';
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1(linha, 1), [['Separação por Pedido - OP (Ordem de Produção), individual']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linha, 1, 1, 7), [colunasPorPedidoOP]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 7, { bold: true });
  const linhaDadosOP = linha + 1;
  linha++;
  if (listaLinhasOP.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD_SEPARACAO, a1Range(linhaDadosOP, 1, listaLinhasOP.length, 7), listaLinhasOP);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOP - 1, 2, listaLinhasOP.length, 1, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOP - 1, 3, listaLinhasOP.length, 2, FORMATO_KG);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOP - 1, 5, listaLinhasOP.length, 1, FORMATO_PCT);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosOP - 1, 6, listaLinhasOP.length, 1, FORMATO_KG);
  }

  await sheetsClient.autoResizeColumns(sheetId, 0, 7);

  // Envia tudo que foi enfileirado (setValues/setFont/setNumberFormat/escala
  // de cor) numa única leva - ver comentário em flush() no sheetsClient.
  // É este flush final que garante que a tabela de OP (e tudo mais) apareça
  // por completo de uma vez, em vez de arriscar parar no meio por causa da
  // cota de escrita da API do Google Sheets.
  await sheetsClient.flush();
}

module.exports = { criarDashboardSeparacao, NOME_ABA_DASHBOARD_SEPARACAO };

