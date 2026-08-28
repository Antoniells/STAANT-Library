const { onRequest } = require("firebase-functions/v2/https");

// Cria uma rota de API chamada "baixarlivro"
exports.baixarlivro = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
    const bookUrl = req.query.url;
    
    // Verifica se a URL foi enviada
    if (!bookUrl) {
        res.status(400).send("URL do livro não informada.");
        return;
    }

    try {
        // Força HTTPS para evitar erros do Gutenberg
        const secureUrl = bookUrl.replace("http://", "https://");
        
        // O Google (Backend) faz o download (Não sofre bloqueio de CORS)
        const response = await fetch(secureUrl);
        
        if (!response.ok) {
            res.status(response.status).send("Falha ao baixar do Gutenberg.");
            return;
        }

        // Pega o arquivo binário da memória do servidor
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Devolve o arquivo limpo para o seu Front-end
        res.setHeader("Content-Type", "application/epub+zip");
        res.send(buffer);
        
    } catch (error) {
        console.error("Erro interno no backend:", error);
        res.status(500).send("Erro interno ao baixar o arquivo.");
    }
});