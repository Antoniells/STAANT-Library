        import { auth, db } from '../firebase-config.js';
        import { supabase } from '../supabase-config.js';
        import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
        import { collection, addDoc, getDocs, query, where, orderBy, deleteDoc, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
        import { saveBookOffline, getOfflineBook, removeOfflineBook, listOfflineBookIds } from '../offline-books.js';
        import { minutesToday, currentStreak, totalMinutes, lastDays, formatMinutes } from '../reading-stats.js';
        import { applyOrder, saveOrder, enableReordering } from './book-reorder.js';

        let currentCoverBase64 = null;
        let currentEpubArrayBuffer = null;

        // ─── ESTATÍSTICAS DE LEITURA (Home) ────────────────────────────────────────
        function renderReadingStats() {
            const total = totalMinutes();
            const section = document.getElementById('statsSection');
            // Só aparece depois que existir algum histórico — evita um painel de zeros
            if (total === 0) { section.style.display = 'none'; return; }
            section.style.display = 'block';

            document.getElementById('statToday').textContent  = formatMinutes(minutesToday());
            document.getElementById('statStreak').textContent = currentStreak();
            document.getElementById('statTotal').textContent  = formatMinutes(total);

            const dias = lastDays(7);
            const maxMin = Math.max(...dias.map(d => d.minutes), 1);
            const nomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            const hoje = dias[dias.length - 1].date;

            document.getElementById('weekChart').innerHTML = dias.map(d => {
                const altura = d.minutes > 0 ? Math.max(6, Math.round((d.minutes / maxMin) * 100)) : 3;
                // 'T12:00' evita que o fuso empurre a data pro dia anterior
                const nome = nomes[new Date(`${d.date}T12:00`).getDay()];
                return `
                    <div class="week-bar-wrap" title="${formatMinutes(d.minutes)}">
                        <div class="week-bar${d.minutes === 0 ? ' empty' : ''}" style="height:${altura}%;"></div>
                        <span class="week-day${d.date === hoje ? ' today' : ''}">${nome}</span>
                    </div>`;
            }).join('');
        }

        // Evita que o app fique girando pra sempre se o proxy da Vercel travar/cair
        function fetchWithTimeout(url, ms = 12000) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ms);
            return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
        }

        const MAX_BOOKS = 10;
        // Chave restrita à Books API e ao domínio da STAANT (ver console.cloud.google.com),
        // carregada de google-books-key.js — esse arquivo não entra no Git de propósito
        // (fica só no deploy do Firebase), pra chave nunca aparecer no histórico do repositório.
        const GOOGLE_BOOKS_API_KEY = window.GOOGLE_BOOKS_API_KEY || '';

        // ─── ENRIQUECER DADOS DO LIVRO (Google Books) ──────────────────────────────
        // Completa o que falta: sinopse, capa, autor, ano, páginas e gênero.
        window.buscarInfoGoogleBooks = async (titulo, autor) => {
            if (!titulo || !navigator.onLine) return null;

            // Remove sufixos tipo "(Versão original)", "(edição especial)" etc. que vêm
            // de resultados de busca de bibliotecas externas e só atrapalham o match.
            const tituloLimpo = titulo.replace(/\s*\([^)]*\)\s*$/, '').trim() || titulo;

            // Cada termo é codificado separadamente: o "+" entre eles precisa chegar
            // como separador, não como caractere literal (%2B), senão a busca falha.
            const partes = [`intitle:${encodeURIComponent(tituloLimpo)}`];
            if (autor && autor !== 'Desconhecido') partes.push(`inauthor:${encodeURIComponent(autor)}`);

            try {
                const chave = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : '';
                const url = `https://www.googleapis.com/books/v1/volumes?q=${partes.join('+')}&maxResults=5${chave}`;
                const res = await fetchWithTimeout(url, 8000);
                if (!res.ok) { console.warn('Google Books indisponível:', res.status); return null; }
                const data = await res.json();
                if (data.error || !data.items || !data.items.length) return null;

                // Prefere um resultado que tenha sinopse; senão fica com o primeiro
                const item = data.items.find(i => i.volumeInfo?.description) || data.items[0];
                const v = item.volumeInfo || {};
                const capa = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';

                return {
                    description: (v.description || '').replace(/<[^>]*>?/gm, ''),
                    cover: capa.replace('http:', 'https:'),
                    author: v.authors ? v.authors.join(', ') : '',
                    publishedDate: v.publishedDate || '',
                    pageCount: v.pageCount || null,
                    categories: v.categories || [],
                };
            } catch (e) {
                console.warn('Não foi possível buscar dados no Google Books:', e);
                return null;
            }
        };

        // ─── TOAST / CONFIRM (substitui alert/confirm nativos) ──────────────────────
        window.showToast = (message, type = 'error', duration = 4000) => {
            const container = document.getElementById('toastContainer');
            const el = document.createElement('div');
            el.className = `toast ${type}`;
            el.textContent = message;
            container.appendChild(el);
            requestAnimationFrame(() => el.classList.add('show'));
            setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
        };

        window.showConfirm = (message) => new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            document.getElementById('confirmMessage').textContent = message;
            modal.style.display = 'flex';
            const cleanup = (result) => { modal.style.display = 'none'; resolve(result); };
            document.getElementById('confirmOkBtn').onclick = () => cleanup(true);
            document.getElementById('confirmCancelBtn').onclick = () => cleanup(false);
        });

        // ─── SIDEBAR ──────────────────────────────────────────────────────────────
        window.toggleSidebar = () => {
            const side = document.getElementById('sidebar');
            side.classList.toggle('active');
            const overlay = document.getElementById('sidebarOverlay');
            overlay.style.display = side.classList.contains('active') ? 'block' : 'none';
        };
        // ─── NAVEGAÇÃO SPA (Alternar Telas) ───
        window.switchView = (view) => {
            if (view === 'home') {
                document.getElementById('homeView').style.display = 'block';
                document.getElementById('librarySection').style.display = 'none';
            } else if (view === 'library') {
                document.getElementById('homeView').style.display = 'none';
                document.getElementById('librarySection').style.display = 'block';
                renderReadingStats();
                // Garante que a estante esteja atualizada ao abrir
                renderList();
            }
            if (document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
        };
        // ─── BUSCA MOBILE ─────────────────────────────────────────────────────────
        window.toggleSearchMobile = () => {
            document.getElementById('mobileSearchRow').classList.toggle('active');
        };

        // Clicou fora da barra (e fora do botão que a abre)? Fecha.
        document.addEventListener('click', (e) => {
            const row = document.getElementById('mobileSearchRow');
            if (!row.classList.contains('active')) return;
            if (row.contains(e.target) || e.target.closest('[onclick="toggleSearchMobile()"]')) return;
            row.classList.remove('active');
        });

        // ─── MODAIS ───────────────────────────────────────────────────────────────
        window.openAddModal = () => {
            if (document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
            document.getElementById('addBookModal').style.display = 'flex';
        };

        window.closeModal = () => {
            document.getElementById('addBookModal').style.display = 'none';
            document.getElementById('bookForm').reset();
            currentEpubArrayBuffer = null;
            currentCoverBase64 = null;
            document.getElementById('epubFileStatus').textContent = "Clique para selecionar arquivo .epub";
        };

        window.closeDescriptionModal = () => {
            document.getElementById('descriptionModal').style.display = 'none';
        };

        // ─── CONFIGURAÇÕES (FIX: função única, sem duplicata) ─────────────────────
        window.openSettingsModal = () => {
            if (document.getElementById('sidebar').classList.contains('active')) toggleSidebar();

            const user = JSON.parse(localStorage.getItem('staant_user'));
            if (user) {
                document.getElementById('profile-name').textContent = user.name || "Usuário";
                document.getElementById('profile-email').textContent = user.email || "E-mail não encontrado";
            }

            // Destaca o tema já salvo
            const savedTheme = localStorage.getItem('staant_theme') || 'dark';
            document.querySelectorAll('.theme-sub-btn').forEach(btn => {
                btn.classList.toggle('selected', btn.dataset.theme === savedTheme);
            });

            // Destaca o modo de leitura já salvo
            const savedMode = localStorage.getItem('staant_read_mode') || 'paginated';
            document.querySelectorAll('.read-mode-btn').forEach(btn => {
                btn.classList.toggle('selected', btn.dataset.mode === savedMode);
            });

            document.getElementById('settingsModal').style.display = 'flex';
        };

        // FIX: função única, sem acessar classList de elementos inexistentes
        window.closeSettingsModal = () => {
            document.getElementById('settingsModal').style.display = 'none';
            // Fecha submenus abertos para a próxima vez que abrir
            ['profile-info', 'theme-options', 'reading-options'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.maxHeight = '0px';
            });
            const profileArrow = document.getElementById('profile-arrow');
            const themeArrow = document.getElementById('theme-arrow');
            const readingArrow = document.getElementById('reading-arrow');
            if (profileArrow) profileArrow.style.transform = 'rotate(0deg)';
            if (themeArrow) themeArrow.style.transform = 'rotate(0deg)';
            if (readingArrow) readingArrow.style.transform = 'rotate(0deg)';
        };

        window.toggleSubMenu = (id) => {
            const menu = document.getElementById(id);
            const arrowMap = { 'profile-info': 'profile-arrow', 'theme-options': 'theme-arrow', 'reading-options': 'reading-arrow' };
            const arrow = document.getElementById(arrowMap[id]);
            const isOpen = menu.style.maxHeight && menu.style.maxHeight !== '0px';
            if (isOpen) {
                menu.style.maxHeight = '0px';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
            } else {
                menu.style.maxHeight = menu.scrollHeight + 'px';
                if (arrow) arrow.style.transform = 'rotate(90deg)';
            }
        };

        // FIX: recebe botão como argumento em vez de usar event.currentTarget
        window.applyTheme = (theme, btnEl) => {
            localStorage.setItem('staant_theme', theme);
            document.querySelectorAll('.theme-sub-btn').forEach(btn => btn.classList.remove('selected'));
            if (btnEl) btnEl.classList.add('selected');
        };

        window.applyReadMode = (mode, btnEl) => {
            localStorage.setItem('staant_read_mode', mode);
            document.querySelectorAll('.read-mode-btn').forEach(btn => btn.classList.remove('selected'));
            if (btnEl) btnEl.classList.add('selected');
        };

        // ─── LOGOUT ───────────────────────────────────────────────────────────────
        window.logout = async () => {
            await signOut(auth);
            localStorage.clear();
            window.location.href = 'login.html';
        };

        // ─── AUTENTICAÇÃO ─────────────────────────────────────────────────────────
// ─── AUTENTICAÇÃO ───
        onAuthStateChanged(auth, async (user) => {
            if (!user) {
                window.location.href = 'login.html';
                return;
            }

            try {
                // Busca os dados atualizados direto do servidor
                const userDoc = await getDoc(doc(db, "users", user.uid));
                
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    
                    // Atualiza a mensagem de boas-vindas
                    document.getElementById('userWelcome').innerHTML = `Olá, <b>${userData.name.split(' ')[0]}</b>`;
                    
                    // Se for admin no servidor, mostra os botões!
                    if (userData.role === 'admin') {
                        document.getElementById('adminPanelBtn').style.display = 'block';
                        document.getElementById('adminSidebarBtn').style.display = 'flex';
                    }
                    
                    // Atualiza o cache local por precaução
                    const localUser = JSON.parse(localStorage.getItem('staant_user')) || {};
                    localUser.role = userData.role;
                    localStorage.setItem('staant_user', JSON.stringify(localUser));

                    const userPreferences = (userData.preferences && userData.preferences.length > 0) 
                        ? userData.preferences 
                        : ['fiction', 'romance', 'adventure', 'history']; 
                        
                    carregarRecomendacoes(userPreferences);
                }
} catch (error) {
                console.error("Erro ao buscar dados do perfil:", error);
            }

            // 🧠 NOVO: Checa se o usuário tem o ticket de retorno do leitor
            if (localStorage.getItem('staant_return_view') === 'library') {
                switchView('library');
                localStorage.removeItem('staant_return_view'); // Rasga o ticket após usar
            } else {
                switchView('home'); // Se não tiver ticket, mostra o Início normalmente
            }

            renderList();
        });

        // ─── RENDERIZAR (NUVEM) ───────────────────────────────────────────────────
        // ─── CACHE LOCAL DE LIVROS ──────────────────────────────────────────────
        function booksCacheKey(uid) { return `staant_books_cache_${uid}`; }
        function saveBooksCache(uid, books) {
            try { localStorage.setItem(booksCacheKey(uid), JSON.stringify(books)); } catch(_) {}
        }
        function loadBooksCache(uid) {
            try { return JSON.parse(localStorage.getItem(booksCacheKey(uid)) || 'null'); } catch(_) { return null; }
        }
        async function renderBooks(books, filter = '') {
            const bookList = document.getElementById('bookList');
            bookList.innerHTML = '';
            const term = filter.toLowerCase();
            let firstBook = null;
            const offlineIds = await listOfflineBookIds().catch(() => new Set());

            // Respeita a ordem que o usuário montou arrastando os cards
            const usuario = JSON.parse(localStorage.getItem('staant_user')) || {};
            const ordenados = usuario.id ? applyOrder(books, usuario.id) : books;

            ordenados.forEach(book => {
                if (!term || book.title.toLowerCase().includes(term) || book.author.toLowerCase().includes(term)) {
                    if (!firstBook) firstBook = book;
                    bookList.appendChild(createCard(book, offlineIds));
                }
            });

            // Arrastar pra reordenar só faz sentido na estante inteira, não num filtro
            if (usuario.id && !term) {
                enableReordering(bookList, (ids) => saveOrder(usuario.id, ids));
            }

            // "Continuar lendo": destaca o livro aberto mais recentemente; se nenhum
            // foi lido ainda, cai pro primeiro da estante (comportamento antigo).
            const emLeitura = books
                .filter(b => b.lastReadAt)
                .sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
            updateHero(emLeitura || firstBook, !!emLeitura);

            const currentUser = JSON.parse(localStorage.getItem('staant_user')) || {};
            const collectionTitleEl = document.getElementById('collectionTitle');
            if (collectionTitleEl) {
                collectionTitleEl.textContent = currentUser.role === 'admin'
                    ? 'Sua Estante'
                    : `Sua Estante (${books.length}/${MAX_BOOKS})`;
            }

            document.getElementById('loadingOverlay').classList.add('hidden');
        }

        function showLoadError() {
            document.getElementById('featuredTitle').textContent = navigator.onLine
                ? "Não foi possível carregar sua biblioteca"
                : "Você está offline";
            document.getElementById('featuredAuthor').textContent = "";
            document.getElementById('featuredSummary').textContent = navigator.onLine
                ? "Verifique sua conexão com a internet e tente novamente."
                : "Sem conexão e ainda sem nenhum livro baixado neste dispositivo. Conecte-se pelo menos uma vez para ver sua estante.";
            document.getElementById('readFeaturedBtn').style.display = "none";
            document.getElementById('addFeaturedBtn').style.display = "none";
            document.getElementById('loadingOverlay').classList.add('hidden');
        }

        // Mostra cache imediatamente, depois sincroniza com Firestore em background
        window.renderList = async (filter = '') => {
            const currentUser = JSON.parse(localStorage.getItem('staant_user'));
            if (!currentUser) return;

            // 1. Renderiza cache local imediatamente (zero latência)
            const cached = loadBooksCache(currentUser.id);
            if (cached && cached.length > 0) renderBooks(cached, filter);

            // 2. Busca Firestore em background
            try {
                const booksRef = collection(db, "books");
                let q;
                if (currentUser.role === 'admin') {
                    q = query(booksRef, orderBy("timestamp", "desc"));
                } else {
                    q = query(booksRef, where("userId", "==", currentUser.id), orderBy("timestamp", "desc"));
                }
                const querySnapshot = await getDocs(q);
                const books = [];
                querySnapshot.forEach((docSnap) => {
                    books.push({ id: docSnap.id, ...docSnap.data() });
                });

                // Só re-renderiza se os dados mudaram (evita flash desnecessário)
                const cachedIds = JSON.stringify((cached || []).map(b => b.id).sort());
                const freshIds  = JSON.stringify(books.map(b => b.id).sort());
                if (cachedIds !== freshIds || !cached) {
                    saveBooksCache(currentUser.id, books);
                    renderBooks(books, filter);
                } else {
                    document.getElementById('loadingOverlay').classList.add('hidden');
                }
            } catch (error) {
                console.error("Erro ao carregar:", error);
                if (!cached || cached.length === 0) showLoadError();
                else document.getElementById('loadingOverlay').classList.add('hidden');
            }
        };

function createCard(book, offlineIds) {
            const div = document.createElement('div');
            div.className = 'book-card-modern';
            div.dataset.bookId = book.id; // usado ao reordenar arrastando

            // Progresso agora vem do Firestore (sincroniza entre dispositivos)
            const progress = book.progress;
            const perc = (typeof progress === 'number' && progress > 0)
                ? Math.max(1, Math.round(progress * 100)) : 0;

            const progressBarHtml = perc > 0 ? `
                <div class="cover-progress">
                    <div class="cover-progress-fill" style="width:${perc}%"></div>
                </div>` : '';

            const safeTitle = book.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const isOffline = !!(offlineIds && offlineIds.has(book.id));
            const offlineBadgeHtml = `
                <button class="offline-badge${isOffline ? ' saved' : ''}"
                        onclick="event.stopPropagation(); toggleOfflineDownload('${book.id}', '${book.epubUrl}', '${book.fileType || 'epub'}', this)"
                        title="${isOffline ? 'Disponível offline — toque para remover' : 'Baixar para leitura offline'}"
                        aria-label="${isOffline ? 'Disponível offline, toque para remover' : 'Baixar para leitura offline'}">
                    <i class="fa-solid ${isOffline ? 'fa-circle-check' : 'fa-cloud-arrow-down'}"></i>
                </button>
            `;

            // Legenda embaixo da capa: progresso quando existe, senão o autor
            const legenda = perc > 0
                ? `<p class="book-progress">${perc}% concluídos</p>`
                : `<p class="book-author">${book.author}</p>`;

            div.innerHTML = `
                <div class="book-cover" style="background-image: url('${book.cover || ''}')">
                    ${offlineBadgeHtml}
                    ${progressBarHtml}
                    <div class="cover-actions">
                        <button class="read-btn" onclick="openReader('${book.epubUrl}', '${safeTitle}', '${book.id}')">Ler</button>
                        <button class="info-btn" onclick="showInfoById('${book.id}')" aria-label="Ver detalhes de ${safeTitle}" title="Detalhes"><i class="fa-solid fa-info"></i></button>
                        <button class="remove-btn" onclick="deleteBookCloud('${book.id}', '${book.storagePath}')" aria-label="Excluir ${safeTitle}" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div class="book-meta">
                    <p class="book-title" title="${safeTitle}">${book.title}</p>
                    ${legenda}
                </div>
            `;
            return div;
        }

window.openReader = (url, title, id) => {
            localStorage.setItem('currentEpubUrl', url);
            if (title) localStorage.setItem('currentBookTitle', title); // O Leitor agora sabe o nome real!
            if (id) localStorage.setItem('currentBookId', id); else localStorage.removeItem('currentBookId');
            localStorage.setItem('staant_return_view', 'library');
            window.location.href = 'reader.html';
        };

        window.deleteBookCloud = async (id, path) => {
            const ok = await showConfirm("Excluir permanentemente da nuvem?");
            if (ok) {
                try {
                    if (path) await supabase.storage.from('biblioteca').remove([path]);
                    await deleteDoc(doc(db, "books", id));
                    await removeOfflineBook(id).catch(() => {});
                    renderList();
                    showToast("Livro excluído.", "success");
                } catch (e) { console.error(e); showToast("Não foi possível excluir o livro."); }
            }
        };

        // ─── DOWNLOAD OFFLINE (o "cofre forte" em IndexedDB) ───────────────────────
        window.toggleOfflineDownload = async (id, epubUrl, fileType, btnEl) => {
            const existing = await getOfflineBook(id).catch(() => null);

            if (existing) {
                const ok = await showConfirm("Remover a cópia offline deste livro? Ele continua na nuvem, só deixa de estar disponível sem internet.");
                if (!ok) return;
                await removeOfflineBook(id);
                showToast("Cópia offline removida.", "success");
                renderList();
                return;
            }

            if (!navigator.onLine) {
                showToast("Você está offline. Conecte-se para baixar este livro.", "error");
                return;
            }

            const originalHtml = btnEl.innerHTML;
            btnEl.disabled = true;
            btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                const res = await fetch(epubUrl);
                if (!res.ok) throw new Error(`Falha ao baixar (${res.status})`);
                const blob = await res.blob();
                await saveBookOffline(id, blob, { fileType });
                showToast("Livro salvo para leitura offline.", "success");
                renderList();
            } catch (e) {
                console.error(e);
                showToast("Não foi possível baixar este livro para offline.");
                btnEl.disabled = false;
                btnEl.innerHTML = originalHtml;
            }
        };

        // ─── 2. O NOVO SHOW INFO (Usa apenas o ID, não quebra mais o HTML) ───
        window.showInfoById = (id) => {
            const currentUser = JSON.parse(localStorage.getItem('staant_user'));
            const cachedBooks = (currentUser ? loadBooksCache(currentUser.id) : null) || [];
            const book = cachedBooks.find(b => b.id === id);
            if(!book) return;
            
            document.getElementById('descTitle').textContent = book.title;
            document.getElementById('descAuthor').textContent = book.author;
            document.getElementById('descDescription').textContent = book.description;
            document.getElementById('descCover').src = book.cover || '';

            // Etiquetas com os dados extras (ano, páginas, gênero, progresso)
            const etiquetas = [];
            if (book.publishedDate) etiquetas.push(String(book.publishedDate).substring(0, 4));
            if (book.pageCount) etiquetas.push(`${book.pageCount} páginas`);
            if (book.categories?.length) etiquetas.push(book.categories[0]);
            if (typeof book.progress === 'number' && book.progress > 0) {
                etiquetas.push(`${Math.round(book.progress * 100)}% lido`);
            }
            document.getElementById('descMeta').innerHTML = etiquetas
                .map(t => `<span style="background:#2d2d2d;color:#bbb;font-size:0.75rem;padding:4px 10px;border-radius:12px;">${t}</span>`)
                .join('');

            document.getElementById('descReadBtn').onclick = () => openReader(book.epubUrl, book.title, book.id);
            document.getElementById('descriptionModal').style.display = 'flex';
        };

function updateHero(book, emLeitura = false) {
            const fTitle = document.getElementById('featuredTitle');
            const fAuthor = document.getElementById('featuredAuthor');
            const fSummary = document.getElementById('featuredSummary');
            const fBtn = document.getElementById('readFeaturedBtn');
            const addBtn = document.getElementById('addFeaturedBtn');
            const fLabel = document.getElementById('featuredLabel');
            const fProgress = document.getElementById('featuredProgress');

            if (book) {
                fTitle.textContent = book.title;
                fAuthor.textContent = `por ${book.author}`;
                fSummary.textContent = book.description ? book.description.substring(0, 150) + "..." : "Sem descrição.";
                fBtn.onclick = () => openReader(book.epubUrl, book.title, book.id); // Título adicionado aqui!

                // Modo "Continuar lendo": mostra etiqueta, barra de progresso e muda o texto do botão
                const pct = (typeof book.progress === 'number' && book.progress > 0)
                    ? Math.round(book.progress * 100) : 0;
                if (emLeitura) {
                    fLabel.style.display = 'block';
                    fBtn.innerHTML = '<i class="fa-solid fa-play"></i> Continuar Lendo';
                    if (pct > 0) {
                        fProgress.style.display = 'block';
                        fProgress.innerHTML = `
                            <div style="height:4px;background:rgba(255,255,255,0.2);border-radius:2px;overflow:hidden;">
                                <div style="width:${pct}%;height:100%;background:var(--primary-red);"></div>
                            </div>
                            <span style="font-size:0.75rem;color:#aaa;display:block;margin-top:6px;">${pct}% lido</span>`;
                    } else {
                        fProgress.style.display = 'none';
                    }
                } else {
                    fLabel.style.display = 'none';
                    fProgress.style.display = 'none';
                    fBtn.innerHTML = '<i class="fa-solid fa-play"></i> Ler Agora';
                }

                fBtn.style.display = "block";
                addBtn.style.display = "none";
            } else {
                fTitle.textContent = "Sua Estante";
                fAuthor.textContent = "";
                fSummary.textContent = "Adicione um livro para começar.";
                fLabel.style.display = 'none';
                fProgress.style.display = 'none';
                fBtn.style.display = "none";
                addBtn.style.display = "block";
            }
        }

        // ─── COMPRESSÃO DE CAPA ───────────────────────────────────────────────────
        async function compressCover(base64Str) {
            if (!base64Str) return "";
            return new Promise((resolve) => {
                const img = new Image();
                img.src = base64Str;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const MAX_WIDTH = 250;
                    const scaleSize = MAX_WIDTH / img.width;
                    canvas.width = MAX_WIDTH;
                    canvas.height = img.height * scaleSize;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/webp', 0.7));
                };
                img.onerror = () => resolve("");
                setTimeout(() => resolve(""), 5000);
            });
        }

        // ─── UPLOAD ───────────────────────────────────────────────────────────────
        // ─── UPLOAD MANUAL (Com Trava de Limite de 10 Livros) ───
        document.getElementById('bookForm').onsubmit = async (e) => {
            e.preventDefault();
            if (!currentEpubArrayBuffer) return showToast("Aguarde, processando arquivo...", "info");

            const btn = document.getElementById('submitBookBtn');
            btn.disabled = true;
            btn.textContent = "Verificando espaço...";

            const user = JSON.parse(localStorage.getItem('staant_user'));

            try {
                // 1. CHECAGEM DE LIMITE DE ESPAÇO
                const q = query(collection(db, "books"), where("userId", "==", user.id));
                const snapshot = await getDocs(q);
                
                if (snapshot.size >= MAX_BOOKS && user.role !== 'admin') {
                    showToast(`Limite de ${MAX_BOOKS} livros atingido. Exclua algum título em 'Sua Coleção' antes de adicionar outro.`, "error", 5500);
                    btn.disabled = false;
                    btn.textContent = "Adicionar";
                    return; // Interrompe o upload
                }

                btn.textContent = "Sincronizando...";

                // 2. Compressão de Capa e Preparação
                let optimizedCover = await compressCover(currentCoverBase64);
                if (optimizedCover.length > 500000) optimizedCover = "";

                const title = document.getElementById('bookTitleInput').value;
                const author = document.getElementById('bookAuthorInput').value;
                const cleanTitle = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
                const fileExt = window.currentFileType || 'epub';
                const storagePath = `${user.id}/${Date.now()}_${cleanTitle}.${fileExt}`;
                const mimeType = fileExt === 'pdf' ? 'application/pdf' : 'application/epub+zip';
                const fileBlob = new Blob([currentEpubArrayBuffer], { type: mimeType });

                // 3. Upload para o Supabase
                const { error } = await supabase.storage.from('biblioteca').upload(storagePath, fileBlob);
                if (error) throw error;
                const { data: urlData } = supabase.storage.from('biblioteca').getPublicUrl(storagePath);

                // 4. Salva no Firestore
                await addDoc(collection(db, "books"), {
                    userId: user.id,
                    title, author,
                    description: document.getElementById('bookDescriptionInput').value,
                    epubUrl: urlData.publicUrl,
                    storagePath: storagePath,
                    cover: optimizedCover,
                    fileType: fileExt,
                    fileSize: fileBlob.size,
                    timestamp: Date.now()
                });

                closeModal();
                renderList();
                
                // Opcional: Se ele salvou via Home, leva ele pra estante pra ver o livro novo
                switchView('library');
                
            } catch (err) {
                console.error(err);
                showToast("Erro ao subir para a nuvem.");
            } finally {
                btn.disabled = false;
                btn.textContent = "Adicionar";
            }
        };

    document.getElementById('epubFileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('epubFileStatus').textContent = "Processando...";
    
    // Descobre se é pdf ou epub
    const fileExt = file.name.split('.').pop().toLowerCase();
    window.currentFileType = fileExt; // Salva o tipo globalmente

    const reader = new FileReader();
    reader.onload = async (ev) => {
        currentEpubArrayBuffer = ev.target.result; // Usaremos a mesma variável para o buffer do PDF

        if (fileExt === 'epub') {
            // Lógica antiga do EPUB
            const epub = ePub(currentEpubArrayBuffer);
            const meta = await epub.loaded.metadata;
            document.getElementById('bookTitleInput').value = meta.title || "";
            document.getElementById('bookAuthorInput').value = meta.creator || "";
            document.getElementById('bookDescriptionInput').value = (meta.description || "").replace(/<[^>]*>?/gm, '');
            
            const cUrl = await epub.coverUrl();
            if (cUrl) {
                const res = await fetch(cUrl);
                const blob = await res.blob();
                const readB = new FileReader();
                readB.onloadend = () => { currentCoverBase64 = readB.result; };
                readB.readAsDataURL(blob);
            }
            document.getElementById('epubFileStatus').textContent = "EPUB Pronto!";
        } else if (fileExt === 'pdf') {
            // PDF não traz metadados: título vem do nome do arquivo, resto é preenchido na mão
            document.getElementById('bookTitleInput').value = file.name.replace(/\.pdf$/i, '');
            document.getElementById('bookAuthorInput').value = "Desconhecido";
            document.getElementById('bookDescriptionInput').value = "";
            currentCoverBase64 = "";
            document.getElementById('epubFileStatus').textContent = "PDF Pronto! (Preencha os dados)";
        }
    };
    reader.readAsArrayBuffer(file);
    };
        // Busca desktop e mobile: filtra a coleção local E busca nas bibliotecas externas
        function handleSearchInput(term) {
            if (term.trim() !== '') {
                if (document.getElementById('librarySection').style.display === 'none') {
                    document.getElementById('homeView').style.display = 'none';
                    document.getElementById('librarySection').style.display = 'block';
                }
                // Durante a busca, as estatísticas saem da frente dos resultados
                document.getElementById('statsSection').style.display = 'none';
            } else {
                // Campo de busca vazio: volta pra tela inicial
                document.getElementById('librarySection').style.display = 'none';
                document.getElementById('homeView').style.display = 'block';
            }
            renderList(term);
            scheduleExternalSearch(term);
        }
        document.getElementById('searchInput').oninput = (e) => handleSearchInput(e.target.value);
        document.getElementById('searchInputMobile').oninput = (e) => handleSearchInput(e.target.value);

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js');
        }

        // ─── BUSCA NAS BIBLIOTECAS EXTERNAS (Google Books/Internet Archive/Gutenberg) ───
        let externalSearchDebounceTimer = null;
        let externalSearchToken = 0;
        let currentExternalPage = 1;
        let currentExternalQuery = '';

        function scheduleExternalSearch(term) {
            clearTimeout(externalSearchDebounceTimer);
            const query = term.trim();
            if (query.length < 3) {
                externalSearchToken++;
                currentExternalQuery = '';
                currentExternalPage = 1;
                document.getElementById('externalResultsSection').style.display = 'none';
                document.getElementById('externalResults').innerHTML = '';
                document.getElementById('externalLoadMoreContainer').style.display = 'none';
                return;
            }
            // Ao alterar o texto, sempre recomeça da página 1
            externalSearchDebounceTimer = setTimeout(() => {
                currentExternalPage = 1;
                currentExternalQuery = query;
                searchExternalLibraries(query, 1);
            }, 500);
        }

        async function searchExternalLibraries(query, page = 1) {
            const myToken = ++externalSearchToken;
            const section = document.getElementById('externalResultsSection');
            const resultsContainer = document.getElementById('externalResults');
            const loading = document.getElementById('externalLoading');
            const loadMoreContainer = document.getElementById('externalLoadMoreContainer');
            const loadMoreBtn = document.getElementById('externalLoadMoreBtn');

            section.style.display = 'block';

            if (page === 1) {
                resultsContainer.innerHTML = '';
                loadMoreContainer.style.display = 'none';
                loading.style.display = 'block';
            } else {
                loadMoreBtn.disabled = true;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Carregando...';
            }

            if (!navigator.onLine) {
                loading.style.display = 'none';
                resultsContainer.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:#888;">Você está offline — a busca em outras bibliotecas volta quando reconectar.</p>';
                return;
            }

            try {
                const urlVercel = `https://staant-proxy.vercel.app/api/search?q=${encodeURIComponent(query)}&page=${page}`;
                const response = await fetchWithTimeout(urlVercel);
                const data = await response.json();

                if (myToken !== externalSearchToken) return;
                loading.style.display = 'none';

                if (page === 1 && (!data.results || data.results.length === 0)) {
                    resultsContainer.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:#888;">Nenhum e-book gratuito encontrado em português.</p>';
                    loadMoreContainer.style.display = 'none';
                    return;
                }

                // Renderiza os cards recebidos
                data.results.forEach(book => {
                    const card = document.createElement('div');
                    card.style.cssText = `background: #2a2a2a; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; position: relative;`;
                    const safeTitle = book.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    const safeAuthor = book.author.replace(/'/g, "\\'").replace(/"/g, '&quot;');

                    let iconTag = '';
                    if (book.source === 'Google Books') {
                        iconTag = '<i class="fa-brands fa-google"></i> Books';
                    } else if (book.source === 'Internet Archive') {
                        iconTag = '<i class="fa-solid fa-building-columns"></i> Archive';
                    } else if (book.source === 'Gutenberg') {
                        iconTag = '<i class="fa-solid fa-book-globe"></i> Guten';
                    } else {
                        iconTag = '<i class="fa-solid fa-cloud"></i> Extra';
                    }

                    card.innerHTML = `
                        <div style="position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.8); color: white; font-size: 0.6rem; padding: 3px 6px; border-radius: 4px; z-index: 10;">${iconTag}</div>
                        <div style="height: 180px; background-image: url('${book.cover}'); background-size: cover; background-position: center;"></div>
                        <div style="padding: 12px; flex-grow: 1; display: flex; flex-direction: column; justify-content: space-between;">
                            <div style="margin-bottom: 10px;">
                                <h4 style="margin: 0 0 4px 0; font-size: 0.85rem; color: white; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${book.title}</h4>
                                <p style="margin: 0; font-size: 0.75rem; color: #aaa;">${book.author}</p>
                            </div>
                            <button onclick="importGutendexBook(this, '${book.epubUrl}', '${safeTitle}', '${safeAuthor}', '${book.cover}')"
                                    style="background: var(--primary-red); color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: bold; width: 100%; transition: background 0.2s;">
                                <i class="fa-solid fa-cloud-arrow-down"></i> Salvar
                            </button>
                        </div>
                    `;
                    resultsContainer.appendChild(card);
                });

                // Se vieram livros nesta rodada, exibimos o botão para carregar a próxima página
                if (data.results && data.results.length >= 8) {
                    loadMoreContainer.style.display = 'block';
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus" style="margin-right:8px;"></i> Carregar mais livros';
                } else {
                    loadMoreContainer.style.display = 'none';
                }

            } catch (error) {
                if (myToken !== externalSearchToken) return;
                console.error("Erro na busca externa:", error);
                loading.style.display = 'none';
                loadMoreContainer.style.display = 'none';
                const msg = error.name === 'AbortError'
                    ? 'A busca demorou demais para responder. Tente novamente.'
                    : 'Erro ao buscar livros.';
                if (page === 1) {
                    resultsContainer.innerHTML = `<p style="grid-column: 1/-1; text-align:center; color:#ff4d4d;">${msg}</p>`;
                } else {
                    showToast(msg, "error");
                }
            }
        }

        // Configura o clique no botão "Carregar mais"
        document.getElementById('externalLoadMoreBtn').onclick = () => {
            currentExternalPage++;
            searchExternalLibraries(currentExternalQuery, currentExternalPage);
        };


// ─── GERADOR DE MÚLTIPLOS CARROSSÉIS (Corrigido e Unificado) ───
        window.carregarRecomendacoes = async (preferences) => {
            const containerMaster = document.getElementById('multiCarouselsContainer');
            containerMaster.innerHTML = '';

            if (!navigator.onLine) {
                containerMaster.innerHTML = '<p style="padding: 30px 20px; text-align:center; color:#888;">Você está offline. As recomendações voltam quando a conexão for restabelecida — enquanto isso, aproveite os livros da sua estante.</p>';
                return;
            }

            const genreNames = {
                'fiction': 'Ficção', 'science fiction': 'Ficção Científica', 
                'fantasy': 'Fantasia', 'romance': 'Romance', 
                'mystery': 'Mistério', 'history': 'História', 
                'adventure': 'Aventura', 'philosophy': 'Filosofia',
                'classics': 'Clássicos'
            };

            const genresToLoad = preferences.slice(0, 3);
            if (!genresToLoad.includes('classics')) genresToLoad.push('classics'); 

            // 🧠 MEMÓRIA: Guarda os títulos que já apareceram na tela!
            const titulosExibidos = new Set();

            // 1. Cria todas as seções de uma vez, na ordem certa, com o spinner
            genresToLoad.forEach(genre => {
                const translatedGenre = genreNames[genre] || genre;
                const sectionHtml = `
                    <div style="padding: 30px 20px 0 20px;">
                        <h2 style="font-size: 1.3rem; font-weight: 700; margin-bottom: 15px; border-left: 4px solid var(--primary-red); padding-left: 10px;">${translatedGenre}</h2>
                        <div id="carousel-${genre}" class="carousel-container">
                            <div style="padding: 20px; color: #888;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando ${translatedGenre}...</div>
                        </div>
                    </div>
                `;
                containerMaster.insertAdjacentHTML('beforeend', sectionHtml);
            });

            // 2. Busca todos os gêneros em PARALELO (bem mais rápido que um por um)
            await Promise.all(genresToLoad.map(async (genre) => {
                const translatedGenre = genreNames[genre] || genre;
                try {
                    let finalBooks = [];
                    
                    // 🚀 1. Uma única chamada para a Vercel, que já traz as 3 bibliotecas misturadas!
                    const resVercel = await fetchWithTimeout(`https://staant-proxy.vercel.app/api/search?q=${encodeURIComponent(translatedGenre)}&topic=true`);
                    const dataVercel = await resVercel.json();
                    
                    // Não alteramos mais o 'source', usamos exatamente o que a Vercel mandar!
                    if (dataVercel.results && dataVercel.results.length > 0) {
                        finalBooks = dataVercel.results; 
                    }

                    const carouselEl = document.getElementById(`carousel-${genre}`);
                    carouselEl.innerHTML = '';

                    let renderedCount = 0;

                    finalBooks.forEach(book => {
                        // 🛑 VERIFICAÇÃO DE REPETIÇÃO
                        if (titulosExibidos.has(book.title)) return;
                        
                        titulosExibidos.add(book.title);
                        renderedCount++;

                        const safeTitle = book.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                        const safeAuthor = book.author.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                        
                        // 🏷️ A Lógica das Três Etiquetas!
                        let iconTag = '';
                        if (book.source === 'Google Books') {
                            iconTag = '<i class="fa-brands fa-google"></i> Books';
                        } else if (book.source === 'Internet Archive') {
                            iconTag = '<i class="fa-solid fa-building-columns"></i> Archive';
                        } else if (book.source === 'Gutenberg') {
                            iconTag = '<i class="fa-solid fa-book-globe"></i> Guten';
                        } else {
                            iconTag = '<i class="fa-solid fa-cloud"></i> Extra';
                        }

                        const card = document.createElement('div');
                        card.className = 'carousel-card';
                        card.innerHTML = `
                            <div class="carousel-card-img" style="background-image: url('${book.cover}'); position: relative;">
                                <div style="position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.8); color: white; font-size: 0.6rem; padding: 3px 6px; border-radius: 4px; z-index: 10;">${iconTag}</div>
                            </div>
                            <div class="carousel-card-content">
                                <div>
                                    <p class="carousel-card-title">${book.title}</p>
                                    <p class="carousel-card-author">${book.author}</p>
                                </div>
                                <button onclick="importGutendexBook(this, '${book.epubUrl}', '${safeTitle}', '${safeAuthor}', '${book.cover}')"
                                        style="background: var(--primary-red); color: white; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; font-weight: bold; width: 100%; transition: background 0.2s;">
                                    <i class="fa-solid fa-cloud-arrow-down"></i> Salvar
                                </button>
                            </div>
                        `;
                        carouselEl.appendChild(card);
                    });

                    // Caso todos os livros dessa fileira já tivessem aparecido antes
                    if (renderedCount === 0) {
                        carouselEl.innerHTML = '<div style="color: #666; padding: 20px;">Nenhum livro novo encontrado nesta categoria.</div>';
                    }

                } catch (err) {
                    console.error("Erro ao carregar o carrossel:", err);
                    const msg = err.name === 'AbortError' ? 'O servidor demorou demais para responder.' : 'Erro ao carregar.';
                    document.getElementById(`carousel-${genre}`).innerHTML = `<div style="color: #ff4d4d; padding: 20px;">${msg}</div>`;
                }
            }));
        };
// Importação Inteligente usando o seu Backend
       // Função de importação (Com Trava de Limite de 10 Livros)
        window.importGutendexBook = async (btn, epubUrl, title, author, coverUrl) => {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando...';

            try {
                const user = JSON.parse(localStorage.getItem('staant_user'));

                const q = query(collection(db, "books"), where("userId", "==", user.id));
                const snapshot = await getDocs(q);

                // 1. CHECAGEM DE DUPLICATA (evita o mesmo clássico duas vezes na estante)
                const jaExiste = snapshot.docs.some(d => (d.data().title || '').trim().toLowerCase() === title.trim().toLowerCase());
                if (jaExiste) {
                    showToast("Este livro já está na sua estante.", "info");
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-check"></i> Já na Estante';
                    btn.style.background = "#555";
                    return;
                }

                // 2. CHECAGEM DE LIMITE DE ESPAÇO (Máximo 10 livros) — ignorada para o admin
                if (snapshot.size >= MAX_BOOKS && user.role !== 'admin') {
                    showToast(`Limite de ${MAX_BOOKS} livros atingido. Exclua algum título em 'Sua Coleção' antes de baixar outro.`, "error", 5500);
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Salvar';
                    btn.style.background = "var(--primary-red)";
                    return; // Interrompe o processo e não gasta o seu servidor!
                }

                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Baixando...';

                // 2. Chama o seu servidor proxy na Vercel
                const meuBackendUrl = `https://staant-proxy.vercel.app/api/download?url=${encodeURIComponent(epubUrl)}`;
                const response = await fetch(meuBackendUrl);
                
                if (!response.ok) throw new Error(`Erro no servidor backend da Vercel: ${response.status}`);
                
                const blob = await response.blob();
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';

                // 3. Upload invisível para o Supabase
                const cleanTitle = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
                const storagePath = `${user.id}/${Date.now()}_${cleanTitle.substring(0, 30)}.epub`;

                const { error: uploadError } = await supabase.storage.from('biblioteca').upload(storagePath, blob);
                if (uploadError) throw uploadError;
                const { data: urlData } = supabase.storage.from('biblioteca').getPublicUrl(storagePath);

                // 4. Salva no Firestore
                // Busca sinopse/ano/páginas pra não salvar só com o texto genérico
                const info = await buscarInfoGoogleBooks(title, author);
                await addDoc(collection(db, "books"), {
                    userId: user.id,
                    title: title, author: author,
                    description: info?.description || "Clássico importado digitalmente.",
                    epubUrl: urlData.publicUrl,
                    storagePath: storagePath,
                    cover: coverUrl || info?.cover || '',
                    fileType: 'epub',
                    fileSize: blob.size,
                    publishedDate: info?.publishedDate || '',
                    pageCount: info?.pageCount || null,
                    categories: info?.categories || [],
                    timestamp: Date.now()
                });

                // 5. Sucesso Visual!
                btn.style.background = "#22c55e";
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Na Estante';
                renderList(); // Atualiza a estante em background

            } catch (error) {
                btn.disabled = false;
                btn.style.background = "#3b82f6"; 
                btn.innerHTML = '<i class="fa-solid fa-download"></i> Baixar Manualmente';
                btn.onclick = () => {
                    window.open(epubUrl.replace('http://', 'https://'), '_blank');
                    openAddModal();
                };
                showToast("🔒 Este livro possui proteção na biblioteca original. Use o botão azul 'Baixar Manualmente'.", "error", 6000);
            }
        };
        // ─── INSTALAÇÃO DO PWA (Botão "Instalar Aplicativo") ───
        
        let deferredPrompt;
        const installAppBtn = document.getElementById('installAppBtn');

        // 1. O navegador avisa: "Ei, esse site pode ser instalado!"
        window.addEventListener('beforeinstallprompt', (e) => {
            // Impede o banner padrão do Google Chrome de aparecer do nada
            e.preventDefault();
            // Guarda o evento para dispararmos quando o usuário clicar no botão
            deferredPrompt = e;
            
            // Agora sim, revelamos o nosso botão verde na Sidebar
            if (installAppBtn) installAppBtn.style.display = 'flex';
        });

        // 2. O usuário clica no nosso botão
        if (installAppBtn) {
            installAppBtn.addEventListener('click', async () => {
                if (!deferredPrompt) return;
                
                // Fecha a sidebar para não ficar na frente
                if (document.getElementById('sidebar').classList.contains('active')) {
                    toggleSidebar();
                }

                // Dispara a caixinha nativa do celular (Aquele pop-up "Deseja instalar?")
                deferredPrompt.prompt();
                
                // Espera a resposta do usuário (Aceitou ou Recusou?)
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    console.log('Usuário aceitou a instalação do STAANT.');
                    installAppBtn.style.display = 'none'; // Esconde o botão
                } else {
                    console.log('Usuário recusou a instalação.');
                }
                
                // O evento só pode ser usado uma vez, então limpamos
                deferredPrompt = null;
            });
        }

        // 3. Limpeza: Se o app já foi instalado com sucesso, o botão some para sempre
        window.addEventListener('appinstalled', () => {
            if (installAppBtn) installAppBtn.style.display = 'none';
            showToast("STAANT foi instalado com sucesso!", "success");
        });

        // ─── AVISO DE INSTALAÇÃO PARA iOS (Safari) ───
        function checkIosInstallPrompt() {
            const userAgent = window.navigator.userAgent.toLowerCase();
            const isIos = /iphone|ipad|ipod/.test(userAgent);
            
            // A Apple tem uma propriedade secreta para saber se o PWA está aberto na tela inicial
            const isStandalone = ('standalone' in window.navigator) && window.navigator.standalone;
            
            // Verifica se o usuário já dispensou esse aviso antes
            const promptClosed = localStorage.getItem('staant_ios_prompt_closed');

            if (isIos && !isStandalone && !promptClosed) {
                const iosPrompt = document.getElementById('iosInstallPrompt');
                if (iosPrompt) {
                    // Espera 3 segundos após o site carregar para não ser agressivo
                    setTimeout(() => {
                        iosPrompt.style.display = 'flex';
                        // Uma animação suave subindo da base da tela
                        iosPrompt.animate([
                            { transform: 'translate(-50%, 100px)', opacity: 0 },
                            { transform: 'translate(-50%, 0)', opacity: 1 }
                        ], { duration: 400, easing: 'ease-out' });
                    }, 3000);
                }
            }
        }

        window.closeIosPrompt = () => {
            const iosPrompt = document.getElementById('iosInstallPrompt');
            if (iosPrompt) {
                iosPrompt.style.display = 'none';
                // Salva no navegador para nunca mais incomodar o usuário
                localStorage.setItem('staant_ios_prompt_closed', 'true');
            }
        };

        // Roda a checagem sempre que a Home carregar
        checkIosInstallPrompt();
