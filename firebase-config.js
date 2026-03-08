import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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