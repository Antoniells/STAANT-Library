        import { auth } from '../firebase-config.js';
        import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

        const forgotForm = document.getElementById('forgotForm');
        const btnRecover = document.getElementById('btnRecover');
        const messageArea = document.getElementById('messageArea');

        function showMessage(text, type = 'error') {
            messageArea.textContent = text;
            messageArea.className = type === 'error' ? 'error-msg' : 'success-msg';
            messageArea.style.display = 'block';
        }

        forgotForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value.trim();

            messageArea.style.display = 'none';
            btnRecover.disabled = true;
            btnRecover.textContent = "Enviando...";

            try {
                // Lógica de Pente Fino: Envio de e-mail de recuperação
                await sendPasswordResetEmail(auth, email);
                
                showMessage("Link enviado! Verifique sua caixa de entrada (e o spam).", "success");
                btnRecover.textContent = "E-mail Enviado";

            } catch (error) {
                console.error("Erro ao recuperar:", error.code);
                btnRecover.disabled = false;
                btnRecover.textContent = "Enviar link de recuperação";

                let msg = "Erro ao processar solicitação.";
                if (error.code === 'auth/user-not-found') msg = "Este e-mail não está cadastrado.";
                if (error.code === 'auth/invalid-email') msg = "E-mail em formato inválido.";
                
                showMessage(msg, "error");
            }
        });
