        // Redirecionamento imediato
        (function() {
            const logged = localStorage.getItem('staant_logged');
            const user   = JSON.parse(localStorage.getItem('staant_user') || 'null');
            if (logged === 'true' && user) {
                window.location.replace(user.role === 'admin' ? 'admin.html' : 'index.html');
            }
        })();
