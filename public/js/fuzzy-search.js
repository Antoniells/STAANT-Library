// Busca difusa sem dependências, tolerante a erros de digitação.
// Otimizações: Levenshtein com buffer de uma linha só (O(min(a,b)) memória)
// e corte antecipado por linha (aborta assim que a distância mínima possível
// já estourou o limite, evitando terminar a matriz inteira à toa).

const normalize = (str) =>
    str.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function levenshteinBounded(a, b, maxDist) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > maxDist) return Infinity;
    if (a.length > b.length) [a, b] = [b, a];

    const aLen = a.length, bLen = b.length;
    let prevRow = new Array(aLen + 1);
    for (let i = 0; i <= aLen; i++) prevRow[i] = i;

    for (let j = 1; j <= bLen; j++) {
        const currRow = new Array(aLen + 1);
        currRow[0] = j;
        let rowMin = j;
        const bChar = b.charCodeAt(j - 1);

        for (let i = 1; i <= aLen; i++) {
            const cost = a.charCodeAt(i - 1) === bChar ? 0 : 1;
            currRow[i] = Math.min(
                prevRow[i] + 1,       // remoção
                currRow[i - 1] + 1,   // inserção
                prevRow[i - 1] + cost // substituição
            );
            if (currRow[i] < rowMin) rowMin = currRow[i];
        }

        if (rowMin > maxDist) return Infinity; // corte antecipado
        prevRow = currRow;
    }
    return prevRow[aLen];
}

// Similaridade [0,1] entre duas palavras. Substring direta (typo parcial,
// abreviação) conta quase como match perfeito.
function wordSimilarity(query, word, maxDist) {
    if (!word) return 0;
    if (word.includes(query)) return 1 - (word.length - query.length) / (word.length * 4);
    const dist = levenshteinBounded(query, word, maxDist);
    return dist === Infinity ? 0 : 1 - dist / Math.max(query.length, word.length);
}

/**
 * @param {Array<{title:string, author:string}>} books
 * @param {string} term
 * @param {{threshold?: number, keys?: string[]}} [options]
 * @returns {Array} livros ordenados por relevância (mais relevante primeiro)
 */
export function fuzzySearchBooks(books, term, options = {}) {
    const { threshold = 0.45, keys = ['title', 'author'] } = options;
    const queryWords = normalize(term).split(/\s+/).filter(Boolean);
    if (!queryWords.length) return books;

    const results = [];

    for (const book of books) {
        let totalScore = 0;

        for (const q of queryWords) {
            const maxDist = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
            let bestForWord = 0;

            outer: for (const key of keys) {
                const fieldWords = normalize(book[key] || '').split(/\s+/);
                for (const w of fieldWords) {
                    const sim = wordSimilarity(q, w, maxDist);
                    if (sim > bestForWord) bestForWord = sim;
                    if (bestForWord === 1) break outer;
                }
            }
            totalScore += bestForWord;
        }

        const score = totalScore / queryWords.length;
        if (score >= threshold) results.push({ book, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.map((r) => r.book);
}
