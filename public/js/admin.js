    import { auth, db } from '../firebase-config.js';
    import { 
        collection, getDocs, doc, getDoc, deleteDoc, updateDoc, query, orderBy 
    } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
    import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

    const tbody = document.getElementById('userTableBody');
    const noUsersMsg = document.getElementById('noUsersMsg');

    // ─── TOAST / CONFIRM / PROMPT (substitui alert/confirm/prompt nativos) ─────
    function showToast(message, type = 'error', duration = 4000) {
        const container = document.getElementById('toastContainer');
        const colors = { error: 'border-red-600', success: 'border-green-500', info: 'border-blue-500' };
        const el = document.createElement('div');
        el.className = `pointer-events-auto bg-[#262626] text-white px-5 py-3 rounded-lg shadow-2xl text-sm border-l-4 ${colors[type] || colors.error} opacity-0 translate-y-2 transition-all duration-300`;
        el.textContent = message;
        container.appendChild(el);
        requestAnimationFrame(() => el.classList.remove('opacity-0', 'translate-y-2'));
        setTimeout(() => {
            el.classList.add('opacity-0', 'translate-y-2');
            setTimeout(() => el.remove(), 300);
        }, duration);
    }

    function showConfirm(message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            document.getElementById('confirmMessage').textContent = message;
            modal.classList.remove('hidden'); modal.classList.add('flex');
            const cleanup = (result) => { modal.classList.add('hidden'); modal.classList.remove('flex'); resolve(result); };
            document.getElementById('confirmOkBtn').onclick = () => cleanup(true);
            document.getElementById('confirmCancelBtn').onclick = () => cleanup(false);
        });
    }

    function showPrompt(message, defaultValue = '') {
        return new Promise((resolve) => {
            const modal = document.getElementById('promptModal');
            const input = document.getElementById('promptInput');
            document.getElementById('promptMessage').textContent = message;
            input.value = defaultValue;
            modal.classList.remove('hidden'); modal.classList.add('flex');
            setTimeout(() => input.focus(), 50);
            const cleanup = (result) => { modal.classList.add('hidden'); modal.classList.remove('flex'); resolve(result); };
            document.getElementById('promptOkBtn').onclick = () => cleanup(input.value);
            document.getElementById('promptCancelBtn').onclick = () => cleanup(null);
            input.onkeydown = (e) => {
                if (e.key === 'Enter') cleanup(input.value);
                if (e.key === 'Escape') cleanup(null);
            };
        });
    }

    // 1. Verificação de Segurança (Fronteira Inteligente)
    // Escuta o estado real do Firebase em vez de confiar apenas no localStorage
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'login.html';
            return;
        }

        try {
            // Vai no servidor e confere qual é o cargo real do usuário
            const userDoc = await getDoc(doc(db, "users", user.uid));

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                // É admin de verdade! Carrega os dados.
                loadAdminData();
            } else {
                // Tentativa de invasão ou usuário comum: expulsa!
                showToast("Acesso restrito. Você não possui privilégios de administrador.", "error", 3000);
                setTimeout(() => { window.location.href = 'index.html'; }, 1600);
            }
        } catch (error) {
            console.error("Erro ao verificar permissões:", error);
            showToast("Erro de conexão ou permissão negada.", "error", 3000);
            setTimeout(() => { window.location.href = 'index.html'; }, 1600);
        }
    });

    // 2. Carregar Usuários e Estatísticas
    async function loadAdminData() {
        if(tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center p-10 text-gray-500">Buscando dados seguros no Firebase...</td></tr>';
        
        try {
            const qUsers = query(collection(db, "users"), orderBy("name"));
            const usersSnapshot = await getDocs(qUsers);
            
            let userCount = 0;
            if(tbody) tbody.innerHTML = '';
            
            usersSnapshot.forEach((docSnap) => {
                const user = docSnap.data();
                userCount++;
                
                // Oculta o próprio admin da lista de exclusão para evitar auto-exclusão
                if (user.uid === auth.currentUser.uid) return; 

                if(tbody) {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td data-label="Nome" class="font-semibold text-gray-200">${user.name}</td>
                        <td data-label="E-mail" class="text-gray-400 font-mono text-sm email-cell">${user.email}</td>
                        <td data-label="Ações">
                            <div class="flex gap-6 sm:gap-4 justify-end sm:justify-start">
                                <button onclick="window.editUser('${user.uid}', '${user.name}')" class="text-blue-400 hover:text-blue-300 transition" aria-label="Editar ${user.name}" title="Editar">
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                                <button onclick="window.deleteUser('${user.uid}', '${user.name}')" class="text-red-500 hover:text-red-400 transition" aria-label="Excluir ${user.name}" title="Excluir">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </td>
                    `;
                    tbody.appendChild(tr);
                }
            });

            // Atualiza contadores
            const totalUsersEl = document.getElementById('totalUsers');
            if (totalUsersEl) totalUsersEl.textContent = userCount;
            if (userCount === 0 && noUsersMsg) noUsersMsg.classList.remove('hidden');

            // Contagem Global de Livros
            const booksSnapshot = await getDocs(collection(db, "books"));
            const totalBooksEl = document.getElementById('totalBooks');
            if (totalBooksEl) totalBooksEl.textContent = booksSnapshot.size;

        } catch (error) {
            console.error("Erro Admin Firestore:", error);
            // Se as Regras de Segurança bloquearem a leitura, vai cair aqui
            if(tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center text-red-500 p-10">Permissão Negada pelo Servidor.</td></tr>';
        }
    }

    // 3. Funções de Gerenciamento
    window.deleteUser = async (uid, name) => {
        const ok = await showConfirm(`Excluir permanentemente o usuário ${name}? Ele perderá acesso à biblioteca.`);
        if (ok) {
            try {
                await deleteDoc(doc(db, "users", uid));
                showToast("Usuário removido do banco com sucesso.", "success");
                loadAdminData(); // Recarrega a tabela
            } catch (error) {
                console.error(error);
                showToast("Operação bloqueada: Sem permissão no servidor.");
            }
        }
    };

    window.editUser = async (uid, currentName) => {
        const newName = await showPrompt("Editar nome do usuário:", currentName);
        if (newName && newName.trim() !== "" && newName !== currentName) {
            try {
                await updateDoc(doc(db, "users", uid), { name: newName.trim() });
                showToast("Nome atualizado.", "success");
                loadAdminData();
            } catch (error) {
                console.error(error);
                showToast("Operação bloqueada: Sem permissão no servidor.");
            }
        }
    };

    // 4. Logout
    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
        btnLogout.onclick = async () => {
            await signOut(auth);
            localStorage.clear();
            window.location.href = 'login.html';
        };
    }
