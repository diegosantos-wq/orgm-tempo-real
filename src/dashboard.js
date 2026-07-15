'use strict';

/**
 * Porte de criarDashboard() do .gs original: KPIs + tabelas + gráficos a
 * partir da aba "Estoque", escritos na aba "Dashboard".
 *
 * Mesma filosofia do original: tudo é agregado aqui em JavaScript (sem
 * fórmulas QUERY), e só o resultado final (valores prontos) é escrito na
 * planilha.
 */

const { colIndexToLetter } = require('./sheetsClient');
const { extrairOcPc, extrairNotaFiscal, extrairGalpao, corrigirLocalCorrompido, agoraBrasilia } = require('./util');

const LIMITE_ESTOQUE_BAIXO_PADRAO = 5;
const FORMATO_KG = '#,##0.00 "kg"';
const NOME_ABA_DASHBOARD = 'Dashboard';

function a1(row1, col1) {
  return `${colIndexToLetter(col1 - 1)}${row1}`;
}
function a1Range(row1, col1, numRows, numCols) {
  return `${a1(row1, col1)}:${a1(row1 + numRows - 1, col1 + numCols - 1)}`;
}

async function criarDashboard(sheetsClient) {
  const dadosEstoque = await sheetsClient.getValues('Estoque');
  if (!dadosEstoque.length || dadosEstoque.length < 2) {
    console.log('criarDashboard: abortado, aba "Estoque" vazia ou inexistente.');
    return;
  }
  const cabecalho = dadosEstoque[0];
  const linhas = dadosEstoque.slice(1);

  let colLocalBruto = cabecalho.indexOf('Local');
  if (colLocalBruto < 0) colLocalBruto = 2;
  // Autocura de Locais corrompidos (mesma lógica do original) - só em
  // memória aqui; se quiser gravar de volta na aba Estoque, dá pra chamar
  // corrigirColunaLocal antes de escrever a aba Estoque em estoque.js (já
  // fazemos isso lá), então normalmente esse bloco já chega correto.
  linhas.forEach((linha) => {
    linha[colLocalBruto] = corrigirLocalCorrompido(linha[colLocalBruto]);
  });

  const idx = {
    almoxarifado: cabecalho.indexOf('Almoxarifado'),
    local: cabecalho.indexOf('Local'),
    item: cabecalho.indexOf('item'),
    descricao: cabecalho.indexOf('descricao'),
    estoque: cabecalho.indexOf('Estoque'),
    reservado: cabecalho.indexOf('Reservado'),
    lote: cabecalho.indexOf('Lote_Interno'),
  };
  if (idx.almoxarifado < 0) idx.almoxarifado = 0;
  if (idx.local < 0) idx.local = 2;
  if (idx.item < 0) idx.item = 3;
  if (idx.descricao < 0) idx.descricao = 4;
  if (idx.estoque < 0) idx.estoque = 5;
  if (idx.reservado < 0) idx.reservado = 6;
  if (idx.lote < 0) idx.lote = 7;

  let totalEstoque = 0;
  let totalReservado = 0;
  const porItem = {};
  const itensUnicos = {};
  const resumoAlmoxarifado = {};
  const resumoGalpao = {};

  linhas.forEach((linha) => {
    const almox = linha[idx.almoxarifado];
    const local = linha[idx.local];
    const item = linha[idx.item];
    const desc = linha[idx.descricao];
    const estoque = Number(linha[idx.estoque]) || 0;
    const reservado = Number(linha[idx.reservado]) || 0;
    const ocPc = extrairOcPc(linha[idx.lote]);
    const notaFiscal = extrairNotaFiscal(linha[idx.lote]);
    const galpao = extrairGalpao(local);

    totalEstoque += estoque;
    totalReservado += reservado;

    if (item !== '' && item !== null && item !== undefined) {
      itensUnicos[item] = true;
      if (!porItem[item]) porItem[item] = { descricao: desc, total: 0, reservado: 0 };
      porItem[item].total += estoque;
      porItem[item].reservado += reservado;
    }

    if (almox !== '' && almox !== null && almox !== undefined) {
      if (!resumoAlmoxarifado[almox]) {
        resumoAlmoxarifado[almox] = { itens: {}, lotes: {}, notas: {}, estoque: 0, reservado: 0 };
      }
      resumoAlmoxarifado[almox].estoque += estoque;
      resumoAlmoxarifado[almox].reservado += reservado;
      if (item) resumoAlmoxarifado[almox].itens[item] = true;
      if (ocPc) resumoAlmoxarifado[almox].lotes[ocPc] = true;
      if (notaFiscal) resumoAlmoxarifado[almox].notas[notaFiscal] = true;
    }

    if (galpao !== '' && galpao !== null && galpao !== undefined) {
      if (!resumoGalpao[galpao]) {
        resumoGalpao[galpao] = { itens: {}, lotes: {}, notas: {}, estoque: 0 };
      }
      resumoGalpao[galpao].estoque += estoque;
      if (item) resumoGalpao[galpao].itens[item] = true;
      if (ocPc) resumoGalpao[galpao].lotes[ocPc] = true;
      if (notaFiscal) resumoGalpao[galpao].notas[notaFiscal] = true;
    }
  });

  const listaResumoAlmoxarifado = Object.keys(resumoAlmoxarifado)
    .map((k) => {
      const r = resumoAlmoxarifado[k];
      return [k, Object.keys(r.itens).length, Object.keys(r.lotes).length, Object.keys(r.notas).length, r.estoque, r.reservado];
    })
    .sort((a, b) => b[4] - a[4]);

  const listaResumoGalpao = Object.keys(resumoGalpao)
    .map((k) => {
      const r = resumoGalpao[k];
      return [k, Object.keys(r.itens).length, Object.keys(r.lotes).length, Object.keys(r.notas).length, r.estoque];
    })
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  const listaItens = Object.keys(porItem).map((k) => [k, porItem[k].descricao, porItem[k].total, porItem[k].reservado]);

  const topItens = listaItens
    .slice()
    .sort((a, b) => b[2] - a[2])
    .slice(0, 10);

  // Preserva o limite de "estoque baixo" se o usuário já tiver mudado E4.
  let limiteEstoqueBaixo = LIMITE_ESTOQUE_BAIXO_PADRAO;
  const jaExistia = (await sheetsClient.getSheetMeta(NOME_ABA_DASHBOARD)) !== null;
  if (jaExistia) {
    try {
      const valoresE4 = await sheetsClient.getValues(NOME_ABA_DASHBOARD, 'E4:E4');
      const valorAtual = valoresE4 && valoresE4[0] && valoresE4[0][0];
      if (typeof valorAtual === 'number' && valorAtual > 0) limiteEstoqueBaixo = valorAtual;
    } catch (e) {
      // aba nova/sem E4 ainda - mantém o padrão
    }
  }

  const itensBaixoEstoque = listaItens
    .filter((l) => l[2] <= limiteEstoqueBaixo)
    .sort((a, b) => a[2] - b[2])
    .slice(0, 30);

  const sheetId = await sheetsClient.clearSheetCompletamente(NOME_ABA_DASHBOARD);

  // --- Título e KPIs ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, 'A1:B1', [['Dashboard de Estoque - ORGM', '']]);
  await sheetsClient.setFont(sheetId, 0, 0, 1, 1, { size: 16, bold: true });
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, 'A2:B2', [['Atualizado em:', agoraBrasilia()]]);

  await sheetsClient.setValues(NOME_ABA_DASHBOARD, 'A4:B7', [
    ['Estoque Total', totalEstoque],
    ['Reservado Total', totalReservado],
    ['Disponível Total', totalEstoque - totalReservado],
    ['Itens distintos', Object.keys(itensUnicos).length],
  ]);
  await sheetsClient.setNumberFormat(sheetId, 3, 1, 3, 1, FORMATO_KG); // B4:B6
  await sheetsClient.setNumberFormat(sheetId, 6, 1, 1, 1, '#,##0'); // B7
  await sheetsClient.setFont(sheetId, 3, 0, 4, 1, { bold: true }); // A4:A7

  await sheetsClient.setValues(NOME_ABA_DASHBOARD, 'D4:E4', [['Limite p/ "estoque baixo" (kg):', limiteEstoqueBaixo]]);
  await sheetsClient.setFont(sheetId, 3, 3, 1, 1, { bold: true });
  await sheetsClient.setNumberFormat(sheetId, 3, 4, 1, 1, '#,##0.00');

  let linha = 10;
  let linhaDadosAlmoxarifado = null;
  let linhaDadosGalpao = null;
  let linhaDadosTopItens = null;

  // --- Estoque por Almoxarifado ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1(linha, 1), [['Estoque por Almoxarifado']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(
    NOME_ABA_DASHBOARD,
    a1Range(linha, 1, 1, 6),
    [['Almoxarifado', 'Itens', 'Lotes (OC/PC)', 'Notas Fiscais', 'Estoque (kg)', 'Reservado (kg)']]
  );
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 6, { bold: true });
  linhaDadosAlmoxarifado = linha + 1;
  linha++;
  if (listaResumoAlmoxarifado.length) {
    await sheetsClient.setValues(
      NOME_ABA_DASHBOARD,
      a1Range(linhaDadosAlmoxarifado, 1, listaResumoAlmoxarifado.length, 6),
      listaResumoAlmoxarifado
    );
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmoxarifado - 1, 0, listaResumoAlmoxarifado.length, 4, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosAlmoxarifado - 1, 4, listaResumoAlmoxarifado.length, 2, FORMATO_KG);
    linha = linhaDadosAlmoxarifado + listaResumoAlmoxarifado.length;
  }
  linha += 2;

  // --- Estoque por Galpão ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1(linha, 1), [['Estoque por Galpão (prefixo do Local)']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(
    NOME_ABA_DASHBOARD,
    a1Range(linha, 1, 1, 5),
    [['Galpão', 'Itens', 'Lotes (OC/PC)', 'Notas Fiscais', 'Estoque (kg)']]
  );
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 5, { bold: true });
  linhaDadosGalpao = linha + 1;
  linha++;
  if (listaResumoGalpao.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1Range(linhaDadosGalpao, 1, listaResumoGalpao.length, 5), listaResumoGalpao);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosGalpao - 1, 0, listaResumoGalpao.length, 4, '#,##0');
    await sheetsClient.setNumberFormat(sheetId, linhaDadosGalpao - 1, 4, listaResumoGalpao.length, 1, FORMATO_KG);
    linha = linhaDadosGalpao + listaResumoGalpao.length;
  }
  linha += 2;

  // --- Top 10 itens em estoque ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1(linha, 1), [['Top 10 itens em estoque']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1Range(linha, 1, 1, 3), [['Item', 'Descrição', 'Estoque (kg)']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 3, { bold: true });
  linhaDadosTopItens = linha + 1;
  linha++;
  if (topItens.length) {
    const topItensParaEscrever = topItens.map((l) => [l[0], l[1], l[2]]);
    await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1Range(linhaDadosTopItens, 1, topItensParaEscrever.length, 3), topItensParaEscrever);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosTopItens - 1, 2, topItensParaEscrever.length, 1, FORMATO_KG);
    linha = linhaDadosTopItens + topItensParaEscrever.length;
  }
  linha += 2;

  // --- Itens com estoque baixo ---
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1(linha, 1), [[`Itens com estoque baixo (<= ${limiteEstoqueBaixo} kg)`]]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 1, { bold: true });
  linha++;
  await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1Range(linha, 1, 1, 4), [['Item', 'Descrição', 'Estoque (kg)', 'Reservado (kg)']]);
  await sheetsClient.setFont(sheetId, linha - 1, 0, 1, 4, { bold: true });
  const linhaDadosBaixoEstoque = linha + 1;
  if (itensBaixoEstoque.length) {
    await sheetsClient.setValues(NOME_ABA_DASHBOARD, a1Range(linhaDadosBaixoEstoque, 1, itensBaixoEstoque.length, 4), itensBaixoEstoque);
    await sheetsClient.setNumberFormat(sheetId, linhaDadosBaixoEstoque - 1, 2, itensBaixoEstoque.length, 2, FORMATO_KG);
  }

  // --- Gráficos (coluna H em diante) ---
  let linhaGrafico = 1; // 0-based (linha 2 do Sheets)
  const ESPACO_ENTRE_GRAFICOS = 20;

  if (listaResumoAlmoxarifado.length) {
    await sheetsClient.addColumnChart(sheetId, {
      title: 'Estoque total por Almoxarifado',
      anchorRow: linhaGrafico,
      anchorCol: 7,
      domainRange: { sheetId, startRowIndex: linhaDadosAlmoxarifado - 2, endRowIndex: linhaDadosAlmoxarifado - 1 + listaResumoAlmoxarifado.length, startColumnIndex: 0, endColumnIndex: 1 },
      seriesRange: { sheetId, startRowIndex: linhaDadosAlmoxarifado - 2, endRowIndex: linhaDadosAlmoxarifado - 1 + listaResumoAlmoxarifado.length, startColumnIndex: 4, endColumnIndex: 5 },
    });
    linhaGrafico += ESPACO_ENTRE_GRAFICOS;
  }

  if (listaResumoGalpao.length) {
    await sheetsClient.addColumnChart(sheetId, {
      title: 'Estoque total por Galpão',
      anchorRow: linhaGrafico,
      anchorCol: 7,
      domainRange: { sheetId, startRowIndex: linhaDadosGalpao - 2, endRowIndex: linhaDadosGalpao - 1 + listaResumoGalpao.length, startColumnIndex: 0, endColumnIndex: 1 },
      seriesRange: { sheetId, startRowIndex: linhaDadosGalpao - 2, endRowIndex: linhaDadosGalpao - 1 + listaResumoGalpao.length, startColumnIndex: 4, endColumnIndex: 5 },
    });
    linhaGrafico += ESPACO_ENTRE_GRAFICOS;
  }

  if (topItens.length) {
    await sheetsClient.addBarChart(sheetId, {
      title: 'Top 10 itens em estoque',
      anchorRow: linhaGrafico,
      anchorCol: 7,
      domainRange: { sheetId, startRowIndex: linhaDadosTopItens - 2, endRowIndex: linhaDadosTopItens - 1 + topItens.length, startColumnIndex: 0, endColumnIndex: 1 },
      seriesRange: { sheetId, startRowIndex: linhaDadosTopItens - 2, endRowIndex: linhaDadosTopItens - 1 + topItens.length, startColumnIndex: 2, endColumnIndex: 3 },
    });
  }

  await sheetsClient.autoResizeColumns(sheetId, 0, 6);

  // Envia tudo que foi enfileirado (setValues/setFont/setNumberFormat/
  // gráficos) numa única leva - ver comentário em flush() no sheetsClient.
  await sheetsClient.flush();
}

module.exports = { criarDashboard, NOME_ABA_DASHBOARD };

