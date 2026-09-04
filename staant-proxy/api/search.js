import { aplicarCors } from '../lib/cors.js';
import { checarRateLimit } from '../lib/rate-limit.js';

export default async function handler(req, res) {
    if (!aplicarCors(req, res)) return; // era um preflight OPTIONS, já respondido
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    if (!checarRateLimit(req, res)) return;

    const query = req.query.q;
    const isTopic = req.query.topic === 'true';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 30;
    const startIndexGoogle = (page - 1) * pageSize;

    if (!query) return res.status(400).json({ error: "Termo de busca não informado." });

    const normalizeText = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

    // Filtro de termos indesejados
    const forbiddenWords = [
        'manga', 'comic', 'hq', 'quadrinho', 'manhwa', 'manhua', 'webtoon',
        'erotico', 'erotica', 'erotismo', 'historia do olho', 'hot', 'adulto', 'sexo'
    ];

    try {
        let googleUrl, iaUrl, gutenUrl;

        if (isTopic) {
            // VITRINE / CARROSSEL: Com exclusões de gêneros
            const queryNorm = normalizeText(query);
            const isMangaSearch = queryNorm.includes('manga') || queryNorm.includes('hq') || queryNorm.includes('quadrinho');

            const adultExclusions = ' -erotica -erótico -erotismo -hot -sexo';
            const googleExclusions = (isMangaSearch ? '' : ' -manga -comic -quadrinhos -hq -"graphic novel" -manhwa -manhua -webtoon') + adultExclusions;
            const iaExclusions = (isMangaSearch ? '' : ' -subject:manga -subject:comic -subject:comics') + ' -subject:erotica -subject:adult -subject:erotismo';

            googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`subject:"${query}"${googleExclusions}`)}&filter=free-ebooks&langRestrict=pt&startIndex=${startIndexGoogle}&maxResults=${pageSize}`;
            iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`subject:"${query}"${iaExclusions}`)}+AND+mediatype:texts+AND+language:por+AND+format:epub&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=${pageSize}&page=${page}&output=json`;
            gutenUrl = `https://gutendex.com/books?topic=${encodeURIComponent(query)}&languages=pt&page=${page}`;

        } else {
            // BUSCA MANUAL: Direta e paginada
            googleUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&filter=free-ebooks&langRestrict=pt&startIndex=${startIndexGoogle}&maxResults=${pageSize}`;
            iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`"${query}"`)}+AND+mediatype:texts+AND+language:por+AND+format:epub&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=${pageSize}&page=${page}&output=json`;
            gutenUrl = `https://gutendex.com/books?search=${encodeURIComponent(query)}&languages=pt&page=${page}`;
        }

        // Busca simultânea com tolerância a falhas
        const [gRes, iaRes, gutRes] = await Promise.all([
            fetch(googleUrl).then(res => res.json()).catch(() => ({ items: [] })),
            fetch(iaUrl).then(res => res.json()).catch(() => ({ response: { docs: [] } })),
            fetch(gutenUrl).then(res => res.json()).catch(() => ({ results: [] }))
        ]);

        let books = [];
        const seenIds = new Set();

        // 1. Google Books
        if (gRes.items && Array.isArray(gRes.items)) {
            gRes.items.forEach(item => {
                if (seenIds.has(item.id)) return;
                const info = item.volumeInfo || {};
                const access = item.accessInfo || {};

                if (!access.epub || !access.epub.isAvailable || !access.epub.downloadLink) return;

                if (isTopic) {
                    if (info.maturityRating === 'MATURE') return;
                    if (info.title && forbiddenWords.some(w => normalizeText(info.title).includes(w))) return;
                }

                seenIds.add(item.id);
                const cover = info.imageLinks ? info.imageLinks.thumbnail : 'https://via.placeholder.com/150x220?text=Sem+Capa';
                books.push({
                    id: item.id,
                    title: info.title || 'Título Desconhecido',
                    author: info.authors ? info.authors.join(', ') : 'Autor Desconhecido',
                    cover: cover.replace('http:', 'https:'),
                    epubUrl: access.epub.downloadLink,
                    source: 'Google Books'
                });
            });
        }

        // 2. Internet Archive
        if (iaRes.response && Array.isArray(iaRes.response.docs)) {
            iaRes.response.docs.forEach(doc => {
                if (seenIds.has(doc.identifier)) return;
                if (isTopic && doc.title && forbiddenWords.some(w => normalizeText(doc.title).includes(w))) return;

                seenIds.add(doc.identifier);
                books.push({
                    id: doc.identifier,
                    title: doc.title || 'Título Desconhecido',
                    author: doc.creator ? (Array.isArray(doc.creator) ? doc.creator[0] : doc.creator) : 'Autor Desconhecido',
                    cover: `https://archive.org/services/img/${doc.identifier}`,
                    epubUrl: `https://archive.org/download/${doc.identifier}/${doc.identifier}.epub`,
                    source: 'Internet Archive'
                });
            });
        }

        // 3. Gutenberg
        if (gutRes.results && Array.isArray(gutRes.results)) {
            gutRes.results.forEach(book => {
                const bookIdStr = book.id ? book.id.toString() : '';
                if (!bookIdStr || seenIds.has(bookIdStr)) return;
                if (!book.formats || !book.formats['application/epub+zip']) return;
                if (isTopic && book.title && forbiddenWords.some(w => normalizeText(book.title).includes(w))) return;

                seenIds.add(bookIdStr);
                books.push({
                    id: bookIdStr,
                    title: book.title || 'Título Desconhecido',
                    author: (book.authors && book.authors.length > 0) ? book.authors[0].name : 'Autor Desconhecido',
                    cover: book.formats['image/jpeg'] || 'https://via.placeholder.com/150x220?text=Sem+Capa',
                    epubUrl: book.formats['application/epub+zip'],
                    source: 'Gutenberg'
                });
            });
        }

        return res.status(200).json({
            page,
            resultsCount: books.length,
            results: books
        });

    } catch (error) {
        console.error("Erro na busca:", error);
        return res.status(500).json({ error: "Erro interno no servidor." });
    }
}