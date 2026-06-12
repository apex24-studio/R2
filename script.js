import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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
const auth = getAuth(app);
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
let globalBookings = [];
let globalTimerInterval;

// Timer Formatting
function formatTimeLeft(endTime) {
    const now = Date.now();
    const diff = endTime - now;
    if (diff <= 0) return "00:00:00";
    
    const h = Math.floor(diff / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Seed database with initial data if it's empty
get(consolesRef).then((snapshot) => {
    if (!snapshot.exists()) {
        set(consolesRef, initialConsoles);
    }
});

// Authentication State Observer
onAuthStateChanged(auth, (user) => {
    const loginSection = document.getElementById('login-section');
    const adminSection = document.getElementById('admin-section');
    const logoutBtn = document.getElementById('logout-btn');

    if (user) {
        window.isAdminAuthenticated = true;
        if (loginSection) loginSection.style.display = 'none';
        if (adminSection) adminSection.style.display = 'block';
        if (logoutBtn) logoutBtn.style.display = 'inline-block';
        
        if (typeof window.renderAdminConsoles === 'function') {
            window.renderAdminConsoles();
        }
    } else {
        window.isAdminAuthenticated = false;
        if (loginSection) loginSection.style.display = 'flex';
        if (adminSection) adminSection.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }
});

// Listen for realtime changes (for public and admin)
onValue(consolesRef, (snapshot) => {
    if (snapshot.exists()) {
        globalConsoles = snapshot.val();
        renderConsoles();
        if (window.isAdminAuthenticated && typeof window.renderAdminConsoles === 'function') {
            window.renderAdminConsoles();
        }
    }
});

// Listen for bookings
onValue(bookingsRef, (snapshot) => {
    if (snapshot.exists()) {
        const data = snapshot.val();
        globalBookings = Object.keys(data).map(key => ({ id: key, ...data[key] }));
    } else {
        globalBookings = [];
    }
    if (window.isAdminAuthenticated && typeof window.renderAdminBookings === 'function') {
        window.renderAdminBookings();
    }
});

function renderConsoles() {
    const container = document.getElementById('consoles-container');
    const specificDeviceSelect = document.getElementById('specific-device');
    
    if (specificDeviceSelect) {
        // Keep the first option
        specificDeviceSelect.innerHTML = '<option value="any">أي جهاز متاح</option>';
    }

    if (!container) return;

    container.innerHTML = '';
    globalConsoles.forEach(c => {
        if (!c) return; // safety check
        const isPS5 = c.type === 'PS5';
        const iconClass = isPS5 ? 'fa-gamepad ps5-icon' : 'fa-gamepad ps4-icon';
        const statusClass = c.status === 'available' ? 'status-available' : 'status-busy';
        const statusText = c.status === 'available' ? 'متاح الآن' : 'مشغول';

        const timerDisplay = c.activeTimer && c.activeTimer.endTime > Date.now() ? 
            `<div class="public-timer" data-endtime="${c.activeTimer.endTime}" style="margin-top:10px; font-weight:bold; color:var(--accent-neon); font-family:'Orbitron', sans-serif;">--:--:--</div>` : 
            '';

        const card = document.createElement('div');
        card.className = 'console-card glass-panel';
        card.innerHTML = `
            <i class="fas ${iconClass} console-icon"></i>
            <h3 class="console-title">${c.name} - ${c.type}</h3>
            <p class="console-location"><i class="fas fa-map-marker-alt"></i> ${c.location}</p>
            <span class="status-badge ${statusClass}">${statusText}</span>
            ${timerDisplay}
        `;
        container.appendChild(card);
    });
    
    // Also update the dropdown
    updateSpecificDeviceDropdown();
}

function updateSpecificDeviceDropdown() {
    const specificDeviceSelect = document.getElementById('specific-device');
    const deviceTypeSelect = document.getElementById('device-type');
    
    if (!specificDeviceSelect || !deviceTypeSelect) return;
    
    const selectedType = deviceTypeSelect.value;
    specificDeviceSelect.innerHTML = '<option value="any">أي جهاز متاح</option>';
    
    globalConsoles.forEach(c => {
        if (c && c.type === selectedType) {
            const option = document.createElement('option');
            option.value = c.name;
            // Show status in dropdown for better UX
            const statusText = c.status === 'available' ? 'متاح' : 'مشغول';
            option.textContent = `${c.name} - ${c.location} (${statusText})`;
            specificDeviceSelect.appendChild(option);
        }
    });
}

// Global Interval to update timers dynamically on the screen
setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.timer-display, .public-timer').forEach(el => {
        const endTime = parseInt(el.getAttribute('data-endtime'));
        if (endTime) {
            el.innerText = formatTimeLeft(endTime);
            if (endTime <= now) {
                el.innerText = "انتهى الوقت";
                el.style.color = "var(--danger)";
            }
        }
    });

    // Admin Automation: Check for approved bookings to activate or cancel
    if (window.isAdminAuthenticated) {
        globalBookings.forEach(b => {
            if (b.status === 'approved') {
                const noShowTime = b.startTime + (15 * 60 * 1000); // 15 mins grace period
                
                if (now >= noShowTime) {
                    // No show, cancel without refund
                    update(ref(db, `bookings/${b.id}`), { status: 'cancelled_noshow' });
                } else if (now >= b.startTime) {
                    // Time to start! Find an available device of the requested type
                    let availableConsoleIndex = -1;
                    
                    if (b.specificDevice && b.specificDevice !== 'any') {
                        // Priority to the specific device
                        availableConsoleIndex = globalConsoles.findIndex(c => c.name === b.specificDevice && c.status === 'available');
                    }
                    
                    // Fallback to any available if specific wasn't chosen or isn't available
                    if (availableConsoleIndex === -1) {
                         availableConsoleIndex = globalConsoles.findIndex(c => c.type === b.deviceType && c.status === 'available');
                    }
                    
                    if (availableConsoleIndex !== -1) {
                        // Start timer for half the duration (since they paid half)
                        const durationMs = (b.duration / 2) * 60 * 60 * 1000;
                        updateConsoleField(availableConsoleIndex, {
                            status: 'busy',
                            activeTimer: { endTime: now + durationMs, durationMinutes: (b.duration / 2) * 60 }
                        });
                        // Mark booking as active/completed
                        update(ref(db, `bookings/${b.id}`), { status: 'active_in_store' });
                    }
                }
            }
        });
    }
}, 1000);

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
            
        const timerDisplay = c.activeTimer && c.activeTimer.endTime > Date.now() ? 
            `<div class="timer-display" data-endtime="${c.activeTimer.endTime}">--:--:--</div>` : 
            '';

        row.innerHTML = `
            <div class="device-info">
                <strong>${c.name} (${c.type})</strong>
                <small class="text-muted">${c.location} - الحالة الحالية: ${statusBadge}</small>
                ${timerDisplay}
            </div>
            <div class="controls" style="flex-direction: column; align-items: flex-end;">
                <div>
                    <button class="btn btn-small btn-success status-btn" data-index="${index}" data-status="available">متاح</button>
                    <button class="btn btn-small btn-danger status-btn" data-index="${index}" data-status="busy">مشغول</button>
                </div>
                <div class="timer-controls">
                    <input type="number" id="hours-${index}" placeholder="ساعة" min="0" value="0">
                    <input type="number" id="mins-${index}" placeholder="دقيقة" min="0" max="59" value="0">
                    <button class="btn btn-small btn-primary start-timer-btn" data-index="${index}">بدء العداد</button>
                    <button class="btn btn-small btn-danger stop-timer-btn" data-index="${index}">إيقاف</button>
                </div>
            </div>
        `;
        container.appendChild(row);
    });

    // Status buttons
    container.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = e.target.getAttribute('data-index');
            const newStatus = e.target.getAttribute('data-status');
            updateConsoleField(index, { status: newStatus, activeTimer: null });
        });
    });

    // Start Timer
    container.querySelectorAll('.start-timer-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = e.target.getAttribute('data-index');
            const h = parseInt(document.getElementById(`hours-${index}`).value) || 0;
            const m = parseInt(document.getElementById(`mins-${index}`).value) || 0;
            if (h === 0 && m === 0) return alert("أدخل وقت صحيح");
            
            const durationMs = (h * 60 * 60 * 1000) + (m * 60 * 1000);
            const endTime = Date.now() + durationMs;
            
            updateConsoleField(index, { 
                status: 'busy', 
                activeTimer: { endTime, durationMinutes: (h * 60) + m } 
            });
        });
    });

    // Stop Timer
    container.querySelectorAll('.stop-timer-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = e.target.getAttribute('data-index');
            updateConsoleField(index, { status: 'available', activeTimer: null });
        });
    });
}

function updateConsoleField(index, fields) {
    const specificConsoleRef = ref(db, 'consoles/' + index);
    const updatedConsole = { ...globalConsoles[index], ...fields };
    set(specificConsoleRef, updatedConsole);
}

// Admin Bookings Rendering
window.renderAdminBookings = function() {
    const container = document.getElementById('admin-bookings-list');
    if (!container) return;
    container.innerHTML = '';
    
    // Sort descending by created
    const sorted = [...globalBookings].sort((a,b) => b.createdAt - a.createdAt);
    
    if (sorted.length === 0) {
        container.innerHTML = '<p class="text-muted">لا توجد حجوزات حالياً.</p>';
        return;
    }
    
    sorted.forEach(b => {
        const card = document.createElement('div');
        card.className = 'booking-card';
        
        const dateStr = new Date(b.startTime).toLocaleString('ar-EG');
        const statusMap = {
            'pending_payment': '<span style="color:var(--accent-neon)">في انتظار الدفع</span>',
            'approved': '<span style="color:var(--success)">مؤكد (تم الدفع)</span>',
            'cancelled': '<span style="color:var(--danger)">ملغي</span>',
            'cancelled_noshow': '<span style="color:var(--danger)">ملغي (لم يحضر)</span>',
            'active_in_store': '<span style="color:var(--success)">نشط الآن</span>'
        };
        
        card.innerHTML = `
            <h4>${b.name} - ${b.deviceType} (${b.duration} ساعة)</h4>
            <p><strong>الوقت:</strong> ${dateStr}</p>
            <p><strong>الجهاز المطلوب:</strong> ${b.specificDevice && b.specificDevice !== 'any' ? b.specificDevice : 'أي جهاز متاح'}</p>
            <p><strong>طريقة الدفع:</strong> ${b.paymentMethod} - <strong>العربون:</strong> ${b.depositAmount} جنيه</p>
            <p><strong>الحالة:</strong> ${statusMap[b.status] || b.status}</p>
            
            <div class="booking-actions">
                ${b.status === 'pending_payment' ? `<button class="btn btn-small btn-success approve-booking-btn" data-id="${b.id}">تأكيد الدفع</button>` : ''}
                ${b.status !== 'cancelled' ? `<button class="btn btn-small btn-danger cancel-booking-btn" data-id="${b.id}">إلغاء الحجز</button>` : ''}
            </div>
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('.approve-booking-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            const bRef = ref(db, `bookings/${id}`);
            update(bRef, { status: 'approved' });
        });
    });

    container.querySelectorAll('.cancel-booking-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if(confirm("هل أنت متأكد من إلغاء هذا الحجز؟")) {
                const id = e.target.getAttribute('data-id');
                const bRef = ref(db, `bookings/${id}`);
                update(bRef, { status: 'cancelled' });
            }
        });
    });
}

// Login logic
const loginForm = document.getElementById('admin-login-form');
if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('admin-email').value;
        const password = document.getElementById('admin-password').value;
        const errorMsg = document.getElementById('login-error');
        
        signInWithEmailAndPassword(auth, email, password)
            .then(() => {
                errorMsg.style.display = 'none';
            })
            .catch((error) => {
                errorMsg.style.display = 'block';
                errorMsg.innerText = "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
                console.error(error);
            });
    });
}

// Logout logic
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        signOut(auth);
    });
}

// Admin Tabs Logic
const devicesTabBtn = document.getElementById('devices-tab-btn');
const bookingsTabBtn = document.getElementById('bookings-tab-btn');
const devicesTab = document.getElementById('devices-tab');
const bookingsTab = document.getElementById('bookings-tab');

if (devicesTabBtn && bookingsTabBtn) {
    devicesTabBtn.addEventListener('click', () => {
        devicesTab.style.display = 'block';
        bookingsTab.style.display = 'none';
        devicesTabBtn.classList.add('active-tab');
        bookingsTabBtn.classList.remove('active-tab');
    });

    bookingsTabBtn.addEventListener('click', () => {
        devicesTab.style.display = 'none';
        bookingsTab.style.display = 'block';
        bookingsTabBtn.classList.add('active-tab');
        devicesTabBtn.classList.remove('active-tab');
    });
}

// --- Settings Placeholders ---
const PRICES = {
    PS4: 40, // جنيه/ساعة (Placeholder)
    PS5: 60  // جنيه/ساعة (Placeholder)
};

const PAYMENT_NUMBERS = {
    vodafone: "01000000000 (Placeholder)",
    instapay: "roma_play@instapay (Placeholder)"
};

// Handle WhatsApp / Booking form
const bookingForm = document.getElementById('whatsapp-booking-form');
const paymentMethodSelect = document.getElementById('payment-method');
const paymentInstructionsDiv = document.getElementById('payment-instructions');

if (paymentMethodSelect) {
    paymentMethodSelect.addEventListener('change', (e) => {
        const method = e.target.value;
        const deviceType = document.getElementById('device-type').value;
        const duration = parseInt(document.getElementById('duration').value) || 1;
        
        const pricePerHour = PRICES[deviceType] || 50;
        const deposit = (pricePerHour * duration) / 2;

        if (method === 'vodafone') {
            paymentInstructionsDiv.style.display = 'block';
            paymentInstructionsDiv.innerHTML = `<p style="color: var(--accent-neon); margin-bottom: 10px;">الرجاء تحويل مبلغ <strong>${deposit} جنيه</strong> (نصف المدة) إلى الرقم: <br><strong style="font-size: 1.2rem;">${PAYMENT_NUMBERS.vodafone}</strong><br>ثم اضغط تأكيد.</p>`;
        } else if (method === 'instapay') {
            paymentInstructionsDiv.style.display = 'block';
            paymentInstructionsDiv.innerHTML = `<p style="color: var(--accent-neon); margin-bottom: 10px;">الرجاء تحويل مبلغ <strong>${deposit} جنيه</strong> (نصف المدة) إلى حساب إنستا باي: <br><strong style="font-size: 1.2rem;">${PAYMENT_NUMBERS.instapay}</strong><br>ثم اضغط تأكيد.</p>`;
        } else if (method === 'instore') {
            paymentInstructionsDiv.style.display = 'block';
            paymentInstructionsDiv.innerHTML = `<p style="color: var(--accent-neon); margin-bottom: 10px;">الرجاء زيارتنا في المحل لدفع مبلغ <strong>${deposit} جنيه</strong> لتأكيد الحجز. الحجز لن يعتمد حتى يتم الدفع.</p>`;
        } else {
            paymentInstructionsDiv.style.display = 'none';
        }
    });
    
    // Update instructions if device or duration changes
    const deviceTypeSelect = document.getElementById('device-type');
    if (deviceTypeSelect) {
        deviceTypeSelect.addEventListener('change', () => {
            paymentMethodSelect.dispatchEvent(new Event('change'));
            updateSpecificDeviceDropdown();
        });
    }
    
    const durationInput = document.getElementById('duration');
    if (durationInput) {
        durationInput.addEventListener('input', () => paymentMethodSelect.dispatchEvent(new Event('change')));
    }
}

import { push, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
const bookingsRef = ref(db, 'bookings');

if (bookingForm) {
    bookingForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = document.getElementById('name').value;
        const deviceType = document.getElementById('device-type').value;
        const specificDevice = document.getElementById('specific-device') ? document.getElementById('specific-device').value : 'any';
        const roomType = document.getElementById('room-type').value;
        const timeStr = document.getElementById('time').value;
        const duration = parseInt(document.getElementById('duration').value) || 1;
        const paymentMethod = document.getElementById('payment-method').value;
        
        const pricePerHour = PRICES[deviceType] || 50;
        const deposit = (pricePerHour * duration) / 2;

        // Parse HH:MM into today's timestamp
        const now = new Date();
        const [hours, minutes] = timeStr.split(':');
        const startTimeDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(hours), parseInt(minutes));
        const startTime = startTimeDate.getTime();

        const newBooking = {
            name,
            deviceType,
            specificDevice,
            roomType,
            startTime: startTime,
            duration,
            paymentMethod,
            depositAmount: deposit,
            status: 'pending_payment',
            createdAt: Date.now()
        };

        push(bookingsRef, newBooking)
            .then(() => {
                const feedback = document.getElementById('booking-feedback');
                feedback.style.display = 'block';
                feedback.style.color = 'var(--success)';
                feedback.innerText = "تم تسجيل طلب الحجز بنجاح! الإدارة ستقوم بمراجعته وتأكيده قريباً.";
                bookingForm.reset();
                paymentInstructionsDiv.style.display = 'none';
            })
            .catch((error) => {
                console.error("Booking failed", error);
                alert("حدث خطأ أثناء الحجز، يرجى المحاولة لاحقاً.");
            });
    });
}
