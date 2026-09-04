// Limitador de taxa simples, em memória, sem dependências externas.
// Funciona por instância do processo Vercel — não é preciso quando há
// múltiplas instâncias em paralelo, mas já corta abuso de script/bot casual
// sem precisar de um banco externo (Redis/KV).
const hits = new Map(); // ip -> lista de timestamps das chamadas recentes
const WINDOW_MS = 60_000;

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || 'desconhecido';
}

/**
 * @param {object} req
 * @param {object} res
 * @param {{limit?: number}} [options] máximo de chamadas por minuto por IP (padrão 20)
 * @returns {boolean} true = pode continuar; false = já respondeu 429 (interrompa o handler)
 */
export function checarRateLimit(req, res, { limit = 20 } = {}) {
    const ip = getClientIp(req);
    const agora = Date.now();
    const recentes = (hits.get(ip) || []).filter((t) => agora - t < WINDOW_MS);

    if (recentes.length >= limit) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.' });
        return false;
    }

    recentes.push(agora);
    hits.set(ip, recentes);
    return true;
}
