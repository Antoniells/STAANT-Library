export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const query = req.query.q;
    const isTopic = req.query.topic === 'true'; 

    if (!query) return res.status(400).json({ error: "Termo de busca não informado." });

    const normalizeText = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    
    // O Leão de Chácara
    const forbiddenWords = [
        'manga', 'comic', 'hq', 'quadrinho', 'manhwa', 'manhua', 'webtoon',
        'erotico', 'erotica', 'erotismo', 'historia do olho', 'hot', 'adulto', 'sexo'
    ];

    try {
        let googleUrl, iaUrl, gutenUrl;

        if (isTopic) {
            // VITRINE: Com filtros pesados
            const queryNorm = normalizeText(query);
            const isMangaSearch = queryNorm.includes('manga') || queryNorm.includes('hq') || queryNorm.includes('quadrinho');
            
            const adultExclusions = ' -erotica -erótico -erotismo -hot -sexo';
            const googleExclusions = (isMangaSearch ? '' : ' -manga -comic -quadrinhos -hq -"graphic novel" -manhwa -manhua -webtoon') + adultExclusions;
            const iaExclusions = (isMangaSearch ? '' : ' -subject:manga -subject:comic -subject:comics') + ' -subject:erotica -subject:adult -subject:erotismo';

            googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`subject:"${query}"${googleExclusions}`)}&filter=free-ebooks&langRestrict=pt&maxResults=30`;
            iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`subject:"${query}"${iaExclusions}`)}+AND+mediatype:texts+AND+language:por+AND+format:epub&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=30&output=json`;
            gutenUrl = `https://gutendex.com/books?topic=${encodeURIComponent(query)}&languages=pt`;
            
        } else {
            // BUSCA MANUAL: Limpa e direta
            googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&filter=free-ebooks&langRestrict=pt&maxResults=30`;
            // Aspas forçadas para o Internet Archive não trazer "lixo" acadêmico
            iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`"${query}"`)}+AND+mediatype:texts+AND+language:por+AND+format:epub&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=30&output=json`;
            gutenUrl = `https://gutendex.com/books?search=${encodeURIComponent(query)}&languages=pt`;
        }

        // Uma única chamada limpa para cada biblioteca!
        const [gRes, iaRes, gutRes] = await Promise.all([
            fetch(googleUrl).then(res => res.json()).catch(() => ({ items: [] })),
            fetch(iaUrl).then(res => res.json()).catch(() => ({ response: { docs: [] } })),
            fetch(gutenUrl).then(res => res.json()).catch(() => ({ results: [] }))
        ]);

        let books = [];
        const seenIds = new Set(); 

        // 1. Processa Google
        if (gRes.items) {
            gRes.items.forEach(item => {
                if (seenIds.has(item.id)) return;
                const info = item.volumeInfo;
                const access = item.accessInfo;
                
                if (!access || !access.epub || !access.epub.isAvailable || !access.epub.downloadLink) return;
                
                if (isTopic) {
                    if (info.maturityRating === 'MATURE') return;
                    if (info.title && forbiddenWords.some(word => normalizeText(info.title).includes(word))) return;
                }
                
                seenIds.add(item.id);
                let cover = info.imageLinks ? info.imageLinks.thumbnail : 'https://via.placeholder.com/150x220?text=Sem+Capa';
                books.push({
                    id: item.id, title: info.title,
                    author: info.authors ? info.authors.join(', ') : 'Autor Desconhecido',
                    cover: cover.replace('http:', 'https:'), epubUrl: access.epub.downloadLink, source: 'Google Books'
                });
            });
        }

        // 2. Processa Internet Archive
        if (iaRes.response && iaRes.response.docs) {
            iaRes.response.docs.forEach(doc => {
                if (seenIds.has(doc.identifier)) return;
                if (isTopic && doc.title && forbiddenWords.some(word => normalizeText(doc.title).includes(word))) return;

                seenIds.add(doc.identifier);
                books.push({
                    id: doc.identifier, title: doc.title,
                    author: doc.creator ? (Array.isArray(doc.creator) ? doc.creator[0] : doc.creator) : 'Autor Desconhecido',
                    cover: `https://archive.org/services/img/${doc.identifier}`,
                    epubUrl: `https://archive.org/download/${doc.identifier}/${doc.identifier}.epub`, source: 'Internet Archive'
                });
            });
        }

        // 3. Processa Gutenberg
        if (gutRes.results) {
            gutRes.results.forEach(book => {
                if (seenIds.has(book.id.toString())) return;
                if (!book.formats['application/epub+zip']) return;
                if (isTopic && book.title && forbiddenWords.some(word => normalizeText(book.title).includes(word))) return;

                seenIds.add(book.id.toString());
                books.push({
                    id: book.id.toString(), title: book.title,
                    author: book.authors.length > 0 ? book.authors[0].name : 'Autor Desconhecido',
                    cover: book.formats['image/jpeg'] || 'https://via.placeholder.com/150x220?text=Sem+Capa',
                    epubUrl: book.formats['application/epub+zip'], source: 'Gutenberg'
                });
            });
        }

        return res.status(200).json({ results: books });
    } catch (error) {
        return res.status(500).json({ error: "Erro interno no servidor." });
    }
}