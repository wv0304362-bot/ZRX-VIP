const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, onSnapshot, doc, updateDoc } = require('firebase/firestore');
const P = require('pino');
const http = require('http');

// Servidor HTTP simples para o Render não dar Timeout
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ZRX Bot Online!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

// Configuração oficial do Firebase (a mesma do seu HTML!)
const firebaseConfig = {
  apiKey: "AIzaSyAxVV73hiMlKeF0FMRM_ISklIv5qViOAmE",
  authDomain: "zrx-destroyer-7da8a.firebaseapp.com",
  projectId: "zrx-destroyer-7da8a",
  storageBucket: "zrx-destroyer-7da8a.firebasestorage.app",
  messagingSenderId: "157750091270",
  appId: "1:157750091270:web:d6f633da69d83b87dc2d87"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

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

    // Escuta a coleção 'sessoes_pareamento' em tempo real usando o SDK Web
    onSnapshot(collection(db, "sessoes_pareamento"), async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const docId = change.doc.id; 
                const dados = change.doc.data();

                if (dados && dados.status === 'pendente') {
                    // Se o painel mandou um número ou se usarmos o ID como fallback
                    const numeroTelefone = dados.numero || docId;
                    console.log(`📱 Solicitação de pareamento detectada para: ${numeroTelefone}`);

                    try {
                        await new Promise(resolve => setTimeout(resolve, 3000));

                        // Solicita o código real de 8 dígitos ao WhatsApp via Baileys
                        const codigoPareamento = await sock.requestPairingCode(numeroTelefone);
                        console.log(`✨ Código real de 8 dígitos do WhatsApp gerado: ${codigoPareamento}`);

                        // Atualiza o documento no Firebase para o painel exibir o código real
                        const docRef = doc(db, "sessoes_pareamento", docId);
                        await updateDoc(docRef, {
                            codigoBaileys: codigoPareamento,
                            status: 'gerado'
                        });

                    } catch (erro) {
                        console.error('Erro ao gerar o código de pareamento:', erro);
                        const docRef = doc(db, "sessoes_pareamento", docId);
                        await updateDoc(docRef, {
                            status: 'erro'
                        });
                    }
                }
            }
        });
    });
}

iniciarBot();
