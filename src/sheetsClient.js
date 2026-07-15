'use strict';

/**
 * Wrapper fino sobre a API do Google Sheets (googleapis), cobrindo só o que
 * EstoqueTempoReal.gs usava via SpreadsheetApp: ler/escrever valores, aba
 * oculta, negrito/cor/tamanho de fonte, formato numérico, auto-resize de
 * colunas, formatação condicional (escala de cor) e gráficos simples.
 *
 * Autenticação: conta de serviço do Google (JSON da chave inteiro num único
 * Secret do GitHub, GOOGLE_SERVICE_ACCOUNT_JSON). A planilha precisa estar
 * compartilhada com o e-mail dessa conta de serviço (com permissão de
 * Editor) - sem isso toda chamada abaixo falha com "The caller does not
 * have permission".
 */

const { google } = require('googleapis');

function colIndexToLetter(index) {
  // index é 0-based (0 = A)
  let n = index + 1;
  let letra = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }
  return letra;
}

class SheetsClient {
  constructor({ spreadsheetId, serviceAccountJson }) {
    this.spreadsheetId = spreadsheetId || process.env.SPREADSHEET_ID;
    if (!this.spreadsheetId) {
      throw new Error('Configure SPREADSHEET_ID no Secret/variável de ambiente antes de usar.');
    }
    const chaveTexto = serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!chaveTexto) {
      throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON (conteúdo do JSON da conta de serviço) antes de usar.');
    }
    let credenciais;
    try {
      credenciais = JSON.parse(chaveTexto);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não é um JSON válido: ' + e);
    }
    this.auth = new google.auth.GoogleAuth({
      credentials: credenciais,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    this._metaCache = null;
    // Filas de escrita acumuladas (ver flush()) - setValues/setFont/etc. só
    // enfileiram aqui; nada é enviado à API até flush() ser chamado.
    this._pendingValueRanges = [];
    this._pendingFormatRequests = [];
  }

  async _refreshMeta() {
    const resp = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    this._metaCache = resp.data;
    return resp.data;
  }

  async getSheetMeta(title) {
    if (!this._metaCache) await this._refreshMeta();
    let sheet = (this._metaCache.sheets || []).find((s) => s.properties.title === title);
    if (!sheet) {
      // pode ter sido criada por fora desde o último cache - tenta atualizar uma vez
      await this._refreshMeta();
      sheet = (this._metaCache.sheets || []).find((s) => s.properties.title === title);
    }
    return sheet ? sheet.properties : null;
  }

  async getSheetId(title) {
    const props = await this.getSheetMeta(title);
    return props ? props.sheetId : null;
  }

  /**
   * Garante que a aba existe (cria se não existir) e devolve o sheetId.
   * Se hidden=true e a aba acabou de ser criada, já cria oculta.
   */
  async ensureSheet(title, { hidden = false } = {}) {
    let props = await this.getSheetMeta(title);
    if (props) return props.sheetId;
    const resp = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title, hidden: !!hidden },
            },
          },
        ],
      },
    });
    await this._refreshMeta();
    return resp.data.replies[0].addSheet.properties.sheetId;
  }

  async hideSheet(sheetId) {
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, hidden: true },
              fields: 'hidden',
            },
          },
        ],
      },
    });
  }

  async getValues(title, a1Range) {
    const resp = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: a1Range ? `'${title}'!${a1Range}` : `'${title}'`,
    });
    return resp.data.values || [];
  }

  async getLastRow(title) {
    // getValues sem range devolve só a área realmente usada - basta o
    // tamanho do array de linhas.
    const valores = await this.getValues(title);
    return valores.length;
  }

  /**
   * Escreve valores literais (RAW - não interpreta como fórmula/data, cada
   * valor vai pra célula exatamente como está no array JS), igual ao
   * Range.setValues() do Apps Script.
   *
   * Não dispara chamada de rede na hora - só enfileira (ver flush()). Isso
   * evita fazer uma requisição HTTP separada pra cada trechinho de célula
   * escrito, que era o que estourava a cota de escrita do Google Sheets
   * (60 requisições/minuto por usuário) no meio de rodadas com muitas
   * seções (Dashboard, Dashboard Separação etc.).
   */
  async setValues(title, a1Range, values) {
    if (!values || !values.length) return;
    this._pendingValueRanges.push({ range: `'${title}'!${a1Range}`, values });
  }

  async clearValues(title, a1Range) {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: a1Range ? `'${title}'!${a1Range}` : `'${title}'`,
    });
  }

  /**
   * Enfileira requests de formatação/estrutura (negrito, número, escala de
   * cor, gráficos, etc.) - também não dispara chamada de rede na hora, pelo
   * mesmo motivo do setValues acima. Ver flush().
   */
  async batchUpdate(requests) {
    if (!requests || !requests.length) return;
    this._pendingFormatRequests.push(...requests);
  }

  /**
   * Envia tudo que foi enfileirado por setValues() e por batchUpdate()
   * (direto ou via setFont/setNumberFormat/addConditionalColorScale/
   * autoResizeColumns/addColumnChart/addBarChart) desde o último flush().
   *
   * Cada tipo vira UMA ÚNICA chamada de rede, não importa quantas vezes foi
   * enfileirado: valores.batchUpdate (todas as escritas de célula) e
   * spreadsheets.batchUpdate (toda a formatação/gráficos/cor). Antes desta
   * mudança, um dashboard sozinho chegava a fazer 60-80 chamadas separadas
   * numa única rodada - o Google Sheets limita a 60 requisições de escrita
   * por minuto por usuário, e passar disso derrubava a rodada no meio (erro
   * 429, engolido pelo try/catch de quem chama), o que explicava, por
   * exemplo, o Dashboard de Separação às vezes mostrar só o título da
   * tabela de OP sem os dados.
   *
   * Chame flush() ao final de toda função que escreve numa aba, e SEMPRE
   * antes de qualquer getValues() que precise enxergar o que acabou de ser
   * escrito nesta mesma execução (leitura não vê o que só está enfileirado).
   */
  async flush() {
    if (this._pendingValueRanges.length) {
      const data = this._pendingValueRanges;
      this._pendingValueRanges = [];
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
    }
    if (this._pendingFormatRequests.length) {
      const requests = this._pendingFormatRequests;
      this._pendingFormatRequests = [];
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests },
      });
    }
  }

  /**
   * Limpa conteúdo E formatação/gráficos de uma aba (equivalente a
   * dash.getCharts().forEach(remove) + dash.clear() no Apps Script).
   */
  async clearSheetCompletamente(title) {
    const sheetId = await this.ensureSheet(title);
    const props = await this.getSheetMeta(title);
    const requests = [];
    // Remove gráficos embutidos, se houver.
    (props.charts || []).forEach((c) => {
      requests.push({ deleteEmbeddedObject: { objectId: c.chartId } });
    });
    // Remove regras de formatação condicional.
    if (props.conditionalFormats && props.conditionalFormats.length) {
      // Remove sempre o índice 0 N vezes (os índices deslocam a cada remoção).
      for (let i = 0; i < props.conditionalFormats.length; i++) {
        requests.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
      }
    }
    if (requests.length) await this.batchUpdate(requests);
    await this.clearValues(title);
    // Reseta formatação de célula (negrito/cor/etc.) do intervalo usado.
    await this.batchUpdate([
      {
        updateCells: {
          range: { sheetId },
          fields: 'userEnteredFormat',
        },
      },
    ]);
    await this._refreshMeta();
    return sheetId;
  }

  _range(sheetId, rowStart, colStart, numRows, numCols) {
    return {
      sheetId,
      startRowIndex: rowStart,
      endRowIndex: rowStart + numRows,
      startColumnIndex: colStart,
      endColumnIndex: colStart + numCols,
    };
  }

  async setNumberFormat(sheetId, rowStart, colStart, numRows, numCols, pattern) {
    await this.batchUpdate([
      {
        repeatCell: {
          range: this._range(sheetId, rowStart, colStart, numRows, numCols),
          cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      },
    ]);
  }

  /**
   * Define negrito/tamanho/cor/itálico de fonte num intervalo.
   * cor no formato "#rrggbb".
   */
  async setFont(sheetId, rowStart, colStart, numRows, numCols, { bold, size, color, italic } = {}) {
    const textFormat = {};
    if (bold !== undefined) textFormat.bold = bold;
    if (italic !== undefined) textFormat.italic = italic;
    if (size !== undefined) textFormat.fontSize = size;
    if (color !== undefined) textFormat.foregroundColor = hexToRgb(color);
    await this.batchUpdate([
      {
        repeatCell: {
          range: this._range(sheetId, rowStart, colStart, numRows, numCols),
          cell: { userEnteredFormat: { textFormat } },
          fields: 'userEnteredFormat.textFormat',
        },
      },
    ]);
  }

  async autoResizeColumns(sheetId, startColIndex, endColIndexExclusive) {
    await this.batchUpdate([
      {
        autoResizeDimensions: {
          dimensions: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: startColIndex,
            endIndex: endColIndexExclusive,
          },
        },
      },
    ]);
  }

  /**
   * Escala de cor vermelho -> verde numa coluna de % (0 a 1),
   * igual aplicarEscalaCorPercentual_ no .gs original.
   *
   * Observação: o ponto do meio (amarelo, NUMBER/0.5) foi removido porque a
   * API do Google Sheets rejeitava esse valor decimal com o erro "Invalid
   * InterpolationType.value: 0.5" (os exemplos oficiais da documentação só
   * usam valores inteiros, ex. "0"/"256"). Uma escala de 2 pontos (MIN -> MAX)
   * é o padrão mais simples e documentado pelo Google, e evita esse problema
   * por completo - ainda fica vermelho no 0% e verde no 100%, só sem o
   * amarelo no meio. Cores em tom mais claro/suave (não tão escuro/saturado)
   * a pedido do usuário.
   */
  async addConditionalColorScale(sheetId, rowStart, colStart, numRows, numCols) {
    await this.batchUpdate([
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [this._range(sheetId, rowStart, colStart, numRows, numCols)],
            gradientRule: {
              minpoint: { color: hexToRgb('#e06666'), type: 'MIN' },
              maxpoint: { color: hexToRgb('#93c47d'), type: 'MAX' },
            },
          },
          index: 0,
        },
      },
    ]);
  }

  async addColumnChart(sheetId, { title, anchorRow, anchorCol, domainRange, seriesRange, legend = false }) {
    await this.batchUpdate([
      {
        addChart: {
          chart: {
            spec: {
              title,
              basicChart: {
                chartType: 'COLUMN',
                legendPosition: legend ? 'RIGHT_LEGEND' : 'NO_LEGEND',
                domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
                series: [{ series: { sourceRange: { sources: [seriesRange] } } }],
              },
            },
            position: {
              overlayPosition: {
                anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol },
              },
            },
          },
        },
      },
    ]);
  }

  async addBarChart(sheetId, { title, anchorRow, anchorCol, domainRange, seriesRange, legend = false }) {
    await this.batchUpdate([
      {
        addChart: {
          chart: {
            spec: {
              title,
              basicChart: {
                chartType: 'BAR',
                legendPosition: legend ? 'RIGHT_LEGEND' : 'NO_LEGEND',
                domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
                series: [{ series: { sourceRange: { sources: [seriesRange] } } }],
              },
            },
            position: {
              overlayPosition: {
                anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol },
              },
            },
          },
        },
      },
    ]);
  }
}

function hexToRgb(hex) {
  const limpo = String(hex).replace('#', '');
  const r = parseInt(limpo.substring(0, 2), 16) / 255;
  const g = parseInt(limpo.substring(2, 4), 16) / 255;
  const b = parseInt(limpo.substring(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}

module.exports = { SheetsClient, colIndexToLetter };

