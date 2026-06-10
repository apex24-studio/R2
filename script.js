import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBMRcV2zslPuaJF9jvFCGTpZ8h_dX1iMAM",
  authDomain: "roma-ec876.firebaseapp.com",
  projectId: "roma-ec876",
  storageBucket: "roma-ec876.firebasestorage.app",
  messagingSenderId: "726892580200",
  appId: "1:726892580200:web:cf7957da900a5ce5f51add",
  measurementId: "G-7Y6X1GX5BF"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const consolesRef = ref(db, 'consoles');

const initialConsoles = [
    { id: 1, name: "جهاز 1", type: "PS5", location: "الصالة الرئيسية", status: "available" },
    { id: 2, name: "جهاز 2", type: "PS5", location: "الصالة الرئيسية", status: "available" },
    { id: 3, name: "جهاز 3", type: "PS4", location: "الصالة الرئيسية", status: "available" },
    { id: 4, name: "VIP 1", type: "PS5", location: "غرفة VIP", status: "available" },
    { id: 5, name: "VIP 2", type: "PS5", location: "غرفة VIP", status: "available" },
    { id: 6, name: "جهاز 4", type: "PS4", location: "الصالة الرئيسية", status: "available" },
];

let globalConsoles = [];

// Seed database with initial data if it's empty
get(consolesRef).then((snapshot) => {
    if (!snapshot.exists()) {
        set(consolesRef, initialConsoles);
    }
});

// Listen for realtime changes
onValue(consolesRef, (snapshot) => {
    if (snapshot.exists()) {
        globalConsoles = snapshot.val();
        renderConsoles();
        if (window.isAdminAuthenticated && typeof window.renderAdminConsoles === 'function') {
            window.renderAdminConsoles();
        }
    }
});

function renderConsoles() {
    const container = document.getElementById('consoles-container');
    if (!container) return; // We are not on the main page

    container.innerHTML = '';
    globalConsoles.forEach(c => {
        const isPS5 = c.type === 'PS5';
        const iconClass = isPS5 ? 'fa-gamepad ps5-icon' : 'fa-gamepad ps4-icon';
        const statusClass = c.status === 'available' ? 'status-available' : 'status-busy';
        const statusText = c.status === 'available' ? 'متاح الآن' : 'مشغول';

        const card = document.createElement('div');
        card.className = 'console-card glass-panel';
        card.innerHTML = `
            <i class="fas ${iconClass} console-icon"></i>
            <h3 class="console-title">${c.name} - ${c.type}</h3>
            <p class="console-location"><i class="fas fa-map-marker-alt"></i> ${c.location}</p>
            <span class="status-badge ${statusClass}">${statusText}</span>
        `;
        container.appendChild(card);
    });
}

// Admin panel logic
window.renderAdminConsoles = function() {
    const container = document.getElementById('admin-devices-list');
    if (!container) return;

    container.innerHTML = '';
    globalConsoles.forEach((c, index) => {
        const row = document.createElement('div');
        row.className = 'device-row';
        
        const statusBadge = c.status === 'available' ? 
            '<span style="color:var(--success)">متاح</span>' : 
            '<span style="color:var(--danger)">مشغول</span>';

        row.innerHTML = `
            <div class="device-info">
                <strong>${c.name} (${c.type})</strong>
                <small class="text-muted">${c.location} - الحالة الحالية: ${statusBadge}</small>
            </div>
            <div class="controls">
                <button class="btn btn-small btn-success" data-index="${index}" data-status="available">تعيين كمتاح</button>
                <button class="btn btn-small btn-danger" data-index="${index}" data-status="busy">تعيين كمشغول</button>
            </div>
        `;
        container.appendChild(row);
    });

    // Attach event listeners safely
    const buttons = container.querySelectorAll('button');
    buttons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = e.target.getAttribute('data-index');
            const newStatus = e.target.getAttribute('data-status');
            updateStatus(index, newStatus);
        });
    });
}

function updateStatus(index, newStatus) {
    const specificConsoleRef = ref(db, 'consoles/' + index);
    const updatedConsole = { ...globalConsoles[index], status: newStatus };
    set(specificConsoleRef, updatedConsole);
}

// Handle WhatsApp Booking form
const bookingForm = document.getElementById('whatsapp-booking-form');
if (bookingForm) {
    bookingForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = document.getElementById('name').value;
        const deviceType = document.getElementById('device-type').value;
        const roomType = document.getElementById('room-type').value;
        const time = document.getElementById('time').value;
        
        const whatsappNumber = "201000000000"; 
        const message = `مرحباً روما بلاي ستيشن،%0Aأرغب في حجز جهاز:%0Aالاسم: ${name}%0Aالجهاز: ${deviceType}%0Aالمكان: ${roomType}%0Aالوقت: ${time}`;
        const url = `https://wa.me/${whatsappNumber}?text=${message}`;
        window.open(url, '_blank');
    });
}
