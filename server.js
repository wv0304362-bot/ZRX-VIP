const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

let waSock = null;
let reconectando = false;
let statusConexaoAtual = "OFFLINE";
let ultimoCodigoGerado = "--------";

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    // Rota: Conectar e gerar código de pareamento
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
                const codigo = await iniciarWhatsApp(numeroTelefone);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, codigo: codigo || ultimoCodigoGerado }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    // Rota: Obter Lista de Grupos
    if (urlObj.pathname === '/api/grupos' && req.method === 'GET') {
        try {
            if (!waSock || statusConexaoAtual !== "ONLINE") {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: 'WhatsApp não está conectado.' }));
                return;
            }
            const getGroups = await waSock.groupFetchAllParticipating();
            const grupos = Object.values(getGroups).map(g => ({
                id: g.id,
                subject: g.subject,
                participantsCount: g.participants.length
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true, grupos }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    // Rota: Limpar Sessão no Servidor
    if (urlObj.pathname === '/api/limpar' && req.method === 'POST') {
        try {
            const pastaSessao = path.join(__dirname, 'sessao_teste');
            if (waSock) {
                await waSock.logout().catch(() => {});
                waSock = null;
            }
            if (fs.existsSync(pastaSessao)) {
                fs.rmSync(pastaSessao, { recursive: true, force: true });
            }
            statusConexaoAtual = "OFFLINE";
            ultimoCodigoGerado = "--------";
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true, mensagem: 'Sessão limpa no servidor com sucesso.' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    // Rota: Execução de Comandos de Grupo
    if (urlObj.pathname === '/api/comando' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                if (!waSock || statusConexaoAtual !== "ONLINE") {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: 'WhatsApp não conectado.' }));
                    return;
                }
                const { acao, grupoId, param } = JSON.parse(body);

                if (acao === 'kick' && grupoId && param) {
                    await waSock.groupParticipantsUpdate(grupoId, [`${param.replace(/\D/g, '')}@s.whatsapp.net`], 'remove');
                } else if (acao === 'promote' && grupoId && param) {
                    await waSock.groupParticipantsUpdate(grupoId, [`${param.replace(/\D/g, '')}@s.whatsapp.net`], 'promote');
                } else if (acao === 'subject' && grupoId && param) {
                    await waSock.groupUpdateSubject(grupoId, param);
                } else if (acao === 'desc' && grupoId && param) {
                    await waSock.groupUpdateDescription(grupoId, param);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, mensagem: 'Comando executado.' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    // Status Geral
    if (urlObj.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusConexaoAtual, codigo: ultimoCodigoGerado }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZRX Rodando!\n');
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

async function iniciarWhatsApp(numeroTelefone) {
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
            statusConexaoAtual = "OFFLINE";
            if (status === DisconnectReason.loggedOut) {
                reconectando = false;
                return;
            }
            setTimeout(() => {
                reconectando = false;
                iniciarWhatsApp(numeroTelefone);
            }, 5000);
        } else if (connection === 'open') {
            reconectando = false;
            statusConexaoAtual = "ONLINE";
        }
    });

    if (!state.creds.registered && numeroTelefone) {
        await delay(3000);
        try {
            const codigo = await waSock.requestPairingCode(numeroTelefone);
            ultimoCodigoGerado = codigo;
            return codigo;
        } catch (error) {
            console.error("Erro ao solicitar código:", error);
        }
    }
    return ultimoCodigoGerado;
}
