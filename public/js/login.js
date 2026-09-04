        import { auth, db } from '../firebase-config.js';
        import {
            signInWithEmailAndPassword,
            GoogleAuthProvider,
            signInWithPopup,
            signInWithRedirect,
            getRedirectResult,
            signInWithCredential,
            onAuthStateChanged
        } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

        // Safari (mac e iOS): a proteção contra rastreamento (ITP) costuma quebrar a
        // comunicação do signInWithPopup, deixando o login com Google lento ou travado.
        // Usamos signInWithRedirect só aqui — funciona de forma confiável no Safari.
        const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
        import { 
            doc, 
            getDoc, 
            setDoc, 
            updateDoc
        } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

        const loginForm = document.getElementById('loginForm');
        const btnEntrar = document.getElementById('btnEntrar');
        const btnGoogle = document.getElementById('btnGoogle');
        const messageArea = document.getElementById('messageArea');
        const captchaLabel = document.getElementById('captchaLabel');
        const captchaInput = document.getElementById('captchaInput');

        // Lógica do Captcha Simples
        let captchaResult = 0;
        function generateCaptcha() {
            const num1 = Math.floor(Math.random() * 10) + 1;
            const num2 = Math.floor(Math.random() * 10) + 1;
            captchaResult = num1 + num2;
            if (captchaLabel) captchaLabel.textContent = `Humanos: ${num1} + ${num2} =`;
            if (captchaInput) captchaInput.value = '';
        }
        generateCaptcha(); 

        function showMessage(text, type = 'error') {
            if (!messageArea) return;
            messageArea.textContent = text;
            messageArea.className = type === 'error' ? 'error-msg' : 'success-msg';
            messageArea.style.display = 'block';
        }

        // Função universal para salvar sessão
// Função universal para salvar sessão
async function salvarSessaoERedirecionar(user) {
            try {
                let role = "user";
                let name = user.displayName || user.email.split('@')[0];
                const userRef = doc(db, "users", user.uid);
                const userDoc = await getDoc(userRef);

                if (userDoc.exists()) {
                    role = userDoc.data().role;
                    name = userDoc.data().name || name;
                    // 🧠 NOVO: Atualiza a data do último acesso toda vez que logar!
                    await updateDoc(userRef, { lastLogin: Date.now() });
                } else {
                    await setDoc(userRef, {
                        uid: user.uid,
                        name: name,
                        email: user.email.toLowerCase().trim(),
                        role: "user",
                        preferences: ['fiction', 'romance', 'adventure'],
                        createdAt: Date.now(),
                        lastLogin: Date.now() // 🧠 NOVO: Grava no primeiro acesso
                    });
                }

                const userData = {
                    id: user.uid,
                    email: user.email,
                    name: name,
                    role: role
                };
                
                localStorage.setItem('staant_user', JSON.stringify(userData));
                localStorage.setItem('staant_logged', 'true');
                
                showMessage("Acesso concedido! Entrando...", "success");
                setTimeout(() => {
                    window.location.href = role === 'admin' ? 'admin.html' : 'index.html';
                }, 1200);
                
            } catch (error) {
                console.error("Erro ao configurar sessão:", error);
                showMessage("Erro ao carregar dados do usuário.", "error");
                if (typeof btnEntrar !== 'undefined' && btnEntrar) btnEntrar.disabled = false;
                if (typeof btnGoogle !== 'undefined' && btnGoogle) btnGoogle.disabled = false;
            }
        }

        // LOGIN COM E-MAIL E SENHA
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                
                if (parseInt(captchaInput.value) !== captchaResult) {
                    showMessage("Conta incorreta no desafio anti-robô. Tente novamente.");
                    generateCaptcha();
                    return;
                }

                const email = document.getElementById('email').value;
                const password = document.getElementById('password').value;

                if (messageArea) messageArea.style.display = 'none';
                if (btnEntrar) {
                    btnEntrar.disabled = true;
                    btnEntrar.textContent = "Carregando...";
                }

                try {
                    const userCredential = await signInWithEmailAndPassword(auth, email, password);
                    salvarSessaoERedirecionar(userCredential.user);
                } catch (error) {
                    if (btnEntrar) {
                        btnEntrar.disabled = false;
                        btnEntrar.textContent = "Entrar";
                    }
                    generateCaptcha(); 
                    
                    let msg = "E-mail ou senha incorretos.";
                    if (error.code === 'auth/too-many-requests') msg = "Muitas tentativas. Tente mais tarde.";
                    if (error.code === 'auth/network-request-failed') msg = "Sem conexão com a internet.";
                    showMessage(msg, "error");
                }
            });
        }

        // Voltando de um signInWithRedirect (Safari): termina o login que ficou pendente.
        // Não faz nada se a página abriu normalmente (result vem null nesse caso).
        (async () => {
            try {
                const result = await getRedirectResult(auth);
                if (result?.user) salvarSessaoERedirecionar(result.user);
            } catch (error) {
                console.error("Erro ao concluir login redirecionado:", error);
                showMessage("Erro ao fazer login com o Google.", "error");
            }
        })();

        // LOGIN COM GOOGLE
        // Dentro do APK (WebView do Capacitor), o Google bloqueia signInWithPopup
        // (erro "disallowed_useragent") — precisa do plugin nativo. No Safari, o ITP
        // costuma quebrar a comunicação do popup, então usamos redirecionamento (a
        // tela sai do site e volta — o resultado é tratado acima). Nos outros
        // navegadores, o popup continua funcionando exatamente como antes.
        if (btnGoogle) {
            btnGoogle.addEventListener('click', async () => {
                if (btnGoogle) {
                    btnGoogle.disabled = true;
                    btnGoogle.innerHTML = "Abrindo janela...";
                }
                if (messageArea) messageArea.style.display = 'none';

                const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

                try {
                    if (isNativeApp) {
                        const nativeResult = await window.Capacitor.Plugins.FirebaseAuthentication.signInWithGoogle();
                        const idToken = nativeResult?.credential?.idToken;
                        if (!idToken) throw new Error('Login nativo não retornou credencial.');
                        const credential = GoogleAuthProvider.credential(idToken);
                        const userCredential = await signInWithCredential(auth, credential);
                        salvarSessaoERedirecionar(userCredential.user);
                    } else if (isSafari) {
                        await signInWithRedirect(auth, new GoogleAuthProvider());
                        // A página vai navegar embora agora — nada mais a fazer aqui.
                    } else {
                        const provider = new GoogleAuthProvider();
                        const result = await signInWithPopup(auth, provider);
                        salvarSessaoERedirecionar(result.user);
                    }
                } catch (error) {
                    if (btnGoogle) {
                        btnGoogle.disabled = false;
                        btnGoogle.innerHTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google"> Entrar com Google`;
                    }
                    if (error.code === 'auth/popup-closed-by-user') return;
                    showMessage("Erro ao fazer login com o Google.", "error");
                    console.error("Erro Google Auth:", error);
                }
            });
        }
