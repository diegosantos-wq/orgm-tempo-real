'use strict';

/**
 * Porte de executarAtualizacaoDeEstoque_() do .gs original: dispara o
 * export de estoque na ORGM, espera o arquivo novo aparecer, baixa o xlsx
 * e escreve na aba "Estoque".
 *
 * Diferença em relação ao original: em vez do truque
 * "Drive.Files.create(..., MimeType.GOOGLE_SHEETS)" pra converter o xlsx
 * numa planilha temporária do Google só pra poder ler os valores (que só
 * existia porque o Apps Script não tem uma lib de xlsx nativa), aqui a lib
 * "xlsx" (SheetJS) lê o buffer baixado diretamente - mais simples e sem
 * precisar de nenhum arquivo temporário no Drive.
 */

const XLSX = require('xlsx');
const orgm = require('./orgmClient');
const { corrigirColunaLocal, sleep } = require('./util');

const NOME_ABA_ESTOQUE = 'Estoque';

function lerXlsxComoLinhas(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const primeiraAba = workbook.SheetNames[0];
  const planilha = workbook.Sheets[primeiraAba];
  // header:1 => array de arrays (igual getDataRange().getValues()); raw:true
  // => mantém números como número em vez de string formatada; defval:'' =>
  // célula vazia vira '' em vez de undefined, igual ao Apps Script.
  return XLSX.utils.sheet_to_json(planilha, { header: 1, raw: true, defval: '' });
}

/**
 * Espera até ~22,5s (15 tentativas de 1,5s) o ORGM terminar de gerar o
 * relatório novo (checa por um anexo com DtEnvio >= início da espera).
 */
async function aguardarAnexoNovo(inicioMs) {
  for (let tentativa = 0; tentativa < 15; tentativa++) {
    await sleep(1500);
    const candidato = await orgm.anexoMaisRecente();
    if (candidato) {
      const { extrairDataDotNet } = require('./util');
      if (extrairDataDotNet(candidato.DtEnvio) >= inicioMs) {
        return candidato;
      }
    }
  }
  return null;
}

/**
 * Executa a atualização de Estoque completa e escreve na aba "Estoque".
 * Lança erro se algo falhar (quem chama decide se trata como fatal ou só
 * loga e segue, igual ao try/catch em volta de atualizarEstoque() no .gs).
 */
async function executarAtualizacaoDeEstoque(sheetsClient) {
  const inicio = Date.now();

  await orgm.dispararExportEstoque();
  const anexo = await aguardarAnexoNovo(inicio);
  if (!anexo) {
    throw new Error('Tempo esgotado esperando a ORGM gerar o relatório de estoque.');
  }

  const buffer = await orgm.baixarAnexo(anexo.TokenAnexo);
  const linhas = lerXlsxComoLinhas(buffer);
  corrigirColunaLocal(linhas);

  await sheetsClient.ensureSheet(NOME_ABA_ESTOQUE);
  await sheetsClient.clearValues(NOME_ABA_ESTOQUE);

  if (linhas.length) {
    const numCols = linhas[0].length;
    const { colIndexToLetter } = require('./sheetsClient');
    const ultimaColuna = colIndexToLetter(numCols - 1);
    await sheetsClient.setValues(NOME_ABA_ESTOQUE, `A1:${ultimaColuna}${linhas.length}`, linhas);
    const colunaNota = colIndexToLetter(numCols + 1); // igual ao "+2" (1-based) do original
    await sheetsClient.setValues(
      NOME_ABA_ESTOQUE,
      `${colunaNota}1:${colunaNota}1`,
      [['Atualizado em: ' + new Date().toLocaleString('pt-BR')]]
    );
  }

  return { linhas };
}

module.exports = { executarAtualizacaoDeEstoque, lerXlsxComoLinhas, NOME_ABA_ESTOQUE };
