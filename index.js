const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const P = require('pino');
const http = require('http');

// Cria um servidor HTTP básico para o Render não dar Timeout
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ZRX Bot Online!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Inicializa o Firebase
initializeApp();
const db = getFirestore();

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                iniciarBot();
            }
        } else if (connection === 'open') {
            console.log('🚀 WhatsApp conectado com sucesso na nuvem!');
        }
    });

    // Escuta a coleção de pareamento
    db.collection('sessoes_pareamento').onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const docId = change.doc.id; 
                const dados = change.doc.data();

                if (dados && dados.status === 'pendente' && dados.numero) {
                    const numeroTelefone = dados.numero;
                    console.log(`📱 Solicitação recebida para o número: ${numeroTelefone}`);

                    try {
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        const codigoPareamento = await sock.requestPairingCode(numeroTelefone);
                        console.log(`✨ Código de 8 dígitos gerado: ${codigoPareamento}`);

                        await db.collection('sessoes_pareamento').doc(docId).update({
                            codigoBaileys: codigoPareamento,
                            status: 'gerado'
                        });

                    } catch (erro) {
                        console.error('Erro ao gerar o código:', erro);
                        await db.collection('sessoes_pareamento').doc(docId).update({
                            status: 'erro'
                        });
                    }
                }
            }
        });
    });
}

iniciarBot();
