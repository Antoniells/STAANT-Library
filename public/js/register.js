        import { auth, db } from '../firebase-config.js';
        import { createUserWithEmailAndPassword, updateProfile, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
        import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

        const registerForm = document.getElementById('registerForm');
        const btnRegister = document.getElementById('btnRegister');
        const messageArea = document.getElementById('messageArea');

        // Lógica de seleção dos Chips
        const selectedGenres = new Set();
        document.querySelectorAll('.genre-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const topic = chip.getAttribute('data-topic');
                if (selectedGenres.has(topic)) {
                    selectedGenres.delete(topic);
                    chip.classList.remove('selected');
                } else {
                    selectedGenres.add(topic);
                    chip.classList.add('selected');
                }
            });
        });

        function showMessage(text, type = 'error') {
            messageArea.textContent = text;
            messageArea.className = type === 'error' ? 'error-msg' : 'success-msg';
            messageArea.style.display = 'block';
        }

        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            messageArea.style.display = 'none';

            if (selectedGenres.size === 0) {
                showMessage("Por favor, selecione pelo menos um gênero literário!");
                return;
            }

            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            if (password !== confirmPassword) {
                showMessage("As senhas não coincidem!");
                return;
            }

            btnRegister.disabled = true;
            btnRegister.textContent = "Processando...";

            try {
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                await updateProfile(user, { displayName: name });

                // Agora salvamos as preferências de leitura no banco de dados!
                await setDoc(doc(db, "users", user.uid), {
                    uid: user.uid,
                    name: name,
                    email: email.toLowerCase().trim(),
                    role: "user",
                    preferences: Array.from(selectedGenres), // Salva como Array ex: ['fiction', 'adventure']
                    createdAt: Date.now(),
                    lastLogin: Date.now()
                });

                await signOut(auth);
                localStorage.removeItem('staant_user');
                localStorage.removeItem('staant_logged');
                
                showMessage("Conta criada com sucesso! Redirecionando...", "success");
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 2000);

            } catch (error) {
                console.error("Erro detalhado:", error);
                btnRegister.disabled = false;
                btnRegister.textContent = "Cadastrar";
                let msg = "Erro ao cadastrar.";
                if (error.code === 'auth/email-already-in-use') msg = "Este e-mail já está sendo usado.";
                if (error.code === 'auth/weak-password') msg = "A senha deve ter pelo menos 6 caracteres.";
                if (error.code === 'auth/invalid-email') msg = "E-mail em formato inválido.";
                
                showMessage(msg, "error");
            }
        });
