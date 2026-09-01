// Reordenar livros da estante arrastando.
// Usa Pointer Events (funciona igual pra mouse, toque e caneta). No toque exige
// segurar ~350ms antes de arrastar, senão rolar a página viraria arrastar sem querer.
const ORDER_KEY_PREFIX = 'staant_book_order_';

const orderKey = (uid) => `${ORDER_KEY_PREFIX}${uid}`;

export function loadOrder(uid) {
    try { return JSON.parse(localStorage.getItem(orderKey(uid)) || '[]'); } catch (_) { return []; }
}

export function saveOrder(uid, ids) {
    try { localStorage.setItem(orderKey(uid), JSON.stringify(ids)); } catch (_) {}
}

// Ordena os livros pela ordem escolhida pelo usuário. Livros novos (ainda sem
// posição salva) vão pro topo, pra não "sumirem" no fim da estante.
export function applyOrder(books, uid) {
    const ordem = loadOrder(uid);
    if (!ordem.length) return books;

    const posicao = new Map(ordem.map((id, i) => [id, i]));
    const conhecidos = [];
    const novos = [];
    books.forEach(b => (posicao.has(b.id) ? conhecidos : novos).push(b));
    conhecidos.sort((a, b) => posicao.get(a.id) - posicao.get(b.id));
    return [...novos, ...conhecidos];
}

// Liga o arrastar-e-soltar no container da estante.
// onReorder(idsNaNovaOrdem) é chamado quando o usuário solta o card.
export function enableReordering(container, onReorder) {
    if (container.dataset.reorderEnabled === 'true') return;
    container.dataset.reorderEnabled = 'true';

    let card = null;          // card sendo arrastado
    let pressTimer = null;    // temporizador do "segurar pra arrastar" (toque)
    let arrastando = false;
    let pointerId = null;

    const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

    function cardFromPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest('.book-card-modern') : null;
    }

    function comecarArrasto() {
        if (!card) return;
        arrastando = true;
        card.classList.remove('drag-ready');
        card.classList.add('dragging');
        container.classList.add('is-reordering');
        // Trava a rolagem enquanto o dedo estiver arrastando o card
        container.style.touchAction = 'none';
        if (navigator.vibrate) navigator.vibrate(15); // confirma o "pegou" no celular
    }

    function limpar() {
        clearTimeout(pressTimer);
        if (card) card.classList.remove('dragging', 'drag-ready');
        container.classList.remove('is-reordering');
        container.style.touchAction = '';
        card = null; arrastando = false; pointerId = null;
    }

    // Alguns navegadores mobile começam a rolar antes do pointermove; este listener
    // não-passivo garante que a página fique parada durante o arrasto.
    container.addEventListener('touchmove', (e) => {
        if (arrastando) e.preventDefault();
    }, { passive: false });

    container.addEventListener('pointerdown', (e) => {
        // Só botão principal do mouse; ignora clique nos botões de ação do card
        if (e.button !== 0) return;
        if (e.target.closest('button')) return;

        const alvo = e.target.closest('.book-card-modern');
        if (!alvo || !container.contains(alvo)) return;

        card = alvo;
        pointerId = e.pointerId;

        if (isTouch(e)) {
            // No toque, espera segurar pra não atrapalhar a rolagem
            card.classList.add('drag-ready');
            pressTimer = setTimeout(comecarArrasto, 350);
        } else {
            comecarArrasto();
        }
    });

    container.addEventListener('pointermove', (e) => {
        if (!card || e.pointerId !== pointerId) return;

        if (!arrastando) {
            // Mexeu antes de completar o "segurar"? Era rolagem, não arrasto.
            clearTimeout(pressTimer);
            card.classList.remove('drag-ready');
            return;
        }

        e.preventDefault(); // segura a rolagem enquanto arrasta
        const alvo = cardFromPoint(e.clientX, e.clientY);
        if (!alvo || alvo === card || !container.contains(alvo)) return;

        // Insere antes ou depois conforme o lado em que o cursor entrou no card
        const r = alvo.getBoundingClientRect();
        const depois = (e.clientX - r.left) > r.width / 2;
        container.insertBefore(card, depois ? alvo.nextSibling : alvo);
    });

    function finalizar(e) {
        if (!card || (pointerId !== null && e.pointerId !== pointerId)) return;
        const estavaArrastando = arrastando;
        limpar();
        if (estavaArrastando) {
            const ids = [...container.querySelectorAll('.book-card-modern')]
                .map(el => el.dataset.bookId)
                .filter(Boolean);
            onReorder(ids);
        }
    }

    container.addEventListener('pointerup', finalizar);
    container.addEventListener('pointercancel', finalizar);
    // Soltou fora da estante: encerra do mesmo jeito, sem deixar card "grudado"
    window.addEventListener('pointerup', finalizar);
}
