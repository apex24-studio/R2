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
    { id: 1, name: "جهاز 1", type: "PS4", location: "غرفة مستر الكبيرة", status: "available" },
    { id: 2, name: "جهاز 2", type: "PS4", location: "غرفة رقم 2", status: "available" },
    { id: 3, name: "جهاز 3", type: "PS4", location: "غرفة رقم 3", status: "available" },
    { id: 4, name: "جهاز 4", type: "PS4", location: "الصالة الرئيسية", status: "available" },
    { id: 5, name: "جهاز 5", type: "PS4", location: "الصالة الرئيسية", status: "available" }
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

function isSlotAvailable(startTime, durationRaw, deviceType, specificDevice, roomType) {
    const duration = durationRaw === 'open' ? 24 : durationRaw;
    const start = startTime;
    const end = startTime + duration * 3600 * 1000;
    
    const overlappingBookings = globalBookings.filter(b => {
        if (b.status !== 'approved' && b.status !== 'active_in_store' && b.status !== 'pending_payment') return false;
        
        const bStart = b.actualStartTime || b.startTime;
        const bDuration = b.duration === 'open' ? 24 : b.duration;
        const bEnd = bStart + bDuration * 3600 * 1000;
        return (start < bEnd && end > bStart);
    });

    if (specificDevice && specificDevice !== 'any') {
        const conflict = overlappingBookings.find(b => b.specificDevice === specificDevice);
        if (conflict) return false;
    }

    const dbRoomName = roomType;
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

// Check if a device has all remaining today's slots booked (or is manually busy)
function isDeviceFullyBooked(device) {
    if (!device) return false;
    if (device.status === 'busy') return true;

    const now = Date.now();
    const base = getWorkingDayBaseDate();
    const closingTimeObj = new Date(base.getTime());
    closingTimeObj.setDate(closingTimeObj.getDate() + 1);
    closingTimeObj.setHours(3, 0, 0, 0);
    const storeClosingTime = closingTimeObj.getTime();

    let hasFutureSlots = false;

    for (let H = 12; H <= 26; H += 0.5) {
        const slotDate = new Date(base.getTime());
        let hour = Math.floor(H);
        let minute = (H % 1) === 0.5 ? 30 : 0;
        if (hour >= 24) {
            slotDate.setDate(slotDate.getDate() + 1);
            hour -= 24;
        }
        slotDate.setHours(hour, minute, 0, 0);
        const slotTime = slotDate.getTime();

        if (slotTime < now - 10 * 60 * 1000) continue;
        if (slotTime + 3600 * 1000 > storeClosingTime) continue;

        hasFutureSlots = true;
        // If any slot is free for this specific device → not fully booked
        if (isSlotAvailable(slotTime, 1, device.type, device.name, device.location)) {
            return false;
        }
    }

    // Fully booked only if there were future slots and all were taken
    return hasFutureSlots;
}

function getDeviceHourlyStatus(device) {
    const base = getWorkingDayBaseDate();
    const now = Date.now();
    const statuses = [];

    for (let H = 12; H <= 26; H++) {
        const slotDate = new Date(base.getTime());
        let hour = H;
        if (H >= 24) {
            slotDate.setDate(slotDate.getDate() + 1);
            hour = H - 24;
        }
        slotDate.setHours(hour, 0, 0, 0);
        const slotStart = slotDate.getTime();
        const slotEnd = slotStart + 3600 * 1000;

        const isPast = slotEnd <= now;

        let isBooked = false;

        // Check active timer on this device
        if (device.activeTimer) {
            const timerStart = device.activeTimer.startTime || now;
            if (device.activeTimer.isOpen && !device.activeTimer.isGracePeriod) {
                if (slotStart >= timerStart) isBooked = true;
            } else if (device.activeTimer.endTime) {
                if (slotStart < device.activeTimer.endTime && slotEnd > timerStart) isBooked = true;
            }
        }

        // Check bookings assigned to this specific device
        if (!isBooked) {
            isBooked = globalBookings.some(b => {
                if (b.status !== 'approved' && b.status !== 'active_in_store' && b.status !== 'pending_payment') return false;
                if (!b.specificDevice || b.specificDevice === 'any' || b.specificDevice !== device.name) return false;

                const bStart = b.actualStartTime || b.startTime;
                const bDuration = b.duration === 'open' ? 24 : b.duration;
                const bEnd = bStart + bDuration * 3600 * 1000;
                return (slotStart < bEnd && slotEnd > bStart);
            });
        }

        // Label
        let label;
        if (H === 12 || H === 24) label = '12';
        else if (H > 12 && H < 24) label = (H - 12).toString();
        else label = (H - 24).toString();

        statuses.push({ label, isPast, isBooked });
    }

    return statuses;
}

function updateTimeSlotsDropdown() {
    const timeSel = document.getElementById('time');
    const deviceTypeEl = document.getElementById('device-type');
    const specificDeviceEl = document.getElementById('specific-device');
    const roomTypeEl = document.getElementById('room-type');
    const durationEl = document.getElementById('duration');
    
    if (!timeSel || !roomTypeEl || !durationEl) return;
    
    const specificDevice = specificDeviceEl ? specificDeviceEl.value : 'any';
    const roomType = roomTypeEl.value;
    
    // Derive deviceType: from dropdown if present, otherwise from the selected specific device
    let deviceType = deviceTypeEl ? deviceTypeEl.value : null;
    if (!deviceType && specificDevice && specificDevice !== 'any') {
        const foundDev = globalConsoles.find(c => c && c.name === specificDevice);
        deviceType = foundDev ? foundDev.type : 'PS4';
    }
    deviceType = deviceType || 'PS4';

    const durationRaw = durationEl.value;
    const duration = durationRaw === 'open' ? 'open' : parseFloat(durationRaw) || 1;
    
    const previousValue = timeSel.value;
    timeSel.innerHTML = '';
    
    const base = getWorkingDayBaseDate();
    let hasAvailableSlots = false;
    
    // Calculate store closing time (3:00 AM next day relative to base date)
    const closingTimeObj = new Date(base.getTime());
    closingTimeObj.setDate(closingTimeObj.getDate() + 1);
    closingTimeObj.setHours(3, 0, 0, 0);
    const storeClosingTime = closingTimeObj.getTime();
    
    // 1. Fixed half-hour slots
    for (let H = 12; H <= 26; H += 0.5) {
        const slotDate = new Date(base.getTime());
        let hour = Math.floor(H);
        let minute = (H % 1) === 0.5 ? 30 : 0;
        if (hour >= 24) {
            slotDate.setDate(slotDate.getDate() + 1);
            hour -= 24;
        }
        slotDate.setHours(hour, minute, 0, 0);
        slotTimesSet.add(slotDate.getTime());
    }

    // 2. Dynamic slots from end times of active/approved bookings
    globalBookings.forEach(b => {
        if (b.status === 'approved' || b.status === 'active_in_store' || b.status === 'pending_payment') {
            const bStart = b.actualStartTime || b.startTime;
            const bDuration = b.duration === 'open' ? 24 : b.duration;
            const bEnd = bStart + bDuration * 3600 * 1000;
            if (bEnd >= Date.now()) {
                slotTimesSet.add(bEnd);
            }
        }
    });

    // Sort the times
    const sortedSlotTimes = Array.from(slotTimesSet).sort((a, b) => a - b);

    sortedSlotTimes.forEach(slotTime => {
        // Don't show past slots
        if (slotTime < Date.now()) {
            return;
        }

        // Calculate expected end time
        let expectedEndMs = slotTime;
        if (duration === 'open') {
            expectedEndMs = slotTime + (1 * 3600 * 1000); // Require at least 1 hour before closing
        } else {
            expectedEndMs = slotTime + (duration * 3600 * 1000);
        }

        // Skip slot if it extends beyond store closing time
        if (expectedEndMs > storeClosingTime) {
            return;
        }

        // Format label
        const dateObj = new Date(slotTime);
        const hour24 = dateObj.getHours();
        const minute = dateObj.getMinutes();
        
        let labelHour = hour24;
        let period = 'م';
        if (hour24 === 0) {
            labelHour = 12;
            period = 'منتصف الليل';
        } else if (hour24 === 12) {
            labelHour = 12;
            period = 'ظهراً';
        } else if (hour24 > 12) {
            labelHour = hour24 - 12;
            period = 'مساءً';
        } else {
            period = 'صباحاً';
        }
        const minuteStr = minute.toString().padStart(2, '0');
        let labelStr = `${labelHour.toString().padStart(2, '0')}:${minuteStr} ${period}`;
        
        const available = isSlotAvailable(slotTime, duration, deviceType, specificDevice, roomType);
        
        if (available) {
            const opt = document.createElement('option');
            opt.value = slotTime.toString();
            opt.textContent = labelStr;
            timeSel.appendChild(opt);
            hasAvailableSlots = true;
        }
    });
    
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
    if (!sel) return;
    // If no device-type element exists (e.g. after pre-selection), show all
    const selectedType = typeEl ? typeEl.value : null;
    const selectedRoom = roomEl ? roomEl.value : null;
    const dbRoomName = selectedRoom || null;

    sel.innerHTML = '';
    globalConsoles.forEach(c => {
        if (c && (!selectedType || c.type === selectedType) && (!dbRoomName || c.location === dbRoomName)) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = `${c.name} (${c.status === 'available' ? 'متاح' : 'مشغول'})`;
            sel.appendChild(opt);
        }
    });
}
window.updateSpecificDeviceDropdown = updateSpecificDeviceDropdown;

// Pre-select device + location in booking form and scroll to it
window.bookConsole = function(deviceName, location, deviceType) {
    const roomSel = document.getElementById('room-type');
    if (roomSel) {
        roomSel.value = location;
        roomSel.dispatchEvent(new Event('change'));
    }
    // Small delay so the specific-device dropdown re-populates first
    setTimeout(() => {
        const devSel = document.getElementById('specific-device');
        if (devSel) {
            devSel.value = deviceName;
            devSel.dispatchEvent(new Event('change'));
        }
        const bookingForm = document.getElementById('whatsapp-booking-form');
        if (bookingForm) {
            bookingForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 150);
};

function renderConsoles() {
    const container = document.getElementById('consoles-container');
    if (!container) { updateSpecificDeviceDropdown(); return; }
    container.innerHTML = '';
    globalConsoles.forEach((c, idx) => {
        if (!c) return;
        const isPS5 = c.type === 'PS5';

        // Determine effective status (manual busy OR all slots taken)
        const fullyBooked = isDeviceFullyBooked(c);
        const statusClass = fullyBooked ? 'status-busy' : 'status-available';
        const statusText  = fullyBooked ? 'مشغول'     : 'متاح الآن';
        const glowClass   = fullyBooked ? 'glow-busy'  : 'glow-available';

        // Hourly availability for this device
        const hourStatuses = getDeviceHourlyStatus(c);
        const hoursHtml = hourStatuses.map(h => {
            let cls = 'hour-slot';
            if (h.isPast) cls += ' hour-past';
            else if (h.isBooked) cls += ' hour-booked';
            else cls += ' hour-available';
            return `<span class="${cls}">${h.label}</span>`;
        }).join('');

        let timerDisplay = '';
        if (c.activeTimer) {
            if (c.activeTimer.isOpen && !c.activeTimer.isGracePeriod) {
                timerDisplay = `<div class="public-timer" data-isopen="true" data-starttime="${c.activeTimer.startTime}" style="margin-top:10px;font-weight:bold;color:var(--success);font-family:'Orbitron',sans-serif;">00:00:00</div>`;
            } else if (c.activeTimer.endTime > Date.now()) {
                timerDisplay = `<div class="public-timer" data-endtime="${c.activeTimer.endTime}" style="margin-top:10px;font-weight:bold;color:var(--accent-neon);font-family:'Orbitron',sans-serif;">--:--:--</div>`;
            }
        }

        // Book Now button – only when device is not busy
        const bookBtn = !fullyBooked
            ? `<button class="btn-book-now" onclick="window.bookConsole('${c.name}','${c.location}','${c.type}')">
                   <i class="fas fa-calendar-check"></i> احجز الآن
               </button>`
            : '';

        const card = document.createElement('div');
        card.className = 'console-card glass-panel';
        card.innerHTML = `
            <div class="card-hours-strip">${hoursHtml}</div>
            <div class="console-icon-wrapper ${glowClass}">
                <i class="fas fa-gamepad ${isPS5 ? 'ps5-icon' : 'ps4-icon'} console-icon" style="font-size:4rem;"></i>
            </div>
            <h3 class="console-title">${c.name} - ${c.type}</h3>
            <p class="console-location"><i class="fas fa-map-marker-alt"></i> ${c.location}</p>
            <div class="status-action-row">
                <span class="status-badge ${statusClass}">${statusText}</span>
                ${bookBtn}
            </div>
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
        let timerDisplay = '';
        if (c.activeTimer) {
            if (c.activeTimer.isOpen && !c.activeTimer.isGracePeriod) {
                timerDisplay = `<div class="timer-display" data-isopen="true" data-starttime="${c.activeTimer.startTime}">00:00:00</div>`;
            } else if (c.activeTimer.endTime > Date.now()) {
                timerDisplay = `<div class="timer-display" data-endtime="${c.activeTimer.endTime}">--:--:--</div>`;
            }
        }
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
                    <select id="play-mode-${index}" style="padding:4px;border-radius:4px;border:1px solid #ccc;background:#1a1a1a;color:#fff;">
                        <option value="single">فردي/زوجي</option>
                        <option value="multi">مالتي (4 أفراد)</option>
                    </select>
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
    
    // Filter out old "cancelled" bookings so they don't count towards length or show up
    const validBookings = globalBookings.filter(b => b.status !== 'cancelled');

    if (validBookings.length === 0) {
        container.innerHTML = '<p class="text-muted">لا توجد حجوزات حالياً.</p>';
        return;
    }
    
    // Sort bookings by startTime descending
    const sorted = [...validBookings].sort((a, b) => b.startTime - a.startTime);
    
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
            // احتساب المبالغ: الحجوزات المؤكدة، النشطة، المكتملة، والملغاة لعدم الحضور (دفعوا العربون)
            if (b.status === 'approved' || b.status === 'active_in_store' || b.status === 'completed' || b.status === 'cancelled_noshow') {
                const dur = b.duration === 'open' ? 0 : parseFloat(b.duration) || 0;
                dayTotalHours += dur;
                dayTotalMoney += (b.depositAmount || 0);
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
        
        const deviceGroups = {};
        bookingsInDay.forEach(b => {
            const groupKey = (b.specificDevice && b.specificDevice !== 'any') 
                ? b.specificDevice 
                : `جهاز غير محدد (${b.deviceType} - ${b.roomType})`;
            
            if (!deviceGroups[groupKey]) deviceGroups[groupKey] = [];
            deviceGroups[groupKey].push(b);
        });

        Object.keys(deviceGroups).forEach(deviceKey => {
            const groupHeader = document.createElement('h4');
            groupHeader.style.color = 'var(--accent-neon)';
            groupHeader.style.margin = '15px 0 10px 0';
            groupHeader.style.borderBottom = '1px solid var(--glass-border)';
            groupHeader.style.paddingBottom = '5px';
            groupHeader.innerHTML = `<i class="fas fa-desktop"></i> ${deviceKey}`;
            content.appendChild(groupHeader);
            
            deviceGroups[deviceKey].forEach(b => {
                const now = Date.now();
                const durationNum = b.duration === 'open' ? 1 : b.duration;
                const gracePeriodMs = (durationNum / 2) * 3600 * 1000;
                const bStart = b.actualStartTime || b.startTime;
                const timeElapsedSinceStart = now - bStart; // الوقت اللي فات من موعد الحجز الفعلي
                
                // زرار إضافة الوقت المتبقي: يظهر لو الحجز نشط (مهلة الحضور شغالة) ولم يمتد بعد
                let extendBtnHtml = '';
                if (b.status === 'active_in_store' && !b.extended) {
                    if (b.duration === 'open') {
                        extendBtnHtml = `
                            <div style="background: rgba(0,210,255,0.08); border: 1px solid var(--accent-neon); border-radius: 8px; padding: 10px; margin: 8px 0;">
                                <p style="color: var(--accent-neon); font-weight: bold; margin-bottom: 8px;">
                                    <i class="fas fa-user-check"></i> العميل حضر – تفعيل العداد المفتوح
                                </p>
                                <button class="btn btn-small btn-primary" onclick="window.extendBookingTime('${b.id}')">
                                    <i class="fas fa-play"></i> تفعيل الوقت المفتوح
                                </button>
                            </div>
                        `;
                    } else {
                        const fullBookingEndMs = bStart + (b.duration * 3600 * 1000);
                        const remainingMs = Math.max(0, fullBookingEndMs - now);
                        if (remainingMs > 60000) {
                            const remainingMins = Math.floor(remainingMs / 60000);
                            const pricePerHour = (b.playMode === 'multi') ? 50 : (PRICES[b.deviceType] || 40);
                            const fullCost = pricePerHour * b.duration;
                            extendBtnHtml = `
                                <div style="background: rgba(0,210,255,0.08); border: 1px solid var(--accent-neon); border-radius: 8px; padding: 10px; margin: 8px 0;">
                                    <p style="color: var(--accent-neon); font-weight: bold; margin-bottom: 8px;">
                                        <i class="fas fa-user-check"></i> العميل حضر – يمكن إضافة ${remainingMins} دقيقة (إجمالي: ${fullCost} ج.م)
                                    </p>
                                    <button class="btn btn-small btn-primary" onclick="window.extendBookingTime('${b.id}')">
                                        <i class="fas fa-plus-circle"></i> إضافة الوقت المتبقي (${remainingMins} دقيقة)
                                    </button>
                                </div>
                            `;
                        }
                    }
                }
                
                const card = document.createElement('div');
                card.className = 'booking-card';
                card.innerHTML = `
                    <h4>${b.name}</h4>
                    <p><strong>رقم الهاتف:</strong> <a href="tel:${b.phone || ''}" style="color: var(--accent-neon); text-decoration: none; font-weight: bold;">${b.phone || 'غير مسجل'}</a> ${b.phone ? `<a href="https://wa.me/${b.phone.startsWith('0') ? '20' + b.phone.substring(1) : b.phone}" target="_blank" style="margin-right: 15px; color: #25D366; text-decoration: none; font-weight: bold;"><i class="fab fa-whatsapp"></i> واتساب</a>` : ''}</p>
                    <p><strong>موعد الحجز:</strong> ${new Date(b.startTime).toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'})}</p>
                    <p><strong>مدة الحجز:</strong> ${b.duration === 'open' ? 'مفتوح' : b.duration + ' ساعة'}</p>
                    <p><strong>طريقة الدفع:</strong> ${b.paymentMethod === 'vodafone' ? 'فودافون كاش' : b.paymentMethod === 'instapay' ? 'إنستاباي' : 'في المحل'} ${b.depositAmount > 0 ? `(عربون: ${b.depositAmount} ج)` : ''}</p>
                    <p><strong>وضع اللعب:</strong> ${b.playMode === 'multi' ? 'مالتي (4 أفراد)' : 'فردي/زوجي'}</p>
                    <p><strong>الحالة:</strong> ${statusMap[b.status] || b.status}</p>
                    ${extendBtnHtml}
                    <div class="booking-actions">
                        ${b.status === 'pending_payment' ? `<button class="btn btn-small btn-success" onclick="window.approveBooking('${b.id}')">تأكيد الدفع</button>` : ''}
                        ${b.status !== 'cancelled' && b.status !== 'cancelled_noshow' && b.status !== 'completed' ? `<button class="btn btn-small btn-danger" onclick="window.cancelBooking('${b.id}')">إلغاء الحجز</button>` : ''}
                    </div>
                `;
                content.appendChild(card);
            });
        });
        
        folder.appendChild(header);
        folder.appendChild(content);
        container.appendChild(folder);
    });
    
    const weekSummary = document.createElement('div');
    weekSummary.className = 'glass-panel';
    weekSummary.style.marginTop = '20px';
    weekSummary.style.textAlign = 'center';
    weekSummary.style.border = '1px solid rgba(0, 210, 255, 0.2)';
    weekSummary.innerHTML = `
        <h3 style="color: var(--accent-neon); margin-bottom: 20px; font-size: 1.3rem;">
            <i class="fas fa-chart-pie"></i> إحصائيات الفترة (آخر 7 أيام)
        </h3>
        <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; font-size: 1.1rem; font-weight: bold;">
            <div style="background: rgba(0,210,255,0.08); padding: 15px 30px; border-radius: 12px; border: 1px solid rgba(0,210,255,0.4); min-width: 180px;">
                <i class="fas fa-clock" style="color: var(--accent-neon); font-size: 1.8rem; margin-bottom: 12px; display: block;"></i> 
                إجمالي الساعات<br><span style="font-size:1.8rem; color: #fff;">${weekTotalHours}</span>
            </div>
            <div style="background: rgba(0,230,118,0.08); padding: 15px 30px; border-radius: 12px; border: 1px solid rgba(0,230,118,0.4); min-width: 180px;">
                <i class="fas fa-money-bill-wave" style="color: var(--success); font-size: 1.8rem; margin-bottom: 12px; display: block;"></i> 
                إجمالي الدخل<br><span style="font-size:1.8rem; color: #fff;">${weekTotalMoney} <span style="font-size: 1rem;">ج.م</span></span>
            </div>
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
    
    const isOpen = (h === 0 && m === 0);
    
    const c = globalConsoles[index];
    if (!c) return;
    const deviceType = c.type;
    const specificDevice = c.name;
    const roomType = c.location;
    const playModeEl = document.getElementById(`play-mode-${index}`);
    const playMode = playModeEl ? playModeEl.value : 'single';
    
    let durationHours, totalAmount, endTime;
    let finalPricePerHour = PRICES[deviceType] || 40;
    if (playMode === 'multi') finalPricePerHour = 50;
    
    if (isOpen) {
        durationHours = 'open';
        totalAmount = finalPricePerHour / 2; // عربون ساعة
        endTime = null;
    } else {
        const durationMs = (h * 3600 + m * 60) * 1000;
        durationHours = h + (m / 60);
        endTime = Date.now() + durationMs;
        totalAmount = finalPricePerHour * durationHours;
    }

    const bookingsRef = ref(db, 'bookings');
    const newBookingRef = push(bookingsRef);
    const newBookingId = newBookingRef.key;

    const newBooking = {
        name: `حجز مباشر - ${c.name}`,
        phone: 'غير مسجل',
        deviceType: deviceType,
        specificDevice: specificDevice,
        roomType: roomType,
        playMode: playMode,
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
                durationMinutes: isOpen ? null : h * 60 + m,
                bookingId: newBookingId,
                isOpen,
                isGracePeriod: false,
                startTime: Date.now()
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
        const bookingId = c.activeTimer.bookingId;
        const booking = globalBookings.find(b => b.id === bookingId);
        
        let updates = { status: 'completed' };
        
        if (booking && c.activeTimer.isOpen && c.activeTimer.startTime) {
            const diffMs = Date.now() - c.activeTimer.startTime;
            const hoursUsed = diffMs / (1000 * 3600);
            
            let pricePerHour = PRICES[booking.deviceType] || 40;
            if (booking.playMode === 'multi') pricePerHour = 50;
            
            let finalCost = pricePerHour * hoursUsed;
            if (booking.depositAmount && booking.depositAmount > 0) {
                finalCost = Math.max(booking.depositAmount, finalCost);
            }
            updates.duration = parseFloat(hoursUsed.toFixed(2));
            updates.depositAmount = Math.ceil(finalCost);
        }
        
        update(ref(db, `bookings/${bookingId}`), updates);
    }
    updateConsoleField(index, { status: 'available', activeTimer: null });
};

function checkBookingConflict(booking) {
    const start = booking.actualStartTime || booking.startTime;
    const bDurationNum = booking.duration === 'open' ? 24 : booking.duration;
    const end = start + bDurationNum * 3600 * 1000;
    
    // Filter other bookings that are approved or active in store and overlap with this time
    const overlappingBookings = globalBookings.filter(b => {
        if (b.id === booking.id) return false;
        if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
        
        const bStart = b.actualStartTime || b.startTime;
        const bOverlapDurationNum = b.duration === 'open' ? 24 : b.duration;
        const bEnd = bStart + bOverlapDurationNum * 3600 * 1000;
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
    const dbRoomName = booking.roomType;
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
        const roomNameAr = booking.roomType;
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
    if (confirm("هل أنت متأكد من إلغاء هذا الحجز وحذفه نهائياً؟")) {
        set(ref(db, `bookings/${id}`), null);
    }
};

window.activateBooking = function(id, bookingStartTime) {
    const booking = globalBookings.find(b => b.id === id);
    if (!booking) return;
    
    let idx = -1;
    if (booking.specificDevice && booking.specificDevice !== 'any') {
        idx = globalConsoles.findIndex(c => c && c.name === booking.specificDevice && c.status === 'available');
    }
    if (idx === -1) {
        const dbRoomName = booking.roomType;
        idx = globalConsoles.findIndex(c => c && c.type === booking.deviceType && c.location === dbRoomName && c.status === 'available');
    }
    if (idx === -1) {
        idx = globalConsoles.findIndex(c => c && c.type === booking.deviceType && c.status === 'available');
    }
    if (idx === -1) return;
    
    // العداد يشتغل لمدة مهلة الحضور فقط
    const durationNum = booking.duration === 'open' ? 1 : booking.duration;
    const gracePeriodMs = (durationNum / 2) * 3600 * 1000;
    const endTime = (bookingStartTime || booking.startTime) + gracePeriodMs;
    
    updateConsoleField(idx, {
        status: 'busy',
        activeTimer: { endTime, bookingId: id, isGracePeriod: true, isOpen: booking.duration === 'open', startTime: Date.now() }
    });
    update(ref(db, `bookings/${id}`), {
        status: 'active_in_store',
        actualStartTime: Date.now()
    });
};

// إضافة الوقت المتبقي لحد نهاية الحجز الكامل + تحديث الفلوس
window.extendBookingTime = function(id) {
    const booking = globalBookings.find(b => b.id === id);
    if (!booking) return;
    
    const consoleIdx = globalConsoles.findIndex(c => c && c.activeTimer && c.activeTimer.bookingId === id);
    if (consoleIdx === -1) {
        alert('لم يتم إيجاد الجهاز المرتبط بهذا الحجز.');
        return;
    }
    
    if (booking.duration === 'open') {
        updateConsoleField(consoleIdx, {
            status: 'busy',
            activeTimer: { ...globalConsoles[consoleIdx].activeTimer, endTime: null, isGracePeriod: false, isOpen: true, startTime: Date.now() }
        });
        update(ref(db, `bookings/${id}`), {
            extended: true,
            actualStartTime: Date.now()
        });
    } else {
        // نهاية الحجز الكامل من وقت الحجز الفعلي
        const bStart = booking.actualStartTime || booking.startTime;
        const fullBookingEndMs = bStart + (booking.duration * 3600 * 1000);
        
        let pricePerHour = PRICES[booking.deviceType] || 40;
        if (booking.playMode === 'multi') pricePerHour = 50;
        const fullCost = pricePerHour * booking.duration;
        
        updateConsoleField(consoleIdx, {
            status: 'busy',
            activeTimer: { ...globalConsoles[consoleIdx].activeTimer, endTime: fullBookingEndMs, isGracePeriod: false }
        });
        // تحديث الحجز: تعليم التمديد + تحديث المبلغ للتكلفة الكاملة
        update(ref(db, `bookings/${id}`), {
            extended: true,
            depositAmount: fullCost
        });
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
        const isOpen = el.getAttribute('data-isopen') === 'true';
        const startTime = parseInt(el.getAttribute('data-starttime'));
        
        if (isOpen && startTime && !endTime) {
            const diff = now - startTime;
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            el.innerText = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
            el.style.color = "var(--success)";
        } else if (endTime) {
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
                        // لو كان مهلة الحضور ولم يتم التمديد → لم يحضر
                        const newStatus = c.activeTimer.isGracePeriod ? 'cancelled_noshow' : 'completed';
                        update(ref(db, `bookings/${c.activeTimer.bookingId}`), { status: newStatus });
                    }
                    set(consoleRef, { ...c, status: 'available', activeTimer: null }).catch(err => {
                        console.warn("Failed to auto-release console:", err);
                    });
                }
            }
        });
    }

    // Auto-activate approved bookings when their time arrives + auto no-show cancellation
    if (window._isAdmin) {
        globalBookings.forEach(b => {
            if (b.status === 'approved') {
                const durationNum = b.duration === 'open' ? 1 : b.duration;
                const gracePeriodMs = (durationNum / 2) * 3600 * 1000;
                const noShowTime = b.startTime + gracePeriodMs;
                if (now >= noShowTime) {
                    // انتهت مهلة الحضور → إلغاء تلقائي
                    update(ref(db, `bookings/${b.id}`), { status: 'cancelled_noshow' });
                } else if (now >= b.startTime) {
                    // حان وقت الحجز → تفعيل تلقائي من وقت الحجز المجدول
                    window.activateBooking(b.id, b.startTime);
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
    const deviceType = deviceTypeEl ? deviceTypeEl.value : 'PS4';
    const durationRaw = durationEl ? durationEl.value : '1';
    const duration = durationRaw === 'open' ? 1 : parseFloat(durationRaw) || 1;
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
window.updatePaymentInstructionsGlobal = updatePaymentInstructions;

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

    // Seed DB if empty or if count is wrong
    get(consolesRef).then(snap => { 
        const data = snap.val();
        if (!data || data.length !== 5) {
            set(consolesRef, initialConsoles);
        }
    });

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
        if (durationEl) durationEl.addEventListener('change', () => { updatePaymentInstructions(); updateTimeSlotsDropdown(); });
        if (specificDeviceEl) specificDeviceEl.addEventListener('change', updateTimeSlotsDropdown);

        // Initial populating of time slots dropdown
        updateTimeSlotsDropdown();

        bookingForm.addEventListener('submit', e => {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const phone = document.getElementById('phone').value;
            const specificDeviceEl = document.getElementById('specific-device');
            const specificDevice = specificDeviceEl ? specificDeviceEl.value : 'any';
            // Derive deviceType from globalConsoles if device-type dropdown doesn't exist
            const deviceTypeEl2 = document.getElementById('device-type');
            let deviceType = deviceTypeEl2 ? deviceTypeEl2.value : null;
            if (!deviceType) {
                const found = globalConsoles.find(c => c && c.name === specificDevice);
                deviceType = found ? found.type : 'PS4';
            }
            const roomType = document.getElementById('room-type').value;
            const timeVal = document.getElementById('time').value;
            if (!timeVal) {
                alert('الرجاء اختيار وقت الحجز');
                return;
            }
            const startTime = parseInt(timeVal);
            const durationRaw = document.getElementById('duration').value;
            const duration = durationRaw === 'open' ? 'open' : parseFloat(durationRaw) || 1;
            const paymentMethod = document.getElementById('payment-method').value;
            const durationNum = duration === 'open' ? 1 : duration;
            const deposit = (PRICES[deviceType] || 50) * durationNum / 2;

            push(bookingsRef, {
                name, phone, deviceType, specificDevice, roomType,
                startTime, duration, paymentMethod,
                depositAmount: deposit, status: 'pending_payment', createdAt: Date.now()
            }).then(() => {
                const fb = document.getElementById('booking-feedback');
                if (fb) { fb.style.display = 'block'; fb.style.color = 'var(--success)'; fb.innerText = 'تم تسجيل طلب الحجز بنجاح! يتم تحويلك الآن للواتساب لإعلامنا...'; }
                
                // Redirect to WhatsApp
                const msg = `مرحباً، قمت بحجز جديد وأريد تأكيده:\nالاسم: ${name}\nرقم الهاتف: ${phone}\nالمكان: ${roomType}\nالمدة: ${duration} ساعة\nوقت الحجز: ${new Date(startTime).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}\nطريقة الدفع: ${paymentMethod}`;
                const waUrl = `https://wa.me/201023402968?text=${encodeURIComponent(msg)}`;
                window.open(waUrl, '_blank');

                bookingForm.reset();
                updateTimeSlotsDropdown();
                const instrEl = document.getElementById('payment-instructions');
                if (instrEl) instrEl.style.display = 'none';
            }).catch(err => { console.error(err); alert('حدث خطأ، يرجى المحاولة لاحقاً.'); });
        });
    }
};
