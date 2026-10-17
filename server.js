const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

let waSock = null;
let statusConexaoAtual = "OFFLINE";
let ultimoCodigoGerado = "--------";
let modosBrincadeira = {};

const XAI_API_KEY = process.env.XAI_API_KEY || "xai-It1hSBKgDociGem1UrHCDQuAAEBU6uLNpd12ORpiRMf1VobVtBqSPnYU31s120O7ehCNvGDVIXMou6xW";
const PORT = process.env.PORT || 3000;

// Função para consultar a IA do Grok
async function consultarGrok(prompt, systemPrompt = "Você é um mestre de jogos e brincadeiras interativas para grupos no WhatsApp. Seja divertido, direto e dinâmico.") {
    try {
        const response = await fetch("https://api.x.ai/v1/responses", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${XAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "grok-4.7",
                input: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ]
            })
        });
        const data = await response.json();
        if (data.output && data.output.length > 0) {
            return data.output[0].content || data.output[0].text;
        }
        return "Desculpe, não consegui gerar a brincadeira agora.";
    } catch (e) {
        console.error("Erro na API do Grok:", e);
        return "Erro ao se comunicar com a IA do Grok.";
    }
}

// Inicia a conexão do WhatsApp via Baileys
async function iniciarWhatsApp(numeroTelefone = null) {
    try {
        statusConexaoAtual = "CONECTANDO";
        const authPath = path.join(__dirname, 'auth_info_baileys');
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        waSock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["ZRX Operator", "Chrome", "1.0.0"]
        });

        waSock.ev.on('creds.update', saveCreds);

        if (numeroTelefone && !waSock.authState.creds.registered) {
            await delay(4000);
            const numeroLimpo = numeroTelefone.replace(/[^0-9]/g, '');
            const code = await waSock.requestPairingCode(numeroLimpo);
            ultimoCodigoGerado = code;
            console.log(`[BAILEYS] Código de Pareamento Gerado: ${code}`);
        }

        waSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                statusConexaoAtual = "OFFLINE";
                console.log('[BAILEYS] Conexão fechada. Reconectando:', shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(() => iniciarWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                statusConexaoAtual = "ONLINE";
                console.log('[BAILEYS] WhatsApp conectado com sucesso!');
                escutarMensagensWhatsApp();
            }
        });

    } catch (err) {
        console.error("[BAILEYS] Erro na inicialização:", err);
        statusConexaoAtual = "OFFLINE";
    }
}

// Escutador de mensagens do WhatsApp para comandos
function escutarMensagensWhatsApp() {
    if (!waSock) return;

    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const textoMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (!isGroup) continue;

            if (textoMsg.toLowerCase().trim() === '/br') {
                if (!modosBrincadeira[from]) {
                    await waSock.sendMessage(from, { text: "⚠️ O Modo Brincadeiras está desativado neste grupo. Ative-o pelo painel ZRX Operator!" });
                    continue;
                }

                const menuText = `🎮 *MENU DE BRINCADEIRAS COM IA (Grok)* 🤖\n\n` +
                    `1️⃣ *Pergunta e Resposta*\n` +
                    `2️⃣ *Verdade ou Desafio*\n` +
                    `3️⃣ *Jogo da Forca*\n` +
                    `4️⃣ *Quiz em Grupo*\n\n` +
                    `👉 Envie */comecar <numero_ou_nome>* para iniciar!\n` +
                    `Exemplo: */comecar 2* ou */comecar Verdade ou Desafio*`;

                await waSock.sendMessage(from, { text: menuText });
            }

            if (textoMsg.toLowerCase().startsWith('/comecar')) {
                if (!modosBrincadeira[from]) {
                    await waSock.sendMessage(from, { text: "⚠️ O Modo Brincadeiras está desativado neste grupo. Ative pelo painel primeiro!" });
                    continue;
                }

                const senderName = msg.pushName || "Participante";
                const arg = textoMsg.replace(/\/comecar/i, '').trim();

                let promptGrok = "";
                if (arg.includes("1") || arg.toLowerCase().includes("pergunta")) {
                    promptGrok = `Gere uma pergunta muito engraçada, curiosa ou desafiadora para o jogador ${senderName}. Em seguida, diga para ele responder e marcar quem deve ser o próximo participante.`;
                } else if (arg.includes("2") || arg.toLowerCase().includes("verdade")) {
                    promptGrok = `Gere uma opção aleatória de 'Verdade ou Desafio' para o jogador ${senderName}. Diga se é Verdade ou Desafio, mande a pergunta/desafio e mande ele cumprir e marcar o próximo membro.`;
                } else if (arg.includes("3") || arg.toLowerCase().includes("forca")) {
                    promptGrok = `Inicie um Jogo da Forca para o grupo. Dê uma dica da palavra secreta, a quantidade de letras com traços (ex: _ _ _ _ _) e chame o jogador ${senderName} para dar o primeiro palpite e marcar o próximo!`;
                } else if (arg.includes("4") || arg.toLowerCase().includes("quiz")) {
                    promptGrok = `Gere uma pergunta de Quiz de conhecimentos gerais divertida com 4 alternativas (A, B, C, D) para o jogador ${senderName}. Diga para ele responder e marcar a próxima pessoa do grupo.`;
                } else {
                    promptGrok = `Gere uma brincadeira de grupo divertida para o jogador ${senderName}. Explique o objetivo rapidamente e mande ele indicar e marcar o próximo membro com @.`;
                }

                await waSock.sendMessage(from, { text: "🤖 *Grok está criando a brincadeira...*" });

                const respostaIA = await consultarGrok(promptGrok);
                const mensagemFinal = `🎲 *RODADA DE BRINCADEIRA* 🎲\n\n👤 *Jogador da Vez:* ${senderName}\n\n${respostaIA}\n\n📌 *Lembre-se:* Para passar a vez, responda marcando outro membro no grupo!`;

                await waSock.sendMessage(from, { text: mensagemFinal });
            }
        }
    });
}

// Servidor HTTP de Integração com o Painel
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname === '/api/conectar' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { numero } = JSON.parse(body);
                // Reseta a sessão anterior antes de pedir um novo código
                const authPath = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                if (waSock) waSock.end();

                await iniciarWhatsApp(numero);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, codigo: ultimoCodigoGerado }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    if (urlObj.pathname === '/api/comando' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { acao, grupoId, param } = JSON.parse(body);

                if (acao === 'toggle_brincadeira' && grupoId) {
                    modosBrincadeira[grupoId] = (param === 'on');
                    const statusText = modosBrincadeira[grupoId] ? "ATIVADO" : "DESATIVADO";
                    if (waSock) {
                        await waSock.sendMessage(grupoId, { text: `🎮 *Modo Brincadeiras com IA foi ${statusText}!*\nUse o comando */br* no grupo para ver o menu de jogos.` });
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Modo Brincadeiras ${statusText}` }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, mensagem: "Comando processado." }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    if (urlObj.pathname === '/api/grupos' && req.method === 'GET') {
        try {
            if (!waSock) throw new Error("WhatsApp não está conectado.");
            const chats = await waSock.groupFetchAllParticipating();
            const listaGrupos = Object.values(chats).map(g => ({
                id: g.id,
                subject: g.subject,
                participantsCount: g.participants?.length || 0
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true, grupos: listaGrupos }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    if (urlObj.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusConexaoAtual, codigo: ultimoCodigoGerado }));
        return;
    }

    if (urlObj.pathname === '/api/limpar' && req.method === 'POST') {
        try {
            const authPath = path.join(__dirname, 'auth_info_baileys');
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
            if (waSock) waSock.end();
            statusConexaoAtual = "OFFLINE";
            ultimoCodigoGerado = "--------";
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZRX com IA Grok Rodando!\n');
});

server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
