const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

let waSock = null;
let jaNotificouConectado = false;
let reconectando = false;
let ultimoCodigoGerado = "--------";
let statusConexaoAtual = "OFFLINE";

// Servidor HTTP exigido pelo Render e que atende o painel HTML
const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    // Configurar CORS para permitir requisições do seu painel HTML
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    // Rota para iniciar a conexão e gerar o código de 8 dígitos real
    if (urlObj.pathname === '/api/conectar' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const numeroTelefone = data.numero ? data.numero.replace(/\D/g, '') : '';

                if (!numeroTelefone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: 'Número inválido.' }));
                    return;
                }

                statusConexaoAtual = "CONECTANDO...";
                // Dispara a função do Baileys para gerar o código
                const codigo = await iniciarWhatsApp(null, numeroTelefone, null);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, codigo: codigo || ultimoCodigoGerado }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    // Rota para checar o status atual e o código
    if (urlObj.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusConexaoAtual, codigo: ultimoCodigoGerado }));
        return;
    }

    // Página padrão do servidor
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZRX Control System Rodando 24 Horas!\n');
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

async function iniciarWhatsApp(chatId, numeroTelefone, bot) {
    if (reconectando) return;
    reconectando = true;

    const pastaSessao = path.join(__dirname, 'sessao_teste');
    const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);

    waSock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode;
            console.log(`Conexão fechada com status: ${status}`);
            jaNotificouConectado = false;
            statusConexaoAtual = "OFFLINE";

            if (status === DisconnectReason.loggedOut) {
                reconectando = false;
                return;
            }

            setTimeout(() => {
                reconectando = false;
                iniciarWhatsApp(chatId, numeroTelefone, bot);
            }, 5000);

        } else if (connection === 'open') {
            reconectando = false;
            console.log("WhatsApp conectado com sucesso!");
            statusConexaoAtual = "ONLINE";
            jaNotificouConectado = true;
        }
    });

    if (!state.creds.registered && numeroTelefone) {
        await delay(3000);
        try {
            const codigo = await waSock.requestPairingCode(numeroTelefone);
            ultimoCodigoGerado = codigo;
            console.log(`Código de emparelhamento gerado: ${codigo}`);
            return codigo;
        } catch (error) {
            console.error("Erro ao solicitar código de pareamento:", error);
        }
    }
    return ultimoCodigoGerado;
}
