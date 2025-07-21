import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import { initWhatsApp, removeSession } from './whatsappService';
import { db, admin } from './firebaseAdmin';

dotenv.config();

const logger = pino({
    transport: {
      target: 'pino-pretty'
    },
    level: 'info'
});

const allowedOrigins = [
  process.env.CLIENT_URL || 'https://gestorelite.app', // URL de produção
  'http://localhost:3000', // URL de desenvolvimento comum
  'http://localhost:9002'  // URL de desenvolvimento reportada no erro
];

const app = express();
const port = process.env.PORT || 8000;

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json());

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: function (origin, callback) {
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Lógica de autenticação movida para cá
const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).send('Acesso não autorizado.');
    try {
        (req as any).user = await admin.auth().verifyIdToken(token);
        next();
    } catch (error) {
        res.status(401).send('Acesso não autorizado: Token inválido.');
    }
};

const authSocket = (logger: pino.Logger) => {
    return async (socket: Socket, next: (err?: Error) => void) => {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error('Autenticação falhou: token não fornecido.'));
        try {
            (socket as any).user = await admin.auth().verifyIdToken(token);
            next();
        } catch (error) {
            next(new Error('Autenticação falhou: token inválido.'));
        }
    };
};

io.use(authSocket(logger));

io.on('connection', (socket) => {
    const userId = (socket as any).user.uid;
    const sessionLogger = logger.child({ sessionId: userId });
    let currentSessionId: string | null = null;

    sessionLogger.info('Novo cliente conectado via WebSocket.');
    
    socket.on('startSession', ({ sessionId }: { sessionId: string }) => {
        sessionLogger.info({ sessionId }, 'Cliente solicitou para iniciar/usar a sessão.');
        currentSessionId = sessionId;
        
        // Inicia e configura a sessão do WhatsApp
        initWhatsApp(socket, io, userId);
    });

    socket.on('disconnect', () => {
        sessionLogger.info({ currentSessionId }, 'Cliente desconectado.');
        if (currentSessionId) {
            // Remove a sessão do Baileys de forma graciosa ao desconectar
            removeSession(currentSessionId);
        }
    });
});

// Rota para deletar um chat e suas mensagens
app.delete('/chats/:chatId', verifyToken, async (req: any, res: any) => {
    const userId = req.user.uid;
    const { chatId } = req.params;

    if (!userId || !chatId) {
        return res.status(400).send('User ID e Chat ID são obrigatórios.');
    }
    
    const loggerWithSession = logger.child({ sessionId: userId, chatId });

    try {
        loggerWithSession.info('Iniciando exclusão de chat.');
        
        const chatRef = db.collection('users').doc(userId).collection('whatsapp_chats').doc(chatId);
        const messagesSnapshot = await chatRef.collection('messages').get();

        if (messagesSnapshot.empty) {
            loggerWithSession.info('Nenhuma mensagem encontrada para deletar, deletando apenas o chat.');
        } else {
             const batch = db.batch();
             messagesSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            loggerWithSession.info(`Lote de ${messagesSnapshot.size} mensagens deletado com sucesso.`);
        }
        
        await chatRef.delete();

        loggerWithSession.info('Chat deletado com sucesso.');
        res.status(200).send({ message: 'Chat deletado com sucesso.' });
    } catch (error) {
        loggerWithSession.error({ error }, 'Erro ao deletar o chat.');
        res.status(500).send({ error: 'Falha ao deletar o chat.' });
    }
});

httpServer.listen(port, () => {
    logger.info(`Servidor rodando na porta ${port}`);
}); 