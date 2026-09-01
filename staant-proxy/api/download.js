export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const bookUrl = req.query.url;
    if (!bookUrl) return res.status(400).send("URL não informada.");

    try {
        let secureUrl = bookUrl.replace("http://", "https://");
        let response = await fetch(secureUrl, { redirect: 'follow' });

        // 🧠 MÁGICA PARA O INTERNET ARCHIVE: Se deu 404 (arquivo não encontrado), vamos buscar o nome real!
        if (response.status === 404 && secureUrl.includes('archive.org')) {
            const urlParts = secureUrl.split('/');
            const identifier = urlParts[4]; 
            
            // Pede os metadados do livro para a API do Archive
            const metaRes = await fetch(`https://archive.org/metadata/${identifier}`);
            const metaData = await metaRes.json();
            
            // Procura o arquivo exato que tem o formato EPUB
            if (metaData && metaData.files) {
                const epubFile = metaData.files.find(f => f.format === 'EPUB');
                if (epubFile) {
                    secureUrl = `https://archive.org/download/${identifier}/${epubFile.name}`;
                    response = await fetch(secureUrl, { redirect: 'follow' }); // Tenta de novo com o nome certo!
                }
            }
        }

        if (!response.ok) {
            return res.status(400).send(`Bloqueado na origem. Status: ${response.status}`);
        }

        // 🛡️ PROTEÇÃO CONTRA O GOOGLE BOOKS: Se ele tentar entregar uma página web no lugar do livro...
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            return res.status(400).send("A API do Google retornou uma página de login/verificação.");
        }

        // Tudo certo! Entrega o arquivo.
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        res.setHeader("Content-Type", "application/epub+zip");
        return res.send(buffer);
        
    } catch (error) {
        console.error("Proxy error:", error);
        return res.status(500).send("Erro no servidor Vercel.");
    }
}