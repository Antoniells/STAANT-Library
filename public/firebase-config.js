import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Cole aqui o objeto que você copiou do Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyAIry74uTbdQXIgBUw0PZbjDKR0PevRYLg",
  authDomain: "staant-library-oficial.firebaseapp.com",
  projectId: "staant-library-oficial",
  storageBucket: "staant-library-oficial.firebasestorage.app",
  messagingSenderId: "216863978788",
  appId: "1:216863978788:web:62fdf44ccdf060d173efb1"
 };

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// "Sincronização fantasma": leituras/gravações feitas offline (ex: progresso de leitura)
// ficam guardadas localmente pelo próprio SDK e sobem sozinhas pro Firebase quando a
// conexão voltar. Falha silenciosamente se já tiver outra aba aberta ou o navegador
// não suportar — o app continua funcionando, só sem esse cache extra.
//
// Pulado no Safari (mac/iOS): a implementação de IndexedDB do WebKit tem bugs
// conhecidos de travamento/lentidão ao abrir a conexão, o que deixava o app
// (login incluído) mais lento pra ficar interativo. Sem esse cache extra o
// Safari ainda funciona normalmente, só sem persistência offline de escrita.
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
if (!isSafari) {
    enableIndexedDbPersistence(db).catch((err) => {
        console.warn('Persistência offline do Firestore não habilitada:', err.code || err);
    });
}