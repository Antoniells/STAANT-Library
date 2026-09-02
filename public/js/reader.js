        import { auth, db } from '../firebase-config.js';
        import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
        import { doc, getDoc, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
        import { getOfflineBook } from '../offline-books.js';
        import { addReadingMinutes } from '../reading-stats.js';

        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

        // ─── CRONÔMETRO DE LEITURA ── conta 1 minuto de cada vez, e só enquanto a
        // aba está visível (não conta livro esquecido aberto em outra aba).
        setInterval(() => {
            if (document.visibilityState === 'visible') addReadingMinutes(1);
        }, 60000);

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js');
        }

        let pdfDoc = null, pageNum = 1, pageIsRendering = false, pageNumIsPending = null;
        let book, rendition;
        let currentSelection = null;
        let isNavigating     = false;
        let lastTouchTime    = 0;
        let bookKey          = ''; // Identidade estável do livro p/ progresso, posição e destaques (ID > título)
        let isCloudBook      = false;   // true quando o livro vem do Firestore/Supabase (não de um arquivo local)
        let canSaveProgress  = false;   // só grava progresso após ~1min de leitura de fato
        let cloudBookData    = null;    // snapshot do doc do livro (progress/position salvos)
        let saveProgressTimer = null;

        const THEME_KEY     = 'staant_theme';
        const FONT_KEY      = 'staant_font_size';
        const READ_MODE_KEY = 'staant_read_mode';
        let fontSize = parseInt(localStorage.getItem(FONT_KEY)) || 16;

        onAuthStateChanged(auth, (user) => {
            if (!user) { window.location.href = 'login.html'; return; }
            initReader();
        });

async function initReader() {
            const cloudUrl = localStorage.getItem('currentEpubUrl');
            const bookId   = localStorage.getItem('currentBookId');
            const localId  = bookId;

            if (cloudUrl) {
                isCloudBook = true;
                const loadPromise = openBestSource(cloudUrl, bookId);
                // Evita ficar girando "Carregando..." pra sempre se o link estiver quebrado/travado
                Promise.race([
                    loadPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000))
                ]).catch(showReaderError);
            } else if (localId) {
                const req = indexedDB.open('STAANT_DB', 2);
                req.onsuccess = (e) => {
                    const store = e.target.result.transaction(['books'],'readonly').objectStore('books');
                    store.get(parseInt(localId)).onsuccess = (ev) => {
                        if (ev.target.result) loadEpub(ev.target.result.data, ev.target.result.title);
                    };
                };
            } else { window.location.href = 'index.html'; }
        }

        // Prefere a cópia já baixada no dispositivo (não gasta banda do Supabase e funciona
        // sem internet); se não tiver, busca da nuvem; se a rede falhar, tenta a cópia offline
        // como último recurso antes de desistir.
        async function openBestSource(cloudUrl, bookId) {
            const isPdfUrl = cloudUrl.toLowerCase().includes('.pdf');

            async function loadFromOffline() {
                if (!bookId) return false;
                const offline = await getOfflineBook(bookId).catch(() => null);
                if (!offline) return false;
                const buffer = await offline.blob.arrayBuffer();
                const isPdf = offline.fileType === 'pdf' || isPdfUrl;
                if (isPdf) await loadPdf(buffer); else await loadEpub(buffer);
                return true;
            }

            if (await loadFromOffline()) return;

            try {
                if (isPdfUrl) await loadPdf(cloudUrl); else await loadEpub(cloudUrl);
            } catch (err) {
                if (await loadFromOffline()) return;
                throw err;
            }
        }

        function getSize() {
            const el = document.getElementById('reader-container');
            const w = isCustomFS ? Math.min(window.innerWidth, 800) : Math.min(el.clientWidth || window.innerWidth, 800);
            const h = isCustomFS ? window.innerHeight : (el.clientHeight || (window.innerHeight - 112));
            return { w, h };
        }

        // Chrome imersivo: esconde/mostra a barra de cima E a de fonte juntas
        // (rolagem estilo YouVersion e modo tela cheia usam as mesmas duas funções).
        let chromeAutoHideTimer = null;
        function hideChrome() {
            clearTimeout(chromeAutoHideTimer);
            document.getElementById('ui-wrapper').classList.add('ui-hidden');
            document.getElementById('fontSizeBar').classList.add('ui-hidden');
            document.getElementById('reader-container').classList.add('chrome-hidden');
        }
        function showChrome() {
            document.getElementById('ui-wrapper').classList.remove('ui-hidden');
            document.getElementById('fontSizeBar').classList.remove('ui-hidden');
            document.getElementById('reader-container').classList.remove('chrome-hidden');

            // Em tela cheia (ou na rolagem imersiva), some sozinho de novo depois de ~3s
            clearTimeout(chromeAutoHideTimer);
            const emTelaCheia = document.fullscreenElement || document.webkitFullscreenElement || isCustomFS;
            const emRolagem   = document.getElementById('reader-container').classList.contains('scroll-mode');
            if (emTelaCheia || emRolagem) {
                chromeAutoHideTimer = setTimeout(hideChrome, 3000);
            }
        }

        // Link quebrado, arquivo corrompido ou carregamento travado: avisa em vez de girar pra sempre
        function showReaderError(err) {
            console.error('Erro ao carregar livro:', err);
            const msg = (err && err.message === 'timeout')
                ? 'Este livro está demorando demais para carregar. O link pode estar quebrado.'
                : 'Não foi possível abrir este livro. O arquivo pode estar corrompido ou o link quebrado.';
            document.getElementById('readerErrorMsg').textContent = msg;
            document.getElementById('readerError').style.display = 'flex';
        }

        function showConfirm(message) {
            return new Promise((resolve) => {
                const modal = document.getElementById('confirmModal');
                document.getElementById('confirmMessage').textContent = message;
                modal.style.display = 'flex';
                const cleanup = (result) => { modal.style.display = 'none'; resolve(result); };
                document.getElementById('confirmOkBtn').onclick = () => cleanup(true);
                document.getElementById('confirmCancelBtn').onclick = () => cleanup(false);
            });
        }

        // Grava progresso no Firestore (com debounce) — só depois de ~1min de leitura de verdade
        function saveProgress(fields) {
            if (!isCloudBook || !canSaveProgress || !bookKey) return;
            clearTimeout(saveProgressTimer);
            saveProgressTimer = setTimeout(() => {
                updateDoc(doc(db, 'books', bookKey), { ...fields, lastReadAt: Date.now() })
                    .catch(e => console.error('Erro ao salvar progresso:', e));
            }, 1200);
        }

        // ─── DESTAQUES: armazenamento local + sync opcional no Firestore ───────────
        function getHighlights() {
            return JSON.parse(localStorage.getItem(`hl_${bookKey}`)) || [];
        }
        function setHighlights(hls) {
            localStorage.setItem(`hl_${bookKey}`, JSON.stringify(hls));
        }
        // Nunca sobrescreve o array inteiro (evita apagar destaque feito em outro aparelho)
        function syncHighlight(op, entry) {
            if (!isCloudBook || !bookKey) return;
            updateDoc(doc(db, 'books', bookKey), { highlights: op === 'add' ? arrayUnion(entry) : arrayRemove(entry) })
                .catch(e => console.error('Erro ao sincronizar destaque:', e));
        }
        // Mescla os destaques vindos do Firestore com os locais (sem duplicar)
        function mergeCloudHighlights() {
            if (!cloudBookData?.highlights?.length) return;
            const local = getHighlights();
            const merged = [...local];
            cloudBookData.highlights.forEach(h => {
                const exists = merged.some(m => (h.cfi && m.cfi === h.cfi) || (h.id && m.id === h.id));
                if (!exists) merged.push(h);
            });
            setHighlights(merged);
        }

        // ── CARREGAR EPUB ─────────────────────────────────────────────────────────────
// ── CARREGAR EPUB ─────────────────────────────────────────────────────────────
        async function loadEpub(source, fallbackTitle = 'Livro') {
            book = ePub(source);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            const meta  = await book.loaded.metadata;
            
            // 🧠 A CURA: O Leitor agora puxa o Título Oficial que o index.html enviou!
            const dbTitle = localStorage.getItem('currentBookTitle');
            const title = dbTitle || meta.title || fallbackTitle;

            document.getElementById('bookTitle').textContent = title;

            // Usa o ID do livro (Firestore) como chave de progresso/destaques quando disponível,
            // pra não misturar marcações de dois livros que tenham o mesmo título.
            bookKey = localStorage.getItem('currentBookId') || title;

            if (isCloudBook && bookKey) {
                try {
                    const snap = await getDoc(doc(db, 'books', bookKey));
                    if (snap.exists()) { cloudBookData = snap.data(); mergeCloudHighlights(); }
                } catch (e) { console.error('Erro ao buscar progresso salvo:', e); }
                setTimeout(() => { canSaveProgress = true; }, 60000);
            }

            const readMode   = localStorage.getItem(READ_MODE_KEY) || 'paginated';
            const savedTheme = localStorage.getItem(THEME_KEY) || 'sepia';

            if (readMode === 'scroll') {
                await loadScrollMode(bookKey, savedTheme);
            } else {
                await loadPagedMode(bookKey, savedTheme);
            }
        }

        // ── CARREGAR PDF ── source: URL (string) ou ArrayBuffer (cópia offline) ─────────
        async function loadPdf(source) {
            document.getElementById('viewer').style.display = 'none';
            document.getElementById('scroll-viewer').classList.remove('active');
            document.getElementById('pdf-viewer').style.display = 'flex';
            document.getElementById('pdf-canvas').style.display = 'none';
            document.getElementById('pdf-loading').classList.add('active');
            document.getElementById('bookTitle').textContent = "Carregando PDF...";

            try {
                const pdfSrc = (typeof source === 'string') ? source : { data: source };
                pdfDoc = await pdfjsLib.getDocument(pdfSrc).promise;

                // 🧠 O PDF TAMBÉM USA O TÍTULO OFICIAL AGORA
                const dbTitle = localStorage.getItem('currentBookTitle');
                const title = dbTitle || "Leitura em PDF";

                document.getElementById('bookTitle').textContent = title;
                bookKey = localStorage.getItem('currentBookId') || title;

                if (isCloudBook && bookKey) {
                    try {
                        const snap = await getDoc(doc(db, 'books', bookKey));
                        if (snap.exists()) cloudBookData = snap.data();
                    } catch (e) { console.error('Erro ao buscar progresso salvo:', e); }
                    setTimeout(() => { canSaveProgress = true; }, 60000);
                }

                const savedPos = cloudBookData?.position ?? localStorage.getItem(`pos_${bookKey}`);
                pageNum = (savedPos && !isNaN(savedPos)) ? parseInt(savedPos) : 1;

                renderPdfPage(pageNum);
            } catch (err) {
                console.error("Erro ao carregar PDF:", err);
                showReaderError(err);
            }
        }

function renderPdfPage(num) {
            pageIsRendering = true;
            pdfDoc.getPage(num).then(page => {
                const canvas = document.getElementById('pdf-canvas');
                const ctx = canvas.getContext('2d');
                
                const containerWidth = document.getElementById('reader-container').clientWidth;
                const unscaledViewport = page.getViewport({ scale: 1.0 });
                const scale = (containerWidth / unscaledViewport.width) * 0.95; 
                const viewport = page.getViewport({ scale: Math.max(scale, 0.7) }); 
                
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                
                page.render({ canvasContext: ctx, viewport: viewport }).promise.then(() => {
                    pageIsRendering = false;
                    document.getElementById('pdf-loading').classList.remove('active');
                    canvas.style.display = '';
                    if (pageNumIsPending !== null) {
                        renderPdfPage(pageNumIsPending);
                        pageNumIsPending = null;
                    }
                });
                
                // Atualiza progresso
                document.getElementById('pageCounter').textContent = `PÁG ${num} / ${pdfDoc.numPages}`;
                const pct = Math.floor((num / pdfDoc.numPages) * 100);
                document.getElementById('progressBar').style.width = `${pct}%`;
                document.getElementById('progressPercent').textContent = `${pct}%`;

                saveProgress({ position: num, progress: pct / 100 });
            });
        }
        // ── MODO PÁGINAS ──────────────────────────────────────────────────────────────
        async function loadPagedMode(title, savedTheme) {
            document.getElementById('viewer').style.display           = '';
            document.getElementById('touch-zone-left').style.display  = '';
            document.getElementById('touch-zone-right').style.display = '';
            document.getElementById('page-transition').style.display  = '';
            document.getElementById('scroll-viewer').classList.remove('active');
            document.getElementById('scroll-loading').classList.remove('active');
            document.getElementById('reader-container').classList.remove('scroll-mode');
            showChrome();
            document.getElementById('prevBtn').style.visibility = '';
            document.getElementById('nextBtn').style.visibility = '';

            const { w, h } = getSize();
            rendition = book.renderTo('viewer', {
                width: w, height: h, flow: 'paginated',
                manager: 'default', spread: 'none', allowScriptedContent: true
            });

            window.addEventListener('resize', () => {
                setTimeout(() => { const { w: rw, h: rh } = getSize(); rendition.resize(rw, rh); }, 150);
            });

            applyTheme(savedTheme, true);
            document.getElementById('themeDropdown').value = savedTheme;
            registerHooks();

            const savedPos = cloudBookData?.position ?? localStorage.getItem(`pos_${title}`);
            await rendition.display(savedPos || undefined);

            // Salva posição e porcentagem no Firestore a cada troca de página
            rendition.on('relocated', (location) => {
                const fields = { position: location.start.cfi };
                try {
                    const percentage = book.locations.percentageFromCfi(location.start.cfi);
                    if (percentage !== null && percentage >= 0) fields.progress = percentage;
                } catch (e) {}
                saveProgress(fields);
            });

            document.getElementById('prevBtn').onclick = () => navigate('prev');
            document.getElementById('nextBtn').onclick = () => navigate('next');

            const nav  = await book.loaded.navigation;
            const drop = document.getElementById('chaptersDropdown');
            drop.innerHTML = nav.toc.map(c => `<option value="${c.href}">${c.label}</option>`).join('');
            drop.onchange  = (e) => rendition.display(e.target.value);

book.ready.then(() => {
                // Destaques não precisam do índice de localizações (só do CFI) — mostra logo
                renderAllHighlights();
                renderHighlightsList();

                book.locations.generate(512).then(() => {
                    updateUI();

                    // Garante que a porcentagem seja salva assim que o livro termina de processar!
                    const curCfi = rendition.currentLocation()?.start?.cfi;
                    if (curCfi) {
                        try {
                            const percentage = book.locations.percentageFromCfi(curCfi);
                            if (percentage !== null && percentage >= 0) saveProgress({ position: curCfi, progress: percentage });
                        } catch (e) {}
                    }
                });
            });
        }

async function loadScrollMode(title, savedTheme) {
            document.getElementById('viewer').style.display           = 'none';
            document.getElementById('touch-zone-left').style.display  = 'none';
            document.getElementById('touch-zone-right').style.display = 'none';
            document.getElementById('page-transition').style.display  = 'none';
            document.getElementById('prevBtn').style.visibility       = 'hidden';
            document.getElementById('nextBtn').style.visibility       = 'hidden';
            document.getElementById('pageCounter').textContent        = 'Carregando...';

            const container = document.getElementById('reader-container');
            const scrollEl  = document.getElementById('scroll-viewer');
            const loadingEl = document.getElementById('scroll-loading');

            container.classList.add('scroll-mode');
            showChrome();
            loadingEl.classList.add('active');
            scrollEl.classList.remove('active');
            scrollEl.innerHTML = '';

            applyScrollTheme(savedTheme);
            document.getElementById('themeDropdown').value = savedTheme;
            scrollEl.style.fontSize = `${fontSize}px`;

            await book.ready;

            const savedPct = (cloudBookData?.progress != null)
                ? cloudBookData.progress * 100
                : parseFloat(localStorage.getItem(`scroll_pos_${title}`) || '0');
            const isResuming = savedPct > 0;

            // Itera pela spine usando a API correta do epub.js, um capítulo por vez
            let chapterIndex = 0;
            let section = book.spine.first();

            async function loadOneChapter() {
                if (!section) return false;
                const currentSection = section;
                section = section.next();
                try {
                    const contents = await currentSection.load(book.load.bind(book));
                    const doc = (contents && contents.nodeType) ? contents
                              : (currentSection.document || null);

                    let html = '';
                    if (doc) {
                        const body = doc.body || doc.querySelector('body');
                        html = body ? body.innerHTML : doc.documentElement?.innerHTML || '';
                    }

                    if (html.trim()) {
                        if (chapterIndex > 0) {
                            const sep = document.createElement('hr');
                            sep.className = 'chapter-sep';
                            scrollEl.appendChild(sep);
                        }

                        const wrapper = document.createElement('div');
                        wrapper.innerHTML = html;

                        // ── RESOLVE IMAGENS via archive (mais confiável que resources) ──
                        for (const img of wrapper.querySelectorAll('img[src]')) {
                            try {
                                const src = img.getAttribute('src');
                                // Constrói path absoluto dentro do ZIP
                                const basePath = (currentSection.canonical || currentSection.href || '').replace(/[^/]*$/, '');
                                const fullPath = src.startsWith('/')
                                    ? src.slice(1)
                                    : (basePath + src).replace(/[^/]+\/\.\.\//g, '');

                                // Tenta pelo archive (acesso direto ao ZIP)
                                let blobUrl = null;
                                if (book.archive) {
                                    blobUrl = await book.archive.createUrl(fullPath, { base64: false }).catch(() => null);
                                }
                                // Fallback: resources
                                if (!blobUrl && book.resources) {
                                    blobUrl = await book.resources.createUrl(fullPath).catch(() => null);
                                }
                                if (blobUrl) img.setAttribute('src', blobUrl);
                            } catch(_) {}
                        }

                        scrollEl.appendChild(wrapper);
                        chapterIndex++;
                    }

                    currentSection.unload && currentSection.unload();
                } catch(err) {
                    console.warn('Capítulo ignorado:', currentSection.href, err);
                }
                return true;
            }

            if (isResuming) {
                // Retomando leitura: carrega o livro todo pra restaurar a % com precisão
                while (await loadOneChapter()) {}
            } else {
                // Começando do zero: carrega só o suficiente pra encher a tela e revelar rápido
                const targetHeight = (container.clientHeight || window.innerHeight) * 2;
                while (section && scrollEl.scrollHeight < targetHeight) {
                    await loadOneChapter();
                }
            }

            loadingEl.classList.remove('active');
            scrollEl.classList.add('active');

            // Continua carregando o resto do livro sob demanda, conforme o usuário se aproxima do fim
            if (section) {
                const sentinel = document.createElement('div');
                sentinel.style.height = '1px';
                scrollEl.appendChild(sentinel);
                let loadingMore = false;
                const observer = new IntersectionObserver((entries) => {
                    if (!entries[0].isIntersecting || loadingMore || !section) return;
                    loadingMore = true;
                    sentinel.remove();
                    (async () => {
                        // Carrega 2 telas de uma vez e começa bem antes de chegar no fim
                        // (rootMargin), pra rolagem nunca "bater na parede" esperando capítulo.
                        const alturaTela = container.clientHeight || window.innerHeight;
                        const targetHeight = scrollEl.scrollHeight + alturaTela * 2;
                        while (section && scrollEl.scrollHeight < targetHeight) { await loadOneChapter(); }
                        if (section) { scrollEl.appendChild(sentinel); observer.observe(sentinel); }
                        else observer.disconnect();
                        loadingMore = false;
                    })();
                }, { root: container, rootMargin: '1500px' });
                observer.observe(sentinel);
            }

            // ── RESTAURA POSIÇÃO SALVA (Firestore, com fallback pro localStorage antigo) ──
            if (savedPct > 0) {
                // Aguarda o layout estabilizar antes de rolar
                requestAnimationFrame(() => {
                    const max = container.scrollHeight - container.clientHeight;
                    container.scrollTop = Math.round((savedPct / 100) * max);
                    const pct = Math.round(savedPct);
                    document.getElementById('progressBar').style.width     = `${pct}%`;
                    document.getElementById('progressPercent').textContent = `${pct}%`;
                    document.getElementById('pageCounter').textContent     = `${pct}% lido`;
                });
            } else {
                document.getElementById('pageCounter').textContent = '↕ Rolagem';
            }

            // ── SALVA POSIÇÃO, ATUALIZA PROGRESSO E ESCONDE/MOSTRA O CHROME AO ROLAR ──
            let saveTimer = null;
            container.addEventListener('scroll', () => {
                const top = container.scrollTop;
                const max = container.scrollHeight - container.clientHeight;

                // Rolagem imersiva estilo YouVersion: some assim que sai do topo, volta no topo.
                // Fora isso, só um toque na tela revela de novo (ver listener de click abaixo).
                if (top <= 8) showChrome(); else hideChrome();

                if (max <= 0) return;
                const pct = Math.round((top / max) * 100);
                document.getElementById('progressBar').style.width     = `${pct}%`;
                document.getElementById('progressPercent').textContent = `${pct}%`;
                document.getElementById('pageCounter').textContent     = `${pct}% lido`;

                // Debounce: salva 1s após parar de rolar
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                    saveProgress({ progress: pct / 100 });
                }, 1000);
            }, { passive: true });

            // Tocar na tela (fora de uma seleção de texto) revela o chrome de novo
            container.addEventListener('click', () => {
                if (!window.getSelection().isCollapsed) return;
                tryEnterRealFullscreen();
                showChrome();
            });

            // Índice de capítulos
            const nav  = await book.loaded.navigation;
            const drop = document.getElementById('chaptersDropdown');
            drop.innerHTML = nav.toc.map(c => `<option value="${c.href}">${c.label}</option>`).join('');
            drop.onchange = () => {};
        }

        // Tema para o scroll-viewer
        function applyScrollTheme(t) {
            localStorage.setItem(THEME_KEY, t);
            const sv  = document.getElementById('scroll-viewer');
            const bgMap = { sepia: '#f4ecd8', dark: '#1a1a1a', light: '#ffffff' };
            sv.classList.remove('theme-sepia', 'theme-dark', 'theme-light');
            sv.classList.add(`theme-${t}`);
            document.getElementById('reader-container').style.backgroundColor = bgMap[t] || bgMap.sepia;
        }

        // ── NAVEGAÇÃO (modo páginas) ──────────────────────────────────────────────────
function navigate(direction) {
            // 1. Navegação exclusiva para PDF
            if (pdfDoc) {
                if (direction === 'next') {
                    if (pageNum >= pdfDoc.numPages) return;
                    pageNum++;
                } else {
                    if (pageNum <= 1) return;
                    pageNum--;
                }
                
                if (!pageIsRendering) {
                    renderPdfPage(pageNum);
                } else {
                    pageNumIsPending = pageNum;
                }
                
                // Rola pro topo ao trocar de página
                document.getElementById('pdf-viewer').scrollTop = 0;
                return;
            }

            // 2. Navegação existente para EPUB
            if (isNavigating) return;
            isNavigating = true;
            playPageFlip(direction, () => {
                direction === 'next' ? rendition.next() : rendition.prev();
                setTimeout(() => { isNavigating = false; }, 50);
            });
        }

        function playPageFlip(direction, onMidpoint) {
            const viewer     = document.getElementById('viewer');
            const transition = document.getElementById('page-transition');
            const slide      = document.getElementById('page-slide');
            const bgColor    = viewer.style.backgroundColor || '#f4ecd8';
            slide.style.background  = bgColor;
            slide.style.opacity     = '0';
            slide.style.transform   = `translateX(${direction === 'next' ? '6px' : '-6px'})`;
            transition.style.display = 'block';
            const FADE_IN = 120, FADE_OUT = 160, start = performance.now();
            let midDone = false;
            function step(now) {
                const elapsed = now - start;
                if (elapsed < FADE_IN) {
                    const p = elapsed / FADE_IN, e = 1 - Math.pow(1 - p, 2);
                    slide.style.opacity   = e.toFixed(3);
                    slide.style.transform = `translateX(${(direction === 'next' ? 6 : -6) * (1 - e)}px)`;
                    requestAnimationFrame(step);
                } else {
                    if (!midDone) {
                        midDone = true; slide.style.opacity = '1'; slide.style.transform = 'translateX(0)';
                        onMidpoint(); requestAnimationFrame(step); return;
                    }
                    const p = Math.min((elapsed - FADE_IN) / FADE_OUT, 1), e = 1 - Math.pow(1 - p, 2);
                    slide.style.opacity   = (1 - e).toFixed(3);
                    slide.style.transform = `translateX(${(direction === 'next' ? -6 : 6) * e}px)`;
                    if (p < 1) { requestAnimationFrame(step); }
                    else { transition.style.display = 'none'; slide.style.opacity = '0'; slide.style.transform = ''; }
                }
            }
            requestAnimationFrame(step);
        }

        // ── ZONAS DE TOQUE ── esquerda/direita viram página; o centro fica sempre livre
        // (sem overlay nenhum ali) pra seleção nativa de texto funcionar de verdade.
        (function setupTouch() {
            const feedback = document.getElementById('tapFeedback');
            function showFeedback(x, y) {
                feedback.style.left = x + 'px'; feedback.style.top = y + 'px';
                feedback.classList.add('show');
                setTimeout(() => feedback.classList.remove('show'), 300);
            }
            function bindZone(zone, tapDirection) {
                let tx0 = 0, ty0 = 0, t0 = 0;
                zone.addEventListener('touchstart', (e) => {
                    tx0 = e.changedTouches[0].clientX; ty0 = e.changedTouches[0].clientY; t0 = Date.now();
                }, { passive: true });
                zone.addEventListener('touchend', (e) => {
                    if (isNavigating) return;
                    const touch = e.changedTouches[0];
                    const dx = touch.clientX - tx0, dy = touch.clientY - ty0, dt = Date.now() - t0;
                    lastTouchTime = Date.now();
                    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 400) {
                        e.preventDefault(); showFeedback(touch.clientX, touch.clientY);
                        dx < 0 ? navigate('next') : navigate('prev'); return;
                    }
                    if (dt < 250 && Math.abs(dx) < 15 && Math.abs(dy) < 15) {
                        e.preventDefault(); showFeedback(touch.clientX, touch.clientY);
                        // Não revela o chrome aqui: virar página não pode reacender o cabeçalho
                        // sem parar, senão ele nunca fica escondido de verdade na tela cheia.
                        tryEnterRealFullscreen();
                        navigate(tapDirection);
                    }
                }, { passive: false });
                zone.addEventListener('click', (e) => {
                    if (Date.now() - lastTouchTime < 500) { e.stopPropagation(); e.preventDefault(); }
                }, true);
            }
            bindZone(document.getElementById('touch-zone-left'), 'prev');
            bindZone(document.getElementById('touch-zone-right'), 'next');
        })();

        // ── HOOKS DE CONTEÚDO ─────────────────────────────────────────────────────────
        function registerHooks() {
            const theme     = localStorage.getItem(THEME_KEY) || 'sepia';
            const fontColor = { sepia: '#5b4636', dark: '#e0e0e0', light: '#1a1a1a' }[theme];

            rendition.hooks.content.register((contents) => {
                function stripFontNodes(node) {
                    if (!node || !node.tagName) return;
                    const tag = node.tagName.toLowerCase();
                    if (tag === 'link' && node.rel === 'stylesheet') { node.remove(); return; }
                    if (tag === 'style') { try { if ((node.textContent || '').includes('@font-face')) node.remove(); } catch(_) { node.remove(); } }
                }
                contents.document.querySelectorAll('link[rel="stylesheet"], style').forEach(stripFontNodes);
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(stripFontNodes)))
                    .observe(contents.document.head || contents.document.documentElement, { childList: true, subtree: true });

                contents.addStylesheetRules({
                    '*':    { 'font-family': "Georgia, 'Times New Roman', serif !important" },
                    'body': {
                        'color': `${fontColor} !important`, 'font-size': `${fontSize}px !important`,
                        'line-height': '1.75 !important', 'padding': '24px 40px !important',
                        'background-color': 'transparent !important',
                        '-webkit-tap-highlight-color': 'transparent !important',
                        'font-family': "Georgia, 'Times New Roman', serif !important"
                    },
                    'a, img': { 'pointer-events': 'auto !important' },
                    '.hl-box': { 'background-color': 'rgba(229,9,20,0.25) !important', 'border-bottom': '2px solid #e50914 !important', 'cursor': 'pointer !important' }
                });
                contents.document.addEventListener('mouseup', () => handleSelection(contents));
                contents.document.addEventListener('selectionchange', () => handleSelection(contents));
                // Reforço pro toque: em alguns navegadores mobile a seleção só "assenta"
                // um instante depois do touchend, então o selectionchange sozinho pode perder.
                contents.document.addEventListener('touchend', () => setTimeout(() => handleSelection(contents), 50));

                // Tocar no meio da página (fora das zonas de virar página) revela o chrome
                // de novo enquanto em tela cheia — só quando o toque não é uma seleção de texto.
                contents.document.addEventListener('click', () => {
                    if (!contents.window.getSelection().isCollapsed) return;
                    if (document.fullscreenElement || document.webkitFullscreenElement || isCustomFS) showChrome();
                });
            });

            rendition.on('relocated', (loc) => {
                localStorage.setItem(`pos_${bookKey}`, loc.start.cfi);
                updateUI();
                // Vira a página: qualquer seleção de texto antiga não existe mais na tela,
                // então some com o estado do marcador pra não ficar "aceso" à toa.
                currentSelection = null;
                document.getElementById('bookmarkBtn').classList.remove('enabled');
                document.getElementById('bookmarkIcon').className = 'fa-solid fa-bookmark';
                document.getElementById('bookmarkBtn').style.color = '';
            });
        }

        // Tocar num trecho JÁ marcado só prepara a remoção (ícone vira "X" vermelho) —
        // não apaga na hora. A remoção de fato só acontece ao tocar no botão do cabeçalho.
        let suppressSelectionClearUntil = 0;
        function markExistingHighlight(entry) {
            currentSelection = { ...entry };
            const btn = document.getElementById('bookmarkBtn');
            const icon = document.getElementById('bookmarkIcon');
            btn.classList.add('enabled');
            icon.className = 'fa-solid fa-xmark';
            btn.style.color = '#ff4444';
            // Evita que o mouseup/selectionchange/touchend do mesmo toque (sem seleção real)
            // limpe esse estado logo em seguida.
            suppressSelectionClearUntil = Date.now() + 400;
        }

        function handleSelection(contents) {
            const sel = contents.window.getSelection();
            const btn = document.getElementById('bookmarkBtn');
            const icon = document.getElementById('bookmarkIcon');
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                const range = sel.getRangeAt(0);
                const cfi   = new ePub.CFI(range, contents.cfiBase).toString();
                const text  = sel.toString().trim();
                currentSelection = { cfi, text };
                btn.classList.add('enabled');
                showChrome(); // traz o cabeçalho de volta: é lá que fica o botão de marcar
                const hls = getHighlights();
                // Comparação por texto EXATO (não substring): evita marcar "já existe" ou
                // remover o destaque errado só porque um trecho novo contém palavras de outro.
                const ex = hls.find(h => h.cfi === cfi || h.text === text);
                if (ex) {
                    icon.className = 'fa-solid fa-xmark'; btn.style.color = '#ff4444';
                    currentSelection.cfi = ex.cfi;
                } else { icon.className = 'fa-solid fa-bookmark'; btn.style.color = '#ffeb3b'; }
            } else {
                if (Date.now() < suppressSelectionClearUntil) return;
                btn.classList.remove('enabled'); icon.className = 'fa-solid fa-bookmark';
                btn.style.color = ''; currentSelection = null;
            }
        }

        async function handleBookmark() {
            if (!currentSelection) return;
            const hls = getHighlights();
            const idx = hls.findIndex(h => h.cfi === currentSelection.cfi || h.text === currentSelection.text);
            if (idx !== -1) { removeHighlight(hls[idx].cfi); }
            else {
                const entry = { ...currentSelection };
                hls.push(entry); setHighlights(hls);
                rendition.annotations.add('highlight', entry.cfi, {}, () => { markExistingHighlight(entry); }, 'hl-box');
                syncHighlight('add', entry);
            }
            renderHighlightsList();
            document.getElementById('bookmarkBtn').classList.remove('enabled');
            document.getElementById('bookmarkIcon').className = 'fa-solid fa-bookmark';
            document.getElementById('bookmarkBtn').style.color = '';
            currentSelection = null;
        }

        window.removeHighlight = (cfi) => {
            const hls = getHighlights();
            const entry = hls.find(h => h.cfi === cfi);
            setHighlights(hls.filter(h => h.cfi !== cfi));
            rendition.annotations.remove(cfi, 'highlight');
            renderHighlightsList();
            if (entry) syncHighlight('remove', entry);
        };

        function renderHighlightsList() {
            const drop = document.getElementById('highlightsDropdown');
            const hls  = getHighlights();
            drop.innerHTML = `<option value="" disabled selected>Destaques (${hls.length})</option>`;
            hls.forEach(h => { const o = document.createElement('option'); o.value = h.cfi || ''; o.textContent = h.text.substring(0,25)+'...'; drop.appendChild(o); });
            if (hls.length > 0) { const c = document.createElement('option'); c.value = 'CLEAR_ALL'; c.textContent = 'APAGAR TODOS'; drop.appendChild(c); }
        }

        function renderAllHighlights() {
            const hls = getHighlights().filter(h => h.cfi);
            hls.forEach(h => {
                rendition.annotations.remove(h.cfi, 'highlight');
                rendition.annotations.add('highlight', h.cfi, {}, () => { markExistingHighlight(h); }, 'hl-box');
            });
        }

        document.getElementById('highlightsDropdown').onchange = async (e) => {
            if (e.target.value === 'CLEAR_ALL') {
                const ok = await showConfirm('Apagar todas as marcações?');
                if (ok) {
                    setHighlights([]);
                    if (isCloudBook && bookKey) updateDoc(doc(db, 'books', bookKey), { highlights: [] }).catch(err => console.error(err));
                    location.reload();
                }
            } else if (rendition) { rendition.display(e.target.value); }
        };

        document.getElementById('bookmarkBtn').addEventListener('click', handleBookmark);

        // ── PROGRESSO (modo páginas) ──────────────────────────────────────────────────
        window.updateUI = () => {
            if (!rendition?.location) return;
            let pct = 0, label = 'Calculando...';
            try {
                if (book.locations?.length() > 0) {
                    const cur   = book.locations.locationFromCfi(rendition.location.start.cfi);
                    const total = book.locations.length();
                    pct   = Math.floor((cur / total) * 100);
                    label = `PÁG ${cur} / ${total}`;
                }
            } catch(_) {}
            document.getElementById('pageCounter').textContent     = label;
            document.getElementById('progressBar').style.width     = `${pct}%`;
            document.getElementById('progressPercent').textContent = `${pct}%`;
        };

        // ── TEMA ─────────────────────────────────────────────────────────────────────
        window.applyTheme = async (t, init = false) => {
            localStorage.setItem(THEME_KEY, t);
            document.getElementById('viewer').style.backgroundColor =
                ({ sepia: '#f4ecd8', light: '#ffffff', dark: '#1a1a1a' })[t] || '#f4ecd8';
            if (rendition && !init) {
                const pos = rendition.currentLocation()?.start?.cfi;
                registerHooks(); if (pos) await rendition.display(pos);
                renderAllHighlights();
            }
        };

        document.getElementById('themeDropdown').onchange = (e) => {
            const isScroll = (localStorage.getItem(READ_MODE_KEY) || 'paginated') === 'scroll';
            isScroll ? applyScrollTheme(e.target.value) : applyTheme(e.target.value);
        };

        // ── FONTE ─────────────────────────────────────────────────────────────────────
        window.changeFontSize = (delta) => {
            fontSize = Math.max(12, Math.min(36, fontSize + delta));
            localStorage.setItem(FONT_KEY, fontSize);
            document.getElementById('fontSizeDisplay').textContent = `${fontSize}px`;
            const isScroll = (localStorage.getItem(READ_MODE_KEY) || 'paginated') === 'scroll';
            if (isScroll) { document.getElementById('scroll-viewer').style.fontSize = `${fontSize}px`; }
            else { rendition?.getContents().forEach(c => { c.addStylesheetRules({ 'body': { 'font-size': `${fontSize}px !important` } }); }); }
        };

        // ── TELA CHEIA ────────────────────────────────────────────────────────────────
        let isCustomFS = false;
        function pushFSState() { history.pushState({ staantFS: true }, ''); }
        window.addEventListener('popstate', () => { if (isCustomFS) exitCustomFS(); });

        // Botão físico de "voltar" do Android (dentro do APK): sai da tela cheia
        // manual/nativa primeiro, em vez de fechar o app ou voltar pra estante direto.
        if (window.Capacitor?.isNativePlatform?.()) {
            window.Capacitor.Plugins.App.addListener('backButton', ({ canGoBack }) => {
                if (isCustomFS) { exitCustomFS(); return; }
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
                    return;
                }
                if (canGoBack) window.history.back();
                else window.Capacitor.Plugins.App.exitApp();
            });
        }

        function enterCustomFS() {
            isCustomFS = true;
            const container = document.getElementById('reader-container');
            hideChrome();
            container.style.position = 'fixed'; container.style.inset = '0';
            container.style.top = '0'; container.style.left = '0';
            container.style.right = '0'; container.style.bottom = '0';
            container.style.height = '100%'; container.style.width = '100%'; container.style.zIndex = '9999';
            document.getElementById('fullscreenIcon').className = 'fa-solid fa-compress';
            pushFSState();
            setTimeout(() => { if (rendition) { const { w, h } = getSize(); rendition.resize(w, h); } }, 350);
        }

        function exitCustomFS() {
            if (!isCustomFS) return;
            isCustomFS = false;
            const container = document.getElementById('reader-container');
            showChrome();
            container.style.position = 'fixed'; container.style.inset = '';
            container.style.top = '112px'; container.style.left = '0';
            container.style.right = ''; container.style.bottom = '';
            container.style.height = 'calc(100vh - 112px)';
            container.style.width = '100%'; container.style.zIndex = '';
            document.getElementById('fullscreenIcon').className = 'fa-solid fa-expand';
            setTimeout(() => { if (rendition) { const { w, h } = getSize(); rendition.resize(w, h); } }, 350);
        }

        // Toque em qualquer lugar (fora de seleção de texto), enquanto em tela cheia, revela o chrome de novo
        document.getElementById('reader-container').addEventListener('click', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement && !isCustomFS) return;
            if (!window.getSelection().isCollapsed) return;
            showChrome();
        });

        // Sempre tenta a Fullscreen API de verdade primeiro — no Android ela some com a
        // barra do sistema (hora/rede/bateria) também, não só com a barra do navegador.
        // O modo manual (isCustomFS) fica só como reserva pra navegadores sem suporte
        // (ex: Safari no iOS não implementa Fullscreen API pra elementos comuns).
        // Pede a Fullscreen API de verdade — só funciona se chamada de dentro de um gesto
        // real do usuário (toque/clique), é uma restrição de segurança do navegador.
        // Por isso é chamada tanto no botão quanto nos toques de virar página/tocar na tela.
        function tryEnterRealFullscreen() {
            if (document.fullscreenElement || document.webkitFullscreenElement || isCustomFS) return;
            if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) return;
            const req = document.documentElement.requestFullscreen
                ? document.documentElement.requestFullscreen({ navigationUI: 'hide' })
                : document.documentElement.webkitRequestFullscreen && document.documentElement.webkitRequestFullscreen();
            if (req && req.catch) req.catch(() => {});
        }

        document.getElementById('fullscreenBtn').onclick = () => {
            const canNativeFS = document.fullscreenEnabled || document.webkitFullscreenEnabled;
            if (canNativeFS) {
                const isActive = document.fullscreenElement || document.webkitFullscreenElement;
                if (!isActive) {
                    const req = document.documentElement.requestFullscreen
                        ? document.documentElement.requestFullscreen({ navigationUI: 'hide' })
                        : document.documentElement.webkitRequestFullscreen();
                    Promise.resolve(req).catch(() => enterCustomFS());
                } else if (document.exitFullscreen) {
                    document.exitFullscreen().catch(() => {});
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            } else {
                isCustomFS ? exitCustomFS() : enterCustomFS();
            }
        };

        document.addEventListener('fullscreenchange', () => {
            document.getElementById('fullscreenIcon').className = document.fullscreenElement ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
            document.fullscreenElement ? hideChrome() : showChrome();
            setTimeout(() => { if (rendition) { const { w, h } = getSize(); rendition.resize(w, h); } }, 350);
        });
        document.addEventListener('webkitfullscreenchange', () => {
            document.getElementById('fullscreenIcon').className = document.webkitFullscreenElement ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
            document.webkitFullscreenElement ? hideChrome() : showChrome();
            setTimeout(() => { if (rendition) { const { w, h } = getSize(); rendition.resize(w, h); } }, 350);
        });
