// "Cofre forte" dos livros baixados para leitura offline (IndexedDB — suporta
// centenas de MB, ao contrário do localStorage, que estouraria com um único EPUB).
const DB_NAME = 'staant_offline';
const DB_VERSION = 1;
const STORE = 'books';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Salva o arquivo do livro (Blob) + metadados básicos pra retomar a leitura sem rede.
export async function saveBookOffline(id, blob, { title, cover, fileType } = {}) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ id, blob, title, cover, fileType, savedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getOfflineBook(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function removeOfflineBook(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Retorna o Set de IDs já baixados — usado pra desenhar o selo de "disponível offline" nos cards.
export async function listOfflineBookIds() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(new Set(req.result || []));
        req.onerror = () => reject(req.error);
    });
}
