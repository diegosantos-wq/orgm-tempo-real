'use strict';

/**
 * Ponto de entrada rodado pelo GitHub Actions (ver
 * .github/workflows/tempo-real.yml). Substitui o gatilho automático do
 * Apps Script (iniciarBuscaCompletaDeReservas / atualizarPedidosDasReservas)
 * - cada execução deste arquivo é uma "rodada" completa:
 *   Estoque -> Dashboard -> Reservas x Pedidos (delta) -> Dashboard de Separação
 *
 * Variáveis de ambiente esperadas (Secrets do repositório no GitHub):
 *   ORGM_TOKEN                  - TokenAcesso da ORGM
 *   ORGM_EMPRESA_ID             - EmpresaID da ORGM
 *   SPREADSHEET_ID              - ID da planilha (está na URL, entre /d/ e /edit)
 *   GOOGLE_SERVICE_ACCOUNT_JSON - conteúdo INTEIRO do arquivo JSON da conta
 *                                 de serviço do Google (a planilha precisa
 *                                 estar compartilhada com o e-mail dela)
 *
 * Nenhum desses valores deve ser colado direto no código - só em Secrets.
 */

const dns = require('dns');
// Força o Node a preferir IPv4 na resolução de DNS. Motivo: os runners do
// GitHub Actions têm um problema conhecido de rota de IPv6 assimétrica/quebrada
// pra alguns destinos específicos - o Node tenta IPv4 e IPv6 ao mesmo tempo
// ("Happy Eyeballs") e usa o que responder primeiro, então quando a rota IPv6
// está quebrada só pra um destino, a conexão trava até estourar o tempo em
// ALGUMAS tentativas e funciona normalmente em outras (exatamente o padrão do
// "UND_ERR_CONNECT_TIMEOUT" intermitente que vimos só na etapa de Estoque).
// Preferir IPv4 evita essa rota problemática por completo.
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const { SheetsClient } = require('./src/sheetsClient');
const { executarRodadaPedidosDasReservas } = require('./src/reservas');

async function main() {
  const inicio = Date.now();
  const sheetsClient = new SheetsClient({});
  const resultado = await executarRodadaPedidosDasReservas(sheetsClient);
  const duracaoSeg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`Rodada concluída em ${duracaoSeg}s.`, JSON.stringify(resultado));
}

main().catch((e) => {
  console.error('Falha não tratada na rodada:', e);
  process.exitCode = 1;
});
