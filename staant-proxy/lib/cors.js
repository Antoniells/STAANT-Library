// CORS restrito ao domínio da STAANT — nada de '*' liberando pra internet inteira.
const ORIGENS_PERMITIDAS = ['https://staant-library.web.app'];

/**
 * Aplica os headers de CORS e responde o preflight OPTIONS.
 * @returns {boolean} true = siga com o handler; false = já respondeu (era um OPTIONS)
 */
export function aplicarCors(req, res) {
    const origin = req.headers.origin;
    if (ORIGENS_PERMITIDAS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return false;
    }
    return true;
}
