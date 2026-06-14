// ==========================================
// app.js - Main UI Logic (Non-Module)
// Called by firebase-init.js after Firebase loads
// ==========================================

let db, auth, ref, onValue, set, get, push, update,
    signInWithEmailAndPassword, signOut, onAuthStateChanged;

let globalConsoles = [];
let globalBookings = [];

const PRICES = { PS4: 40, PS5: 60 };
const PAYMENT_NUMBERS = {
    vodafone: "01000000000",
    instapay: "roma_play@instapay"
};

const initialConsoles = [
    { id: 1, name: "جهاز 1", type: "PS5", location: "الصالة الرئيسية", status: "available" },
    { id: 2, name: "جهاز 2", type: "PS5", location: "الصالة الرئيسية", status: "available" },
    { id: 3, name: "جهاز 3", type: "PS4", location: "الصالة الرئيسية", status: "available" },
    { id: 4, name: "VIP 1", type: "PS5", location: "غرفة VIP", status: "available" },
    { id: 5, name: "VIP 2", type: "PS5", location: "غرفة VIP", status: "available" },
    { id: 6, name: "جهاز 4", type: "PS4", location: "الصالة الرئيسية", status: "available" },
];

function formatTimeLeft(endTime) {
    const now = Date.now();
    const diff = endTime - now;
    if (diff <= 0) return "00:00:00";
    const h = Math.floor(diff / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function getDayKey(timestamp) {
    if (!timestamp) return "حجوزات غير محددة التاريخ";
    const date = new Date(timestamp);
    return date.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function getWorkingDayBaseDate() {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (now.getHours() < 3) {
        base.setDate(base.getDate() - 1);
    }
    return base;
}

function isSlotAvailable(startTime, duration, deviceType, specificDevice, roomType) {
    const start = startTime;
    const end = startTime + duration * 3600 * 1000;
    
    const overlappingBookings = globalBookings.filter(b => {
        if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
        
        const bStart = b.startTime;
        const bEnd = b.startTime + b.duration * 3600 * 1000;
        return (start < bEnd && end > bStart);
    });

    if (specificDevice && specificDevice !== 'any') {
        const conflict = overlappingBookings.find(b => b.specificDevice === specificDevice);
        if (conflict) return false;
    }

    const dbRoomName = roomType === 'Main Hall' ? 'الصالة الرئيسية' : 'غرفة VIP';
    const matchingDevices = globalConsoles.filter(c => c && c.type === deviceType && c.location === dbRoomName);
    const totalDevicesCount = matchingDevices.length;
    
    const conflictingOverlapping = overlappingBookings.filter(b => {
        if (b.deviceType !== deviceType) return false;
        if (b.specificDevice && b.specificDevice !== 'any') {
            const dev = globalConsoles.find(c => c && c.name === b.specificDevice);
            return dev && dev.location === dbRoomName;
        }
        return b.roomType === roomType;
    });

    if (conflictingOverlapping.length >= totalDevicesCount) {
        return false;
    }
    
    return true;
}

function updateTimeSlotsDropdown() {
    const timeSel = document.getElementById('time');
    const deviceTypeEl = document.getElementById('device-type');
    const specificDeviceEl = document.getElementById('specific-device');
    const roomTypeEl = document.getElementById('room-type');
    const durationEl = document.getElementById('duration');
    
    if (!timeSel || !deviceTypeEl || !roomTypeEl || !durationEl) return;
    
    const deviceType = deviceTypeEl.value;
    const specificDevice = specificDeviceEl ? specificDeviceEl.value : 'any';
    const roomType = roomTypeEl.value;
    const duration = parseInt(durationEl.value) || 1;
    
    const previousValue = timeSel.value;
    timeSel.innerHTML = '';
    
    const base = getWorkingDayBaseDate();
    let hasAvailableSlots = false;
    
    // Slots from 12:00 (noon) to 02:00 AM of the next morning.
    // H represents hours from 12 to 26 (24 = 12 AM next day, 25 = 1 AM, 26 = 2 AM)
    for (let H = 12; H <= 26; H++) {
        const slotDate = new Date(base.getTime());
        let hour = H;
        if (H >= 24) {
            slotDate.setDate(slotDate.getDate() + 1);
            hour = H - 24;
        }
        slotDate.setHours(hour, 0, 0, 0);
        const slotTime = slotDate.getTime();
        
        // Don't show past slots
        if (slotTime < Date.now() - 10 * 60 * 1000) { // 10 mins grace period
            continue;
        }
        
        // Format label
        let labelHour = hour;
        let period = 'م';
        if (hour === 0) {
            labelHour = 12;
            period = 'منتصف الليل';
        } else if (hour === 12) {
            labelHour = 12;
            period = 'ظهراً';
        } else if (hour > 12) {
            labelHour = hour - 12;
            period = 'مساءً';
        } else {
            period = 'صباحاً';
        }
        const labelStr = `${labelHour.toString().padStart(2, '0')}:00 ${period}`;
        
        const available = isSlotAvailable(slotTime, duration, deviceType, specificDevice, roomType);
        
        if (available) {
            const opt = document.createElement('option');
            opt.value = slotTime.toString();
            opt.textContent = labelStr;
            timeSel.appendChild(opt);
            hasAvailableSlots = true;
        }
    }
    
    if (!hasAvailableSlots) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'لا توجد أوقات متاحة لهذا التحديد';
        timeSel.appendChild(opt);
    } else {
        const promptOpt = document.createElement('option');
        promptOpt.value = '';
        promptOpt.textContent = 'اختر وقت الحجز';
        promptOpt.disabled = true;
        timeSel.insertBefore(promptOpt, timeSel.firstChild);
        
        if (previousValue && timeSel.querySelector(`option[value="${previousValue}"]`)) {
            timeSel.value = previousValue;
        } else {
            timeSel.value = '';
        }
    }
}
window.updateTimeSlotsDropdown = updateTimeSlotsDropdown;

function updateSpecificDeviceDropdown() {
    const sel = document.getElementById('specific-device');
    const typeEl = document.getElementById('device-type');
    const roomEl = document.getElementById('room-type');
    if (!sel || !typeEl) return;
    const selectedType = typeEl.value;
    const selectedRoom = roomEl ? roomEl.value : null;
    
    // Map dropdown value ("Main Hall" / "VIP Room") to database value ("الصالة الرئيسية" / "غرفة VIP")
    const dbRoomName = selectedRoom ? (selectedRoom === 'Main Hall' ? 'الصالة الرئيسية' : 'غرفة VIP') : null;
    
    sel.innerHTML = '<option value="any">أي جهاز متاح</option>';
    globalConsoles.forEach(c => {
        if (c && c.type === selectedType && (!dbRoomName || c.location === dbRoomName)) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = `${c.name} (${c.status === 'available' ? 'متاح' : 'مشغول'})`;
            sel.appendChild(opt);
        }
    });
}
window.updateSpecificDeviceDropdown = updateSpecificDeviceDropdown;

function renderConsoles() {
    const container = document.getElementById('consoles-container');
    if (!container) { updateSpecificDeviceDropdown(); return; }
    container.innerHTML = '';
    globalConsoles.forEach(c => {
        if (!c) return;
        const isPS5 = c.type === 'PS5';
        const statusClass = c.status === 'available' ? 'status-available' : 'status-busy';
        const statusText = c.status === 'available' ? 'متاح الآن' : 'مشغول';
        const timerDisplay = c.activeTimer && c.activeTimer.endTime > Date.now()
            ? `<div class="public-timer" data-endtime="${c.activeTimer.endTime}" style="margin-top:10px;font-weight:bold;color:var(--accent-neon);font-family:'Orbitron',sans-serif;">--:--:--</div>`
            : '';
        const card = document.createElement('div');
        card.className = 'console-card glass-panel';
        card.innerHTML = `
            <i class="fas fa-gamepad ${isPS5 ? 'ps5-icon' : 'ps4-icon'} console-icon"></i>
            <h3 class="console-title">${c.name} - ${c.type}</h3>
            <p class="console-location"><i class="fas fa-map-marker-alt"></i> ${c.location}</p>
            <span class="status-badge ${statusClass}">${statusText}</span>
            ${timerDisplay}
        `;
        container.appendChild(card);
    });
    updateSpecificDeviceDropdown();
    updateTimeSlotsDropdown();
}

function renderAdminConsoles() {
    const container = document.getElementById('admin-devices-list');
    if (!container) return;
    container.innerHTML = '';
    globalConsoles.forEach((c, index) => {
        if (!c) return;
        const statusBadge = c.status === 'available'
            ? '<span style="color:var(--success)">متاح</span>'
            : '<span style="color:var(--danger)">مشغول</span>';
        const timerDisplay = c.activeTimer && c.activeTimer.endTime > Date.now()
            ? `<div class="timer-display" data-endtime="${c.activeTimer.endTime}">--:--:--</div>`
            : '';
        const row = document.createElement('div');
        row.className = 'device-row';
        row.innerHTML = `
            <div class="device-info">
                <strong>${c.name} (${c.type})</strong>
                <small class="text-muted">${c.location} - الحالة: ${statusBadge}</small>
                ${timerDisplay}
            </div>
            <div class="controls" style="flex-direction:column;align-items:flex-end;">
                <div>
                    <button class="btn btn-small btn-success" onclick="window.setStatus(${index},'available')">متاح</button>
                    <button class="btn btn-small btn-danger" onclick="window.setStatus(${index},'busy')">مشغول</button>
                </div>
                <div class="timer-controls">
                    <input type="number" id="hours-${index}" placeholder="ساعة" min="0" value="0">
                    <input type="number" id="mins-${index}" placeholder="دقيقة" min="0" max="59" value="0">
                    <button class="btn btn-small btn-primary" onclick="window.startTimer(${index})">بدء العداد</button>
                    <button class="btn btn-small btn-danger" onclick="window.stopTimer(${index})">إيقاف</button>
                </div>
            </div>
        `;
        container.appendChild(row);
    });
}
window.renderAdminConsoles = renderAdminConsoles;

function renderAdminBookings() {
    const container = document.getElementById('admin-bookings-list');
    if (!container) return;
    container.innerHTML = '';
    
    if (globalBookings.length === 0) {
        container.innerHTML = '<p class="text-muted">لا توجد حجوزات حالياً.</p>';
        return;
    }
    
    // Sort bookings by startTime descending
    const sorted = [...globalBookings].sort((a, b) => b.startTime - a.startTime);
    
    // Group bookings by day
    const groups = {};
    sorted.forEach(b => {
        const dayKey = getDayKey(b.startTime);
        if (!groups[dayKey]) {
            groups[dayKey] = [];
        }
        groups[dayKey].push(b);
    });
    
    const statusMap = {
        'pending_payment': '<span style="color:var(--accent-neon)">في انتظار الدفع</span>',
        'approved': '<span style="color:var(--success)">مؤكد (تم الدفع)</span>',
        'cancelled': '<span style="color:var(--danger)">ملغي</span>',
        'cancelled_noshow': '<span style="color:var(--danger)">ملغي (لم يحضر)</span>',
        'active_in_store': '<span style="color:var(--success)">نشط الآن</span>',
        'completed': '<span style="color:var(--text-muted)">مكتمل</span>'
    };
    
    // Sort day keys chronologically descending (newest/today's date on top, older dates below)
    const sortedDayKeys = Object.keys(groups).sort((a, b) => {
        return groups[b][0].startTime - groups[a][0].startTime;
    });
    
    let weekTotalHours = 0;
    let weekTotalMoney = 0;

    sortedDayKeys.forEach(dayKey => {
        const bookingsInDay = groups[dayKey];
        const folder = document.createElement('div');
        folder.className = 'day-folder';
        
        let dayTotalHours = 0;
        let dayTotalMoney = 0;
        
        bookingsInDay.forEach(b => {
            if (b.status !== 'cancelled' && b.status !== 'cancelled_noshow') {
                dayTotalHours += b.duration;
                const price = PRICES[b.deviceType] || 50;
                dayTotalMoney += (price * b.duration);
            }
        });
        
        weekTotalHours += dayTotalHours;
        weekTotalMoney += dayTotalMoney;
        
        // Header
        const header = document.createElement('div');
        header.className = 'day-folder-header';
        header.innerHTML = `
            <i class="fas fa-folder-open folder-icon"></i>
            <span>${dayKey}</span>
            <span class="count-badge">${bookingsInDay.length} حجز | ${dayTotalHours} س | ${dayTotalMoney} ج</span>
            <i class="fas fa-chevron-down arrow-icon"></i>
        `;
        
        // Toggle collapse
        header.addEventListener('click', () => {
            folder.classList.toggle('collapsed');
            const icon = header.querySelector('.folder-icon');
            if (folder.classList.contains('collapsed')) {
                icon.className = 'fas fa-folder folder-icon';
            } else {
                icon.className = 'fas fa-folder-open folder-icon';
            }
        });
        
        // Content container
        const content = document.createElement('div');
        content.className = 'day-folder-content';
        
        bookingsInDay.forEach(b => {
            const card = document.createElement('div');
            card.className = 'booking-card';
            card.innerHTML = `
                <h4>${b.name} - ${b.deviceType} (${b.duration} ساعة)</h4>
                <p><strong>رقم الهاتف:</strong> <a href="tel:${b.phone || ''}" style="color: var(--accent-neon); text-decoration: none; font-weight: bold;">${b.phone || 'غير مسجل'}</a> ${b.phone ? `<a href="https://wa.me/${b.phone.startsWith('0') ? '20' + b.phone.substring(1) : b.phone}" target="_blank" style="margin-right: 15px; color: #25D366; text-decoration: none; font-weight: bold;"><i class="fab fa-whatsapp"></i> واتساب</a>` : ''}</p>
                <p><strong>الوقت:</strong> ${new Date(b.startTime).toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'})}</p>
                <p><strong>الجهاز المطلوب:</strong> ${b.specificDevice && b.specificDevice !== 'any' ? b.specificDevice : 'أي جهاز متاح'}</p>
                <p><strong>طريقة الدفع:</strong> ${b.paymentMethod} - <strong>العربون:</strong> ${b.depositAmount} جنيه</p>
                <p><strong>الحالة:</strong> ${statusMap[b.status] || b.status}</p>
                <div class="booking-actions">
                    ${b.status === 'pending_payment' ? `<button class="btn btn-small btn-success" onclick="window.approveBooking('${b.id}')">تأكيد الدفع</button>` : ''}
                    ${b.status !== 'cancelled' && b.status !== 'cancelled_noshow' && b.status !== 'completed' ? `<button class="btn btn-small btn-danger" onclick="window.cancelBooking('${b.id}')">إلغاء الحجز</button>` : ''}
                </div>
            `;
            content.appendChild(card);
        });
        
        folder.appendChild(header);
        folder.appendChild(content);
        container.appendChild(folder);
    });
    
    const weekSummary = document.createElement('div');
    weekSummary.className = 'glass-panel';
    weekSummary.style.marginTop = '20px';
    weekSummary.style.textAlign = 'center';
    weekSummary.innerHTML = `
        <h3 style="color: var(--accent-neon); margin-bottom: 10px;">إجمالي الفترة (آخر 7 أيام)</h3>
        <div style="display: flex; justify-content: center; gap: 30px; font-size: 1.2rem; font-weight: bold;">
            <span><i class="fas fa-clock"></i> إجمالي الساعات: ${weekTotalHours}</span>
            <span><i class="fas fa-money-bill-wave"></i> إجمالي الدخل: ${weekTotalMoney} ج.م</span>
        </div>
    `;
    container.appendChild(weekSummary);
}
window.renderAdminBookings = renderAdminBookings;

function updateConsoleField(index, fields) {
    const consoleRef = ref(db, 'consoles/' + index);
    set(consoleRef, { ...globalConsoles[index], ...fields });
}

window.setStatus = function(index, status) {
    updateConsoleField(index, { status, activeTimer: null });
};

window.startTimer = function(index) {
    const h = parseInt(document.getElementById(`hours-${index}`).value) || 0;
    const m = parseInt(document.getElementById(`mins-${index}`).value) || 0;
    if (h === 0 && m === 0) return alert("أدخل وقت صحيح");
    
    const durationMs = (h * 3600 + m * 60) * 1000;
    const durationHours = h + (m / 60);
    const endTime = Date.now() + durationMs;
    
    const c = globalConsoles[index];
    if (!c) return;
    const deviceType = c.type;
    const specificDevice = c.name;
    const roomType = c.location === 'الصالة الرئيسية' ? 'Main Hall' : 'VIP Room';
    const pricePerHour = PRICES[deviceType] || 50;
    const totalAmount = pricePerHour * durationHours;

    const bookingsRef = ref(db, 'bookings');
    const newBookingRef = push(bookingsRef);
    const newBookingId = newBookingRef.key;

    const newBooking = {
        name: `حجز مباشر - ${c.name}`,
        phone: 'غير مسجل',
        deviceType: deviceType,
        specificDevice: specificDevice,
        roomType: roomType,
        startTime: Date.now(),
        duration: durationHours,
        paymentMethod: 'instore',
        depositAmount: totalAmount,
        status: 'active_in_store',
        createdAt: Date.now()
    };

    set(newBookingRef, newBooking).then(() => {
        updateConsoleField(index, {
            status: 'busy',
            activeTimer: { 
                endTime, 
                durationMinutes: h * 60 + m,
                bookingId: newBookingId
            }
        });
    }).catch(err => {
        console.error("Failed to create walk-in booking:", err);
        updateConsoleField(index, {
            status: 'busy',
            activeTimer: { endTime, durationMinutes: h * 60 + m }
        });
    });
};

window.stopTimer = function(index) {
    const c = globalConsoles[index];
    if (c && c.activeTimer && c.activeTimer.bookingId) {
        update(ref(db, `bookings/${c.activeTimer.bookingId}`), { status: 'completed' });
    }
    updateConsoleField(index, { status: 'available', activeTimer: null });
};

function checkBookingConflict(booking) {
    const start = booking.startTime;
    const end = booking.startTime + booking.duration * 3600 * 1000;
    
    // Filter other bookings that are approved or active in store and overlap with this time
    const overlappingBookings = globalBookings.filter(b => {
        if (b.id === booking.id) return false;
        if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
        
        const bStart = b.startTime;
        const bEnd = b.startTime + b.duration * 3600 * 1000;
        return (start < bEnd && end > bStart);
    });

    // 1. If a specific device is selected
    if (booking.specificDevice && booking.specificDevice !== 'any') {
        const conflict = overlappingBookings.find(b => b.specificDevice === booking.specificDevice);
        if (conflict) {
            return `تنبيه: الجهاز (${booking.specificDevice}) محجوز بالفعل في هذا الوقت للعميل (${conflict.name}).`;
        }
    }

    // 2. Check total capacity for the device type in the chosen room
    const dbRoomName = booking.roomType === 'Main Hall' ? 'الصالة الرئيسية' : 'غرفة VIP';
    const matchingDevices = globalConsoles.filter(c => c && c.type === booking.deviceType && c.location === dbRoomName);
    const totalDevicesCount = matchingDevices.length;
    
    const conflictingOverlapping = overlappingBookings.filter(b => {
        if (b.deviceType !== booking.deviceType) return false;
        
        if (b.specificDevice && b.specificDevice !== 'any') {
            const dev = globalConsoles.find(c => c && c.name === b.specificDevice);
            return dev && dev.location === dbRoomName;
        }
        
        return b.roomType === booking.roomType;
    });

    if (conflictingOverlapping.length >= totalDevicesCount) {
        const roomNameAr = booking.roomType === 'Main Hall' ? 'الصالة الرئيسية' : 'غرفة VIP';
        return `تنبيه: جميع أجهزة ${booking.deviceType} في ${roomNameAr} محجوزة بالفعل في هذا الوقت.`;
    }

    return null; // No conflict
}

window.approveBooking = function(id) {
    const booking = globalBookings.find(b => b.id === id);
    if (!booking) return;
    
    const conflictMessage = checkBookingConflict(booking);
    if (conflictMessage) {
        alert(conflictMessage);
        return;
    }
    
    update(ref(db, `bookings/${id}`), { status: 'approved' });
};

window.cancelBooking = function(id) {
    if (confirm("هل أنت متأكد من إلغاء هذا الحجز؟")) {
        update(ref(db, `bookings/${id}`), { status: 'cancelled' });
    }
};

window.switchTab = function(tab) {
    const devicesTab = document.getElementById('devices-tab');
    const bookingsTab = document.getElementById('bookings-tab');
    const devicesBtn = document.getElementById('devices-tab-btn');
    const bookingsBtn = document.getElementById('bookings-tab-btn');
    if (tab === 'devices') {
        devicesTab.style.display = 'block';
        bookingsTab.style.display = 'none';
        devicesBtn.classList.add('active-tab');
        bookingsBtn.classList.remove('active-tab');
    } else {
        devicesTab.style.display = 'none';
        bookingsTab.style.display = 'block';
        bookingsBtn.classList.add('active-tab');
        devicesBtn.classList.remove('active-tab');
    }
};

// Timer countdown
setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.timer-display, .public-timer').forEach(el => {
        const endTime = parseInt(el.getAttribute('data-endtime'));
        if (endTime) {
            if (endTime <= now) {
                el.innerText = "انتهى الوقت";
                el.style.color = "var(--danger)";
            } else {
                el.innerText = formatTimeLeft(endTime);
            }
        }
    });

    // Auto-release expired timers
    if (db && ref && set && globalConsoles.length > 0) {
        globalConsoles.forEach((c, index) => {
            if (c && c.status === 'busy' && c.activeTimer && c.activeTimer.endTime) {
                if (now >= c.activeTimer.endTime) {
                    const consoleRef = ref(db, 'consoles/' + index);
                    if (c.activeTimer.bookingId) {
                        update(ref(db, `bookings/${c.activeTimer.bookingId}`), { status: 'completed' });
                    }
                    set(consoleRef, { ...c, status: 'available', activeTimer: null }).catch(err => {
                        console.warn("Failed to auto-release console:", err);
                    });
                }
            }
        });
    }

    // Auto-activate bookings
    if (window._isAdmin) {
        globalBookings.forEach(b => {
            if (b.status === 'approved') {
                const gracePeriodMs = (b.duration / 2) * 3600 * 1000;
                const noShowTime = b.startTime + gracePeriodMs;
                if (now >= noShowTime) {
                    update(ref(db, `bookings/${b.id}`), { status: 'cancelled_noshow' });
                } else if (now >= b.startTime) {
                    let idx = -1;
                    if (b.specificDevice && b.specificDevice !== 'any') {
                        idx = globalConsoles.findIndex(c => c && c.name === b.specificDevice && c.status === 'available');
                    }
                    if (idx === -1) idx = globalConsoles.findIndex(c => c && c.type === b.deviceType && c.status === 'available');
                    if (idx !== -1) {
                        const durationMs = (b.duration / 2) * 3600 * 1000;
                        updateConsoleField(idx, { status: 'busy', activeTimer: { endTime: now + durationMs, bookingId: b.id } });
                        update(ref(db, `bookings/${b.id}`), { status: 'active_in_store' });
                    }
                }
            } else if (b.status === 'active_in_store') {
                const bEndTime = b.startTime + (b.duration * 3600 * 1000);
                if (now >= bEndTime) {
                    update(ref(db, `bookings/${b.id}`), { status: 'completed' });
                }
            }
        });
    }
}, 1000);

// Payment instructions
function updatePaymentInstructions() {
    const methodEl = document.getElementById('payment-method');
    const instructionsEl = document.getElementById('payment-instructions');
    const deviceTypeEl = document.getElementById('device-type');
    const durationEl = document.getElementById('duration');
    if (!methodEl || !instructionsEl) return;
    const method = methodEl.value;
    const deviceType = deviceTypeEl ? deviceTypeEl.value : 'PS5';
    const duration = parseInt(durationEl ? durationEl.value : 1) || 1;
    const deposit = (PRICES[deviceType] || 50) * duration / 2;
    if (method === 'vodafone') {
        instructionsEl.style.display = 'block';
        instructionsEl.innerHTML = `<p style="color:var(--accent-neon)">حول <strong>${deposit} جنيه</strong> (نصف المدة) إلى:<br><strong style="font-size:1.2rem">${PAYMENT_NUMBERS.vodafone}</strong><br>ثم اضغط تأكيد.</p>`;
    } else if (method === 'instapay') {
        instructionsEl.style.display = 'block';
        instructionsEl.innerHTML = `<p style="color:var(--accent-neon)">حول <strong>${deposit} جنيه</strong> (نصف المدة) إلى حساب إنستا باي:<br><strong style="font-size:1.2rem">${PAYMENT_NUMBERS.instapay}</strong><br>ثم اضغط تأكيد.</p>`;
    } else if (method === 'instore') {
        instructionsEl.style.display = 'block';
        instructionsEl.innerHTML = `<p style="color:var(--accent-neon)">قم بزيارتنا في المحل لدفع <strong>${deposit} جنيه</strong> لتأكيد الحجز.</p>`;
    } else {
        instructionsEl.style.display = 'none';
    }
}

// Initialize everything once Firebase is ready
window.initApp = function(firebaseServices) {
    db = firebaseServices.db;
    auth = firebaseServices.auth;
    ref = firebaseServices.ref;
    onValue = firebaseServices.onValue;
    set = firebaseServices.set;
    get = firebaseServices.get;
    push = firebaseServices.push;
    update = firebaseServices.update;
    signInWithEmailAndPassword = firebaseServices.signInWithEmailAndPassword;
    signOut = firebaseServices.signOut;
    onAuthStateChanged = firebaseServices.onAuthStateChanged;

    const consolesRef = ref(db, 'consoles');
    const bookingsRef = ref(db, 'bookings');

    // Seed DB if empty
    get(consolesRef).then(snap => { if (!snap.exists()) set(consolesRef, initialConsoles); });

    // Auth state
    onAuthStateChanged(auth, user => {
        const loginSection = document.getElementById('login-section');
        const adminSection = document.getElementById('admin-section');
        const logoutBtn = document.getElementById('logout-btn');
        if (user) {
            window._isAdmin = true;
            if (loginSection) loginSection.style.display = 'none';
            if (adminSection) adminSection.style.display = 'block';
            if (logoutBtn) logoutBtn.style.display = 'inline-block';
            renderAdminConsoles();
            renderAdminBookings();
        } else {
            window._isAdmin = false;
            if (loginSection) loginSection.style.display = 'flex';
            if (adminSection) adminSection.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'none';
        }
    });

    // Realtime consoles
    onValue(consolesRef, snap => {
        if (snap.exists()) {
            globalConsoles = snap.val();
            renderConsoles();
            if (window._isAdmin) renderAdminConsoles();
        }
    });

    // Realtime bookings
    onValue(bookingsRef, snap => {
        if (snap.exists()) {
            const data = snap.val();
            globalBookings = Object.keys(data).map(k => ({ id: k, ...data[k] }));

            // Auto-cleanup bookings older than 7 days
            const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            globalBookings.forEach(b => {
                const bookingTime = b.createdAt || b.startTime;
                if (bookingTime && bookingTime < oneWeekAgo) {
                    set(ref(db, `bookings/${b.id}`), null).catch(err => {
                        console.warn("Failed to auto-delete old booking:", err);
                    });
                }
            });
        } else {
            globalBookings = [];
        }
        if (window._isAdmin) renderAdminBookings();
        updateTimeSlotsDropdown();
    });

    // Login form
    const loginForm = document.getElementById('admin-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', e => {
            e.preventDefault();
            const email = document.getElementById('admin-email').value;
            const password = document.getElementById('admin-password').value;
            const errMsg = document.getElementById('login-error');
            signInWithEmailAndPassword(auth, email, password)
                .then(() => { if (errMsg) errMsg.style.display = 'none'; })
                .catch(() => { if (errMsg) { errMsg.style.display = 'block'; errMsg.innerText = 'البريد أو كلمة المرور غير صحيحة.'; } });
        });
    }

    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));

    // Hamburger menu
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');
    if (hamburger && navLinks) {
        hamburger.addEventListener('click', () => {
            navLinks.classList.toggle('active');
        });
    }

    // Booking form
    const bookingForm = document.getElementById('whatsapp-booking-form');
    if (bookingForm) {
        const payMethodEl = document.getElementById('payment-method');
        const deviceTypeEl = document.getElementById('device-type');
        const roomTypeEl = document.getElementById('room-type');
        const durationEl = document.getElementById('duration');
        const specificDeviceEl = document.getElementById('specific-device');
        
        if (payMethodEl) payMethodEl.addEventListener('change', updatePaymentInstructions);
        if (deviceTypeEl) deviceTypeEl.addEventListener('change', () => { updatePaymentInstructions(); updateSpecificDeviceDropdown(); updateTimeSlotsDropdown(); });
        if (roomTypeEl) roomTypeEl.addEventListener('change', () => { updatePaymentInstructions(); updateSpecificDeviceDropdown(); updateTimeSlotsDropdown(); });
        if (durationEl) durationEl.addEventListener('input', () => { updatePaymentInstructions(); updateTimeSlotsDropdown(); });
        if (specificDeviceEl) specificDeviceEl.addEventListener('change', updateTimeSlotsDropdown);

        // Initial populating of time slots dropdown
        updateTimeSlotsDropdown();

        bookingForm.addEventListener('submit', e => {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const phone = document.getElementById('phone').value;
            const deviceType = document.getElementById('device-type').value;
            const specificDevice = document.getElementById('specific-device') ? document.getElementById('specific-device').value : 'any';
            const roomType = document.getElementById('room-type').value;
            const timeVal = document.getElementById('time').value;
            if (!timeVal) {
                alert('الرجاء اختيار وقت الحجز');
                return;
            }
            const startTime = parseInt(timeVal);
            const duration = parseInt(document.getElementById('duration').value) || 1;
            const paymentMethod = document.getElementById('payment-method').value;
            const deposit = (PRICES[deviceType] || 50) * duration / 2;

            push(bookingsRef, {
                name, phone, deviceType, specificDevice, roomType,
                startTime, duration, paymentMethod,
                depositAmount: deposit, status: 'pending_payment', createdAt: Date.now()
            }).then(() => {
                const fb = document.getElementById('booking-feedback');
                if (fb) { fb.style.display = 'block'; fb.style.color = 'var(--success)'; fb.innerText = 'تم تسجيل طلب الحجز بنجاح! الإدارة ستقوم بمراجعته قريباً.'; }
                bookingForm.reset();
                updateTimeSlotsDropdown();
                const instrEl = document.getElementById('payment-instructions');
                if (instrEl) instrEl.style.display = 'none';
            }).catch(err => { console.error(err); alert('حدث خطأ، يرجى المحاولة لاحقاً.'); });
        });
    }
};
