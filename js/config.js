// --- 1. SERVICE WORKER 版本控管 ---
const APP_VERSION = 'ride2gether-cache-v7.29';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`)
      .then(reg => {
        reg.update();
        console.log(`[PWA] Service Worker Active (${APP_VERSION})`);
      })
      .catch(err => console.log('SW Error:', err));
  });
}

// --- 2. FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: "AIzaSyB5vPG43r4ULBFe66cYAceyE5nfFoAwSEs",
  authDomain: "gen-lang-client-0194528491.firebaseapp.com",
  projectId: "gen-lang-client-0194528491",
  storageBucket: "gen-lang-client-0194528491.firebasestorage.app",
  messagingSenderId: "658378152360",
  appId: "1:658378152360:web:bee96a2d1398e19a30659d",
  measurementId: "G-Q0F8EW0EHS"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const GAS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbztGtoktd6gONnXu5XQ_hvV9-sNy4VwPvwznQD3vZDopnaLC2Iv6VD7KB6s8cBiTr6k/exec";
