import { Request, Response, NextFunction } from 'express';
import { Socket } from 'socket.io';
import { admin } from './firebaseAdmin';
import pino from 'pino';

// Middleware para verificar o token JWT do Firebase em rotas Express
export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split('Bearer ')[1];

    if (!token) {
        return res.status(401).send('Acesso n├úo autorizado: Nenhum token fornecido.');
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        (req as any).user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).send('Acesso n├úo autorizado: Token inv├ílido.');
    }
};

// Middleware para autenticar conex├╡es Socket.IO
export const authSocket = (logger: pino.Logger) => {
    return async (socket: Socket, next: (err?: Error) => void) => {
        const token = socket.handshake.auth.token;

        if (!token) {
            logger.warn({ socketId: socket.id }, 'Tentativa de conex├úo sem token.');
            return next(new Error('Autentica├º├úo falhou: token n├úo fornecido.'));
        }

        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            (socket as any).user = decodedToken;
            logger.info({ userId: decodedToken.uid, socketId: socket.id }, 'Socket autenticado com sucesso.');
            next();
        } catch (error) {
            logger.error({ error, socketId: socket.id }, 'Falha na autentica├º├úo do socket.');
            next(new Error('Autentica├º├úo falhou: token inv├ílido.'));
        }
    };
}; 