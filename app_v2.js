// ==========================================
// app.js - Main UI Logic (Non-Module)
// Called by firebase-init.js after Firebase loads
// ==========================================

let db, auth, storage, ref, onValue, set, get, push, update,
    sRef, uploadBytes, getDownloadURL,
    signInWithEmailAndPassword, signOut, onAuthStateChanged;

let globalConsoles = [];
let globalBookings = [];
let globalDailyTotals = {};
let globalWeeklySnapshots = {};
let globalEmergencyMode = false;
let globalEmergencyStartTime = 0;
let globalBookingsEnabled = true; // يتحكم فيه الأدمين من لوحة التحكم

const PRICES = { PS4: 40, PS5: 60 };
const PAYMENT_NUMBERS = {
    vodafone: "01000000000"
};
// ملاحظة: تمت إزالة instapay من النظام بالكامل

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

function formatDuration(diff) {
    if (diff <= 0) return "00:00:00";
    const h = Math.floor(diff / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((diff % (1000 * 60)) / 1000);
    return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function getDayKey(timestamp) {
    if (!timestamp) return "حجوزات غير محددة التاريخ";
    const date = new Date(timestamp);
    let key = date.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    // Normalize: remove Arabic commas, collapse spaces, convert Eastern digits to Western
    key = key.replace(/،/g, '').replace(/\s+/g, ' ').trim();
    const easternDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    easternDigits.forEach((d, i) => { key = key.replace(new RegExp(d, 'g'), i); });
    // Normalize hamza variants (الإثنين ↔ الاثنين, etc.)
    key = key.replace(/الإثنين/g, 'الاثنين');
    return key;
}

function getWorkingDayBaseDate() {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (now.getHours() < 3) {
        base.setDate(base.getDate() - 1);
    }
    return base;
}

function getWorkingDayBaseDateFor(timestamp) {
    if (!timestamp) return getWorkingDayBaseDate();
    const date = new Date(timestamp);
    const base = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (date.getHours() < 3) {
        base.setDate(base.getDate() - 1);
    }
    return base;
}

function saveDailyTotalsFromBookings(bookings) {
    if (!bookings || bookings.length === 0) return;

    const daysToUpdate = {};
    bookings.forEach(b => {
        if (b.status === 'cancelled') return;
        const baseDate = getWorkingDayBaseDateFor(b.startTime);
        const dayKey = getDayKey(baseDate.getTime());

        if (!daysToUpdate[dayKey]) {
            daysToUpdate[dayKey] = {
                totalHours: 0,
                totalMoney: 0,
                count: 0,
                dayStartTimestamp: baseDate.getTime()
            };
        }

        daysToUpdate[dayKey].count++;
        if (b.status === 'approved' || b.status === 'active_in_store' || b.status === 'completed' || b.status === 'cancelled_noshow' || b.status === 'cancelled_with_fee') {
            const dur = b.duration === 'open' ? 0 : parseFloat(b.duration) || 0;
            daysToUpdate[dayKey].totalHours += dur;
            daysToUpdate[dayKey].totalMoney += (b.depositAmount || 0);
        }
    });

    // ✅ MAX-MERGE: نقرأ البيانات الموجودة أولاً، ونكتب الأكبر دائماً — لا شيء يُمسح
    Object.keys(daysToUpdate).forEach(dayKey => {
        const dtRef = ref(db, `daily_totals/${dayKey}`);
        const newData = daysToUpdate[dayKey];
        get(dtRef).then(snap => {
            const existing = snap.exists() ? snap.val() : null;
            const mergedHours = existing
                ? Math.max(parseFloat(existing.totalHours || 0), parseFloat(newData.totalHours.toFixed(2)))
                : parseFloat(newData.totalHours.toFixed(2));
            const mergedMoney = existing
                ? Math.max(parseInt(existing.totalMoney || 0), Math.ceil(newData.totalMoney))
                : Math.ceil(newData.totalMoney);
            const mergedCount = existing
                ? Math.max(parseInt(existing.count || 0), newData.count)
                : newData.count;

            return set(dtRef, {
                totalHours: mergedHours,
                totalMoney: mergedMoney,
                count: mergedCount,
                dayStartTimestamp: newData.dayStartTimestamp,
                lastUpdated: Date.now()
            });
        }).catch(err => {
            console.warn(`Failed to save daily totals for ${dayKey}:`, err);
        });
    });
}

// ✅ حفظ snapshot أسبوعي ثابت — يُستدعى عند أول تشغيل في أسبوع جديد
function maybeArchiveLastWeekSnapshot() {
    if (!db) return;
    const now = Date.now();
    const currentBase = getWorkingDayBaseDate();
    const dayOfWeek = currentBase.getDay(); // 0=Sun
    const sundayBase = new Date(currentBase.getTime());
    sundayBase.setDate(currentBase.getDate() - dayOfWeek);
    const startOfCurrentWeek = sundayBase.getTime();

    // مفتاح الأسبوع الحالي بصيغة YYYY-Www
    const weekKey = (() => {
        const d = new Date(startOfCurrentWeek);
        const year = d.getFullYear();
        const startOfYear = new Date(year, 0, 1);
        const weekNum = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
        return `${year}-W${weekNum.toString().padStart(2, '0')}`;
    })();

    const snapshotRef = ref(db, `weekly_snapshots/${weekKey}`);
    get(snapshotRef).then(snap => {
        // إذا الـ snapshot الأسبوع الحالي موجود، لا نفعل شيئاً
        if (snap.exists()) return;

        // احسب مجموع الأسبوع الماضي من daily_totals
        const lastWeekStart = startOfCurrentWeek - 7 * 24 * 3600 * 1000;
        let totalHours = 0;
        let totalMoney = 0;
        let totalCount = 0;

        Object.values(globalDailyTotals || {}).forEach(dt => {
            const ts = dt.dayStartTimestamp || 0;
            if (ts >= lastWeekStart && ts < startOfCurrentWeek) {
                totalHours += dt.totalHours || 0;
                totalMoney += dt.totalMoney || 0;
                totalCount += dt.count || 0;
            }
        });

        if (totalHours === 0 && totalMoney === 0) return; // لا نحفظ أسابيع فارغة

        const prevSundayDate = new Date(lastWeekStart);
        const prevSatDate = new Date(startOfCurrentWeek - 1);
        const label = `${prevSundayDate.toLocaleDateString('ar-EG', {day:'numeric',month:'short'})} – ${prevSatDate.toLocaleDateString('ar-EG', {day:'numeric',month:'short',year:'numeric'})}`;

        set(snapshotRef, {
            weekKey,
            label,
            totalHours: parseFloat(totalHours.toFixed(2)),
            totalMoney: Math.ceil(totalMoney),
            totalCount,
            weekStartTimestamp: lastWeekStart,
            savedAt: now
        }).catch(err => console.warn('Failed to save weekly snapshot:', err));
    });
}

function isSlotAvailable(startTime, durationRaw, deviceType, specificDevice, roomType) {
    const duration = durationRaw === 'open' ? 24 : parseFloat(durationRaw) || 1;
    const start = startTime;
    const end = startTime + duration * 3600 * 1000;

    // ❌ رفض أي حجز تمتد نهايته بعد وقت إغلاق المحل (3:00 صباحاً)
    if (durationRaw !== 'open') {
        const closingCheck = new Date(startTime);
        // إذا كان وقت البداية بعد الساعة 3 صباحاً نحسب الإغلاق لليوم التالي
        if (closingCheck.getHours() >= 3) {
            closingCheck.setDate(closingCheck.getDate() + 1);
        }
        closingCheck.setHours(3, 0, 0, 0);
        if (end > closingCheck.getTime()) return false;
    }
    
    const dbRoomName = roomType;
    const matchingDevices = globalConsoles.filter(c => c && c.type === deviceType && c.location === dbRoomName);
    const totalDevicesCount = matchingDevices.length;
    
    if (totalDevicesCount === 0) return false;

    let activeTimerConflicts = 0;
    let specificDeviceHasActiveConflict = false;

    matchingDevices.forEach(c => {
        if (c.activeTimer) {
            let devStart = c.activeTimer.startTime || Date.now();
            let devEnd;
            if (c.activeTimer.isOpen) {
                devEnd = devStart + 24 * 3600 * 1000;
            } else if (c.activeTimer.isPaused) {
                devEnd = Date.now() + (c.activeTimer.pausedTimeLeftMs || 0);
            } else {
                devEnd = c.activeTimer.endTime;
            }
            if (start < devEnd && end > devStart) {
                activeTimerConflicts++;
                if (specificDevice && specificDevice !== 'any' && c.name === specificDevice) {
                    specificDeviceHasActiveConflict = true;
                }
            }
        }
    });

    if (specificDeviceHasActiveConflict) return false;

    const overlappingBookings = globalBookings.filter(b => {
        if (b.status !== 'approved') return false;
        
        const bStart = b.startTime;
        const bDuration = b.duration === 'open' ? 24 : parseFloat(b.duration) || 1;
        const bEnd = bStart + bDuration * 3600 * 1000;
        return (start < bEnd && end > bStart);
    });

    if (specificDevice && specificDevice !== 'any') {
        const conflict = overlappingBookings.find(b => b.specificDevice === specificDevice);
        if (conflict) return false;
    }

    const conflictingBookings = overlappingBookings.filter(b => {
        if (b.deviceType !== deviceType) return false;
        if (b.specificDevice && b.specificDevice !== 'any') {
            const dev = globalConsoles.find(c => c && c.name === b.specificDevice);
            return dev && dev.location === dbRoomName;
        }
        return b.roomType === roomType;
    });

    if ((activeTimerConflicts + conflictingBookings.length) >= totalDevicesCount) {
        return false;
    }
    
    return true;
}

// Check if a device has all remaining today's slots booked (or is manually busy)
function isDeviceFullyBooked(device) {
    if (!device) return false;

    // إذا كان الجهاز مشغولاً يدوياً بدون عداد → لا توجد مواعيد متاحة
    if (device.status === 'busy' && !device.activeTimer) return true;

    // إذا كان العداد مفتوحاً (لا نهاية محددة) → الجهاز محجوز بالكامل
    if (device.activeTimer && device.activeTimer.isOpen && !device.activeTimer.isGracePeriod) return true;

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
        // إذا كان أي وقت متاح للجهاز → ليس محجوزاً بالكامل → نُظهر الزر
        if (isSlotAvailable(slotTime, 1, device.type, device.name, device.location)) {
            return false;
        }
    }

    // محجوز بالكامل فقط إذا كانت هناك فترات مستقبلية وجميعها مأخوذة
    return hasFutureSlots;
}

function getDeviceHourlyStatus(device) {
    const base = getWorkingDayBaseDate();
    const now = Date.now();
    const statuses = [];

    // If it is after 2:00 AM (the final hour before the shop officially closes at 3:00 AM),
    // all today's slots have passed. So we shift the strip to show tomorrow's status.
    if (new Date(now).getHours() === 2) {
        base.setDate(base.getDate() + 1);
    }

    for (let H = 12; H <= 26; H += 0.5) {
        const slotDate = new Date(base.getTime());
        let hour = Math.floor(H);
        let minute = (H % 1 === 0.5) ? 30 : 0;
        if (hour >= 24) {
            slotDate.setDate(slotDate.getDate() + 1);
            hour -= 24;
        }
        slotDate.setHours(hour, minute, 0, 0);
        const slotStart = slotDate.getTime();
        const slotEnd = slotStart + 1800 * 1000; // 30 minutes in milliseconds

        const isPast = slotEnd <= now;

        let isBooked = false;

        // التحقق من العداد النشط على الجهاز
        if (device.activeTimer) {
            const timerStart = device.activeTimer.startTime || now;
            if (device.activeTimer.isOpen && !device.activeTimer.isGracePeriod) {
                // عداد مفتوح → كل الأوقات من البداية محجوزة
                if (slotStart >= timerStart) isBooked = true;
            } else if (device.activeTimer.endTime) {
                if (slotStart < device.activeTimer.endTime && slotEnd > timerStart) isBooked = true;
            }
        }

        // التحقق من الحجوزات المرتبطة بهذا الجهاز
        // pending_payment يُظهر الوقت محجوزاً فوراً بمجرد تسجيل الطلب
        // التحقق من الحجوزات المرتبطة بهذا الجهاز (سواء صريحة أو عائمة)
        if (!isBooked) {
            const dName = (device.name || '').trim();
            const overlappingBookings = globalBookings.filter(b => {
                if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
                const bStart = Number(b.actualStartTime || b.startTime);
                const bDuration = b.duration === 'open' ? 24 : parseFloat(b.duration) || 1;
                const bEnd = bStart + bDuration * 3600 * 1000;
                // Add a small 1-minute margin to ensure overlap detection is generous
                return (slotStart < bEnd - 60000 && slotEnd > bStart + 60000);
            });

            // هل الجهاز محجوز بشكل صريح؟
            isBooked = overlappingBookings.some(b => {
                const bDevice = (b.specificDevice || '').trim().toLowerCase();
                const dNameLower = dName.toLowerCase();
                // مقارنة قوية لتجنب أي اختلافات في المسافات أو حالة الحروف
                return bDevice === dNameLower || (bDevice !== 'any' && dNameLower.includes(bDevice));
            });

            // لو مش محجوز بشكل صريح، نوزع الحجوزات العائمة على الأجهزة المتاحة
            if (!isBooked) {
                const floatingBookings = overlappingBookings.filter(b => {
                    const bDevice = (b.specificDevice || '').trim();
                    return (!bDevice || bDevice === 'any') && b.roomType === device.location && b.deviceType === device.type;
                });

                if (floatingBookings.length > 0) {
                    const devicesInRoom = globalConsoles.filter(c => c && c.location === device.location && c.type === device.type);
                    
                    const unbookedDevices = devicesInRoom.filter(c => {
                        const cName = (c.name || '').trim();
                        if (c.activeTimer) {
                            const timerStart = c.activeTimer.startTime || now;
                            if (c.activeTimer.isOpen && !c.activeTimer.isGracePeriod) {
                                if (slotStart >= timerStart) return false;
                            } else if (c.activeTimer.endTime) {
                                if (slotStart < c.activeTimer.endTime && slotEnd > timerStart) return false;
                            }
                        }
                        return !overlappingBookings.some(b => (b.specificDevice || '').trim() === cName);
                    });

                    // إذا كان الجهاز من ضمن الأجهزة التي سيقع عليها الحجز العائم
                    const myIndexInUnbooked = unbookedDevices.findIndex(c => (c.name || '').trim() === dName);
                    if (myIndexInUnbooked !== -1 && myIndexInUnbooked < floatingBookings.length) {
                        isBooked = true;
                    }
                }
            }
        }

        // Label
        let label;
        let labelHour = hour;
        if (hour === 0) labelHour = 12;
        else if (hour > 12) labelHour = hour - 12;

        if (minute === 30) {
            label = `${labelHour}:30`;
        } else {
            label = labelHour.toString();
        }

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
    
    // Collect all slot times (fixed + dynamic from existing bookings)
    const slotTimesSet = new Set();
    
    // Add "Now" slot if the shop is currently open
    const nowTime = Date.now();
    const baseToday = base;
    const startOfToday = baseToday.getTime() + 12 * 3600 * 1000;
    const endOfToday = baseToday.getTime() + 27 * 3600 * 1000;
    if (nowTime >= startOfToday && nowTime < endOfToday) {
        slotTimesSet.add(nowTime);
    }
    
    // 1. Fixed half-hour slots (12 PM to 2:30 AM) for Today and Tomorrow
    const baseTomorrow = new Date(base.getTime());
    baseTomorrow.setDate(baseTomorrow.getDate() + 1);

    [baseToday, baseTomorrow].forEach(bDate => {
        for (let H = 12; H <= 26.5; H += 0.5) {
            const slotDate = new Date(bDate.getTime());
            let hour = Math.floor(H);
            let minute = (H % 1 === 0.5) ? 30 : 0;
            if (hour >= 24) {
                slotDate.setDate(slotDate.getDate() + 1);
                hour -= 24;
            }
            slotDate.setHours(hour, minute, 0, 0);
            slotTimesSet.add(slotDate.getTime());
        }
    });

    globalBookings.forEach(b => {
        if (b.status === 'approved' || b.status === 'active_in_store') {
            // Only collect end times of bookings that match the selected room and device type
            if (b.roomType !== roomType || b.deviceType !== deviceType) {
                return;
            }
            // If a specific device is selected in the booking form, filter out bookings on other specific devices
            if (specificDevice && specificDevice !== 'any') {
                if (b.specificDevice !== 'any' && b.specificDevice !== specificDevice) {
                    return;
                }
            }
            const bStart = b.startTime; // Use scheduled startTime to avoid shifting
            const bDuration = b.duration === 'open' ? 24 : b.duration;
            const bEnd = bStart + bDuration * 3600 * 1000;
            if (bEnd >= Date.now()) {
                slotTimesSet.add(bEnd);
            }
        }
    });

    // Add active timer end times as available slots (e.g. if timer extended to 11:35, add 11:35 as a slot)
    globalConsoles.forEach(c => {
        if (!c || c.type !== deviceType || c.location !== roomType) return;
        if (specificDevice && specificDevice !== 'any' && c.name !== specificDevice) return;
        if (c.activeTimer) {
            let timerEnd;
            if (c.activeTimer.isOpen) return; // open session has no defined end
            if (c.activeTimer.isPaused) {
                timerEnd = Date.now() + (c.activeTimer.pausedTimeLeftMs || 0);
            } else {
                timerEnd = c.activeTimer.endTime;
            }
            if (timerEnd && timerEnd > Date.now()) {
                slotTimesSet.add(timerEnd);
            }
        }
    });

    // Sort the times
    const sortedSlotTimes = Array.from(slotTimesSet).sort((a, b) => a - b);

    sortedSlotTimes.forEach(slotTime => {
        // Don't show past slots, but allow "Now" slot
        if (slotTime !== nowTime && slotTime < Date.now() - 10000) {
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

        // Determine Day Label
        let dayLabel = 'اليوم';
        const slotWorkingDate = new Date(slotTime);
        if (slotWorkingDate.getHours() < 3) {
            slotWorkingDate.setDate(slotWorkingDate.getDate() - 1);
        }
        slotWorkingDate.setHours(0,0,0,0);
        
        if (slotWorkingDate.getTime() > baseToday.getTime()) {
            dayLabel = 'غداً';
        }

        let labelStr = `${dayLabel} - ${labelHour.toString().padStart(2, '0')}:${minuteStr} ${period}`;
        
        if (slotTime === nowTime) {
            labelStr = `اليوم - الآن (${labelHour.toString().padStart(2, '0')}:${minuteStr} ${period})`;
        }
        
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
        let fullyBooked = isDeviceFullyBooked(c);
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

        const dName = (c.name || '').trim();
        let debugStr = '';
        globalBookings.forEach(b => {
            if ((b.specificDevice || '').trim() === dName && (b.status === 'approved' || b.status === 'active_in_store')) {
                const bStart = new Date(b.startTime).toLocaleString('en-US', {hour:'numeric', minute:'numeric'});
                const isOverlap = b.startTime <= Date.now() + 86400000;
                debugStr += `<div style="font-size:10px; color:#aaa;">Booking: ${bStart} (${b.duration}h) | Overlaps: ${isOverlap}</div>`;
            }
        });

        let timerDisplay = '';
        if (c.activeTimer) {
            if (c.activeTimer.isPaused) {
                const displayVal = c.activeTimer.isOpen 
                    ? formatDuration(c.activeTimer.pausedElapsedMs)
                    : formatDuration(c.activeTimer.pausedTimeLeftMs);
                timerDisplay = `<div class="public-timer" data-ispaused="true" style="margin-top:10px;font-weight:bold;color:#ffc400;font-family:'Orbitron',sans-serif;">${displayVal} (موقوف)</div>`;
            } else if (c.activeTimer.isOpen && !c.activeTimer.isGracePeriod) {
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
            if (c.activeTimer.isPaused) {
                const displayVal = c.activeTimer.isOpen 
                    ? formatDuration(c.activeTimer.pausedElapsedMs)
                    : formatDuration(c.activeTimer.pausedTimeLeftMs);
                timerDisplay = `<div class="timer-display" data-ispaused="true" style="color:#ffc400;">${displayVal} (موقوف)</div>`;
            } else if (c.activeTimer.isOpen && !c.activeTimer.isGracePeriod) {
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
                    ${c.activeTimer ? (
                        c.activeTimer.isPaused 
                            ? `<button class="btn btn-small btn-warning" onclick="window.resumeDeviceTimer(${index})" style="background: #1b5e20; border-color: #00e676;">استئناف</button>`
                            : `<button class="btn btn-small btn-warning" onclick="window.pauseDeviceTimer(${index})" style="background: #e65100; border-color: #ff6d00;">إيقاف مؤقت</button>`
                    ) : ''}
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

    if (validBookings.length === 0 && Object.keys(globalDailyTotals).length === 0) {
        container.innerHTML = '<p class="text-muted">لا توجد حجوزات حالياً.</p>';
        return;
    }
    
    // Sort bookings by startTime descending
    const sorted = [...validBookings].sort((a, b) => b.startTime - a.startTime);
    
    // Group bookings by day
    const groups = {};
    sorted.forEach(b => {
        const baseDate = getWorkingDayBaseDateFor(b.startTime);
        const dayKey = getDayKey(baseDate.getTime());
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
        'cancelled_with_fee': '<span style="color:var(--danger)">ملغى (غير مسترد)</span>',
        'active_in_store': '<span style="color:var(--success)">نشط الآن</span>',
        'completed': '<span style="color:var(--text-muted)">مكتمل</span>'
    };
    
    // Merge day keys from groups and globalDailyTotals
    const allDayKeys = new Set(Object.keys(groups));
    Object.keys(globalDailyTotals).forEach(dayKey => {
        allDayKeys.add(dayKey);
    });

    const getDayTimestamp = (dayKey) => {
        if (globalDailyTotals[dayKey] && globalDailyTotals[dayKey].dayStartTimestamp) {
            return globalDailyTotals[dayKey].dayStartTimestamp;
        }
        if (groups[dayKey] && groups[dayKey].length > 0) {
            const baseDate = getWorkingDayBaseDateFor(groups[dayKey][0].startTime);
            return baseDate.getTime();
        }
        return 0;
    };

    // Sort day keys chronologically descending (newest/today's date on top, older dates below)
    const sortedDayKeys = Array.from(allDayKeys).sort((a, b) => {
        return getDayTimestamp(b) - getDayTimestamp(a);
    });

    sortedDayKeys.forEach(dayKey => {
        const bookingsInDay = groups[dayKey];
        if (!bookingsInDay || bookingsInDay.length === 0) return; // Skip rendering empty/archived days in the accordion

        const folder = document.createElement('div');
        folder.className = 'day-folder';
        
        let dayTotalHours = 0;
        let dayTotalMoney = 0;
        let bookingsCount = 0;

        if (bookingsInDay) {
            bookingsInDay.forEach(b => {
                if (b.status === 'approved' || b.status === 'active_in_store' || b.status === 'completed' || b.status === 'cancelled_noshow' || b.status === 'cancelled_with_fee') {
                    const dur = b.duration === 'open' ? 0 : parseFloat(b.duration) || 0;
                    dayTotalHours += dur;
                    dayTotalMoney += (b.depositAmount || 0);
                }
            });
            bookingsCount = bookingsInDay.length;
        } else if (globalDailyTotals[dayKey]) {
            dayTotalHours = globalDailyTotals[dayKey].totalHours || 0;
            dayTotalMoney = globalDailyTotals[dayKey].totalMoney || 0;
            bookingsCount = globalDailyTotals[dayKey].count || 0;
        }
        
        // Header
        const header = document.createElement('div');
        header.className = 'day-folder-header';
        header.innerHTML = `
            <i class="fas fa-folder-open folder-icon"></i>
            <span>${dayKey} ${bookingsInDay ? '' : '<span style="font-size: 0.8rem; opacity: 0.7; color: var(--accent-neon);">(مؤرشف)</span>'}</span>
            <span class="count-badge">${bookingsCount} حجز | ${dayTotalHours} س | ${dayTotalMoney} ج</span>
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
        
        if (bookingsInDay) {
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
                    const card = document.createElement('div');
                    card.className = 'booking-card';
                    card.innerHTML = `
                        <h4>${b.name}</h4>
                        <p><strong>رقم الهاتف:</strong> <a href="tel:${b.phone || ''}" style="color: var(--accent-neon); text-decoration: none; font-weight: bold;">${b.phone || 'غير مسجل'}</a> ${b.phone ? `<a href="https://wa.me/${b.phone.startsWith('0') ? '20' + b.phone.substring(1) : b.phone}" target="_blank" style="margin-right: 15px; color: #25D366; text-decoration: none; font-weight: bold;"><i class="fab fa-whatsapp"></i> واتساب</a>` : ''}</p>
                        <p><strong>موعد الحجز:</strong> ${new Date(b.startTime).toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'})}</p>
                        <p><strong>مدة الحجز:</strong> ${b.duration === 'open' ? 'مفتوح' : b.duration + ' ساعة'}</p>
                        <p><strong>طريقة الدفع:</strong> ${b.paymentMethod === 'vodafone' ? 'فودافون كاش' : 'في المحل'} ${b.depositAmount > 0 ? `(مبلغ الحجز: ${b.depositAmount} ج)` : ''}</p>
                        <p><strong>وضع اللعب:</strong> ${b.playMode === 'multi' ? 'مالتي (4 أفراد)' : 'فردي/زوجي'}</p>
                        <p><strong>الحالة:</strong> ${statusMap[b.status] || b.status}</p>
                        ${b.userPhotoUrl ? `
                        <div style="margin: 10px 0;">
                            <p style="color: var(--accent-neon); font-weight: bold; margin-bottom: 6px;"><i class="fas fa-id-badge"></i> صورة شخصية:</p>
                            <a href="${b.userPhotoUrl}" target="_blank">
                                <img src="${b.userPhotoUrl}" alt="صورة العميل" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; border: 2px solid var(--accent-neon); cursor: pointer;">
                            </a>
                        </div>` : ''}
                        ${b.receiptUrl ? `
                        <div style="margin: 10px 0;">
                            <p style="color: #4CAF50; font-weight: bold; margin-bottom: 6px;"><i class="fas fa-receipt"></i> إيصال فودافون كاش:</p>
                            <a href="${b.receiptUrl}" target="_blank">
                                <img src="${b.receiptUrl}" alt="إيصال التحويل" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; border: 2px solid #4CAF50; cursor: pointer;">
                            </a>
                        </div>` : ''}
                        
                        <div class="booking-actions">
                            ${b.delayedByMs ? `<button class="btn btn-small btn-warning" onclick="window.notifyDelay('${b.id}')" style="background: #ff9800; border: none; color: #fff; margin-left: 5px;"><i class="fab fa-whatsapp"></i> إشعار التأخير</button>` : ''}
                            ${b.status === 'pending_payment' ? `<button class="btn btn-small btn-success" onclick="window.approveBooking('${b.id}')">تأكيد الدفع</button>` : ''}
                            ${b.status !== 'cancelled' && b.status !== 'cancelled_noshow' && b.status !== 'cancelled_with_fee' && b.status !== 'completed' ? `<button class="btn btn-small btn-danger" onclick="window.cancelBooking('${b.id}')">إلغاء الحجز</button>` : ''}
                        </div>
                    `;
                    content.appendChild(card);
                });
            });
        }
        
        folder.appendChild(header);
        folder.appendChild(content);
        container.appendChild(folder);
    });
    
    // ─── حساب الإحصائيات من globalDailyTotals ───────────────────────
    let currentWeekHours = 0;
    let currentWeekMoney = 0;
    let lastWeekHours    = 0;
    let lastWeekMoney    = 0;

    const currentBase   = getWorkingDayBaseDate();
    const dayOfWeek     = currentBase.getDay(); // 0=Sun
    const sundayBase    = new Date(currentBase.getTime());
    sundayBase.setDate(currentBase.getDate() - dayOfWeek);
    const startOfCurrentWeek = sundayBase.getTime();
    const startOfLastWeek    = startOfCurrentWeek - 7 * 24 * 3600 * 1000;

    const curMonth  = currentBase.getMonth();
    const curYear   = currentBase.getFullYear();
    let   monthHours = 0, monthMoney = 0;
    let   lastMonth  = curMonth - 1, lastYear = curYear;
    if (lastMonth < 0) { lastMonth = 11; lastYear -= 1; }
    let   prevMonthHours = 0, prevMonthMoney = 0;
    const monthlySummaries = {};

    // normalise Arabic keys
    const normalizedTotals = {};
    Object.keys(globalDailyTotals).forEach(dayKey => {
        const dt = globalDailyTotals[dayKey];
        if (!dt) return;
        let nk = dayKey.replace(/،/g, '').replace(/\s+/g, ' ').trim();
        ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'].forEach((c,i) => {
            nk = nk.replace(new RegExp(c,'g'), i);
        });
        nk = nk.replace(/الإثنين/g,'الاثنين');
        if (!normalizedTotals[nk]) {
            normalizedTotals[nk] = dt;
        } else {
            const ex = normalizedTotals[nk];
            if ((dt.lastUpdated||0) > (ex.lastUpdated||0) ||
                ((dt.lastUpdated||0) === (ex.lastUpdated||0) && (dt.totalMoney||0) > (ex.totalMoney||0))) {
                normalizedTotals[nk] = dt;
            }
        }
    });

    Object.values(normalizedTotals).forEach(dt => {
        const ts = dt.dayStartTimestamp;
        if (!ts) return;
        const d = new Date(ts);

        if (ts >= startOfCurrentWeek)                          { currentWeekHours += dt.totalHours||0; currentWeekMoney += dt.totalMoney||0; }
        if (ts >= startOfLastWeek && ts < startOfCurrentWeek) { lastWeekHours    += dt.totalHours||0; lastWeekMoney    += dt.totalMoney||0; }
        if (d.getMonth()===curMonth  && d.getFullYear()===curYear)   { monthHours     += dt.totalHours||0; monthMoney     += dt.totalMoney||0; }
        if (d.getMonth()===lastMonth && d.getFullYear()===lastYear)  { prevMonthHours += dt.totalHours||0; prevMonthMoney += dt.totalMoney||0; }

        const mKey = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}`;
        if (!monthlySummaries[mKey]) {
            monthlySummaries[mKey] = { hours:0, money:0, label: d.toLocaleDateString('ar-EG',{year:'numeric',month:'long'}) };
        }
        monthlySummaries[mKey].hours += dt.totalHours||0;
        monthlySummaries[mKey].money += dt.totalMoney||0;
    });

    // ─── الأرشيف الأسبوعي المحمي (weekly_snapshots) ──────────────────
    const sortedSnapKeys = Object.keys(globalWeeklySnapshots).sort((a,b) => b.localeCompare(a));
    let weeklyArchiveHtml = '';
    if (sortedSnapKeys.length === 0) {
        weeklyArchiveHtml = '<p class="text-muted" style="text-align:center;padding:10px 0;">لا توجد أسابيع مؤرشفة بعد — سيبدأ الأرشيف تلقائياً مع الأسبوع القادم.</p>';
    } else {
        sortedSnapKeys.forEach(wk => {
            const s = globalWeeklySnapshots[wk];
            weeklyArchiveHtml += `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px dashed var(--glass-border);gap:10px;">
                    <span style="color:#a0a0a0;font-size:0.85rem;white-space:nowrap;">
                        <i class="fas fa-lock" style="color:#ffc400;font-size:0.7rem;margin-left:4px;"></i>${s.label || wk}
                    </span>
                    <span style="white-space:nowrap;">
                        <span style="color:#fff;font-weight:bold;">${(s.totalHours||0).toFixed(1)} س</span>
                        &nbsp;|&nbsp;
                        <span style="color:var(--success);font-weight:bold;">${s.totalMoney||0} ج.م</span>
                    </span>
                </div>`;
        });
    }

    // ─── الأرشيف الشهري ──────────────────────────────────────────────
    const sortedMonthKeys = Object.keys(monthlySummaries).sort((a,b) => b.localeCompare(a));
    let monthlyListHtml = '';
    if (sortedMonthKeys.length === 0) {
        monthlyListHtml = '<p class="text-muted" style="text-align:center;padding:10px 0;">لا توجد شهور مؤرشفة بعد.</p>';
    } else {
        sortedMonthKeys.forEach(mKey => {
            const s = monthlySummaries[mKey];
            monthlyListHtml += `
                <div style="display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px dashed var(--glass-border);">
                    <strong style="color:var(--accent-neon);">${s.label}</strong>
                    <span>${s.hours.toFixed(1)} س | <span style="color:var(--success);font-weight:bold;">${s.money} ج.م</span></span>
                </div>`;
        });
    }

    // ─── رسم اللوحة ──────────────────────────────────────────────────
    const statsPanel = document.createElement('div');
    statsPanel.className = 'glass-panel';
    statsPanel.style.cssText = 'margin-top:30px;border:1px solid rgba(0,210,255,0.2);padding:20px;';
    statsPanel.innerHTML = `
        <h3 style="color:var(--accent-neon);margin-bottom:20px;font-size:1.3rem;text-align:center;">
            <i class="fas fa-chart-line"></i> تقارير الأرباح والساعات
        </h3>

        <!-- بطاقات الملخص -->
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-bottom:25px;">
            <div style="background:rgba(0,210,255,0.07);padding:12px 18px;border-radius:10px;border:1px solid rgba(0,210,255,0.35);min-width:140px;text-align:center;flex:1;">
                <span style="font-size:0.85rem;color:var(--accent-neon);display:block;margin-bottom:5px;font-weight:bold;">الأسبوع الحالي</span>
                <span style="font-size:1.3rem;color:#fff;font-weight:bold;">${currentWeekHours.toFixed(1)} س</span>
                <span style="font-size:1.2rem;color:var(--success);font-weight:bold;display:block;margin-top:3px;">${currentWeekMoney} ج.م</span>
            </div>
            <div style="background:rgba(0,210,255,0.04);padding:12px 18px;border-radius:10px;border:1px solid rgba(0,210,255,0.2);min-width:140px;text-align:center;flex:1;position:relative;">
                <span style="font-size:0.85rem;color:var(--accent-neon);display:block;margin-bottom:5px;font-weight:bold;">
                    الأسبوع الماضي
                    ${lastWeekHours===0&&lastWeekMoney===0&&sortedSnapKeys.length>0?'<span style="font-size:0.7rem;color:#ffc400;margin-right:4px;">(من الأرشيف)</span>':''}
                </span>
                <span style="font-size:1.3rem;color:#fff;font-weight:bold;">
                    ${(lastWeekHours>0||lastWeekMoney>0) ? lastWeekHours.toFixed(1) : (sortedSnapKeys[0]?(globalWeeklySnapshots[sortedSnapKeys[0]].totalHours||0).toFixed(1):'—')} س
                </span>
                <span style="font-size:1.2rem;color:var(--success);font-weight:bold;display:block;margin-top:3px;">
                    ${(lastWeekHours>0||lastWeekMoney>0) ? lastWeekMoney : (sortedSnapKeys[0]?(globalWeeklySnapshots[sortedSnapKeys[0]].totalMoney||0):'—')} ج.م
                </span>
            </div>
            <div style="background:rgba(0,230,118,0.05);padding:12px 18px;border-radius:10px;border:1px solid rgba(0,230,118,0.3);min-width:140px;text-align:center;flex:1;">
                <span style="font-size:0.85rem;color:var(--success);display:block;margin-bottom:5px;font-weight:bold;">الشهر الحالي</span>
                <span style="font-size:1.3rem;color:#fff;font-weight:bold;">${monthHours.toFixed(1)} س</span>
                <span style="font-size:1.2rem;color:var(--success);font-weight:bold;display:block;margin-top:3px;">${monthMoney} ج.م</span>
            </div>
            <div style="background:rgba(255,196,0,0.05);padding:12px 18px;border-radius:10px;border:1px solid rgba(255,196,0,0.3);min-width:140px;text-align:center;flex:1;">
                <span style="font-size:0.85rem;color:#ffc400;display:block;margin-bottom:5px;font-weight:bold;">الشهر الماضي</span>
                <span style="font-size:1.3rem;color:#fff;font-weight:bold;">${prevMonthHours.toFixed(1)} س</span>
                <span style="font-size:1.2rem;color:var(--success);font-weight:bold;display:block;margin-top:3px;">${prevMonthMoney} ج.م</span>
            </div>
        </div>

        <!-- أرشيف أسبوعي محمي -->
        <h4 style="color:#fff;margin-bottom:10px;font-size:1rem;border-bottom:1px solid var(--glass-border);padding-bottom:6px;">
            <i class="fas fa-shield-alt" style="color:#ffc400;"></i> الأرشيف الأسبوعي المحمي
            <span style="font-size:0.75rem;color:#a0a0a0;margin-right:8px;">— لا يتأثر بحذف الحجوزات</span>
        </h4>
        <div style="max-height:160px;overflow-y:auto;font-size:0.92rem;margin-bottom:20px;">
            ${weeklyArchiveHtml}
        </div>

        <!-- أرشيف شهري -->
        <h4 style="color:#fff;margin-bottom:10px;font-size:1rem;border-bottom:1px solid var(--glass-border);padding-bottom:6px;">
            <i class="fas fa-history"></i> الأرشيف الشهري
        </h4>
        <div style="max-height:160px;overflow-y:auto;font-size:0.92rem;">
            ${monthlyListHtml}
        </div>
    `;
    container.appendChild(statsPanel);
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
    
    let finalPricePerHour = PRICES[deviceType] || 40;
    if (playMode === 'multi') finalPricePerHour = 50;
    
    // Check if the device is already running (busy) and has an active timer
    const isAlreadyBusy = c.status === 'busy' && c.activeTimer && c.activeTimer.endTime > Date.now();
    
    if (isAlreadyBusy) {
        if (isOpen) {
            alert("الجهاز قيد التشغيل بالفعل ولا يمكن تفعيل عداد مفتوح عليه أثناء عمله.");
            return;
        }
        
        // We want to EXTEND the running timer!
        const existingBookingId = c.activeTimer.bookingId;
        const durationMs = (h * 3600 + m * 60) * 1000;
        const newEndTime = c.activeTimer.endTime + durationMs;
        const durationHoursAdded = h + (m / 60);
        
        // Check if the extension causes an overlap/conflict with upcoming bookings
        const overlappingBookings = globalBookings.filter(b => {
            if (b.id === existingBookingId) return false;
            if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
            
            const bStart = b.startTime;
            const bDuration = b.duration === 'open' ? 24 : b.duration;
            const bEnd = bStart + bDuration * 3600 * 1000;
            return (Date.now() < bEnd && newEndTime > bStart);
        });
        
        // Look for specific device conflict
        const specificConflict = overlappingBookings.find(b => b.specificDevice === c.name);
        if (specificConflict) {
            const timeStr = new Date(specificConflict.startTime).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
            alert(`تعذر تمديد الوقت: الجهاز محجوز بالفعل للعميل (${specificConflict.name}) يبدأ الساعة ${timeStr}`);
            return;
        }
        
        // Update console
        updateConsoleField(index, {
            status: 'busy',
            activeTimer: { 
                ...c.activeTimer,
                endTime: newEndTime, 
                durationMinutes: c.activeTimer.durationMinutes ? (c.activeTimer.durationMinutes + h * 60 + m) : (h * 60 + m)
            }
        });
        
        // Update booking in database
        if (existingBookingId) {
            get(ref(db, `bookings/${existingBookingId}`)).then(snap => {
                if (snap.exists()) {
                    const booking = snap.val();
                    const newDuration = booking.duration === 'open' ? 'open' : (parseFloat(booking.duration) || 0) + durationHoursAdded;
                    let pricePerHour = PRICES[booking.deviceType] || 40;
                    if (booking.playMode === 'multi') pricePerHour = 50;
                    const newDeposit = newDuration === 'open' ? booking.depositAmount : pricePerHour * newDuration;
                    
                    update(ref(db, `bookings/${existingBookingId}`), {
                        duration: newDuration,
                        depositAmount: newDeposit
                    });
                }
            });
        }
        
        // Clear input values
        document.getElementById(`hours-${index}`).value = 0;
        document.getElementById(`mins-${index}`).value = 0;
        return;
    }
    
    // Normal start timer logic: check for conflicts first
    let durationHours, totalAmount, endTime;
    
    if (isOpen) {
        durationHours = 'open';
        totalAmount = finalPricePerHour / 2; // عربون ساعة
        endTime = null;
        
        // Check for any upcoming booking today on this device
        const baseWorkingDate = getWorkingDayBaseDate();
        const storeClosingTime = baseWorkingDate.getTime() + 27 * 3600 * 1000; // 3 AM next day
        
        const upcomingBooking = globalBookings.find(b => {
            if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
            if (b.specificDevice !== c.name) return false;
            return (b.startTime > Date.now() && b.startTime < storeClosingTime);
        });
        
        if (upcomingBooking) {
            const timeStr = new Date(upcomingBooking.startTime).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
            alert(`تعذر بدء العداد المفتوح: الجهاز محجوز اليوم للعميل (${upcomingBooking.name}) يبدأ الساعة ${timeStr}`);
            return;
        }
    } else {
        const durationMs = (h * 3600 + m * 60) * 1000;
        durationHours = h + (m / 60);
        endTime = Date.now() + durationMs;
        totalAmount = finalPricePerHour * durationHours;
        
        // Check for conflicts with this duration
        const overlappingBookings = globalBookings.filter(b => {
            if (b.status !== 'approved' && b.status !== 'active_in_store') return false;
            
            const bStart = b.startTime;
            const bDuration = b.duration === 'open' ? 24 : b.duration;
            const bEnd = bStart + bDuration * 3600 * 1000;
            return (Date.now() < bEnd && endTime > bStart);
        });
        
        // Look for specific device conflict
        const specificConflict = overlappingBookings.find(b => b.specificDevice === c.name);
        if (specificConflict) {
            const timeStr = new Date(specificConflict.startTime).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
            alert(`تعذر بدء العداد: الجهاز محجوز بالفعل للعميل (${specificConflict.name}) يبدأ الساعة ${timeStr}`);
            return;
        }
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
        
        // Clear input values
        document.getElementById(`hours-${index}`).value = 0;
        document.getElementById(`mins-${index}`).value = 0;
    }).catch(err => {
        console.error("Failed to create walk-in booking:", err);
        updateConsoleField(index, {
            status: 'busy',
            activeTimer: { endTime, durationMinutes: isOpen ? null : h * 60 + m }
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

window.pauseDeviceTimer = function(index) {
    const c = globalConsoles[index];
    if (!c || !c.activeTimer || c.activeTimer.isPaused) return;
    
    const now = Date.now();
    let updates = {
        isPaused: true,
        pausedAt: now
    };
    
    if (c.activeTimer.isOpen) {
        updates.pausedElapsedMs = now - c.activeTimer.startTime;
    } else {
        updates.pausedTimeLeftMs = c.activeTimer.endTime - now;
    }
    
    updateConsoleField(index, {
        activeTimer: {
            ...c.activeTimer,
            ...updates
        }
    });
};

window.resumeDeviceTimer = function(index, skipShifting = false) {
    const c = globalConsoles[index];
    if (!c || !c.activeTimer || !c.activeTimer.isPaused) return;
    
    const now = Date.now();
    let updates = {};
    
    if (c.activeTimer.isOpen) {
        const pausedElapsedMs = c.activeTimer.pausedElapsedMs || 0;
        updates.startTime = now - pausedElapsedMs;
    } else {
        const pausedTimeLeftMs = c.activeTimer.pausedTimeLeftMs || 0;
        updates.endTime = now + pausedTimeLeftMs;
        // Keep visual duration correct if it was set
        if (c.activeTimer.startTime && c.activeTimer.durationMinutes) {
            updates.startTime = now - (c.activeTimer.durationMinutes * 60000 - pausedTimeLeftMs);
        }
    }
    
    // Prepare active timer copy
    const activeTimerCopy = { ...c.activeTimer, ...updates };
    delete activeTimerCopy.isPaused;
    delete activeTimerCopy.pausedTimeLeftMs;
    delete activeTimerCopy.pausedElapsedMs;

    if (db && c.activeTimer.pausedAt && !skipShifting) {
        const lastOccupied = activeTimerCopy.isOpen ? now : (activeTimerCopy.endTime || now);
        window.shiftOverlappingBookings(c.name, lastOccupied);
    }
    
    delete activeTimerCopy.pausedAt;
    
    updateConsoleField(index, {
        activeTimer: activeTimerCopy
    });
};

window.shiftOverlappingBookings = function(deviceName, initialOccupiedTimeMs) {
    if (!db || !globalBookings || !deviceName) return 0;
    const currentWorkingDay = getWorkingDayBaseDateFor(Date.now()).getTime();
    
    // Get all approved bookings for this device today, sorted by start time
    const deviceBookings = globalBookings.filter(b => 
        b.status === 'approved' && 
        b.specificDevice === deviceName &&
        getWorkingDayBaseDateFor(b.startTime).getTime() === currentWorkingDay
    ).sort((a, b) => a.startTime - b.startTime);

    let lastOccupiedTime = initialOccupiedTimeMs;
    let shiftedCount = 0;
    
    deviceBookings.forEach(b => {
        if (b.startTime < lastOccupiedTime) {
            const shiftMs = lastOccupiedTime - b.startTime;
            const newStartTime = lastOccupiedTime;
            update(ref(db, `bookings/${b.id}`), { 
                startTime: newStartTime, 
                delayedByMs: (b.delayedByMs || 0) + shiftMs 
            });
            shiftedCount++;
            const bDur = b.duration === 'open' ? 24 : parseFloat(b.duration) || 1;
            lastOccupiedTime = newStartTime + (bDur * 3600 * 1000);
        } else {
            const bDur = b.duration === 'open' ? 24 : parseFloat(b.duration) || 1;
            lastOccupiedTime = b.startTime + (bDur * 3600 * 1000);
        }
    });
    return shiftedCount;
};

window.notifyDelay = function(id) {
    const b = globalBookings.find(x => x.id === id);
    if (!b) return;
    const newTime = new Date(b.startTime).toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'});
    let phone = b.phone || '';
    if (phone.startsWith('0')) phone = '20' + phone.substring(1);
    const msg = `نعتذر لك، بسبب انقطاع التيار الكهربائي الطارئ، تم ترحيل موعد حجزك ليكون في تمام الساعة ${newTime}. نأسف للإزعاج وننتظرك!`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    if (db) update(ref(db, `bookings/${id}`), { delayedByMs: null });
};

window.emergencyPauseAll = function() {
    let pausedCount = 0;
    globalConsoles.forEach((c, index) => {
        if (c && c.activeTimer && !c.activeTimer.isPaused) {
            window.pauseDeviceTimer(index);
            pausedCount++;
        }
    });
    if (db) update(ref(db, 'settings'), { emergencyMode: true, emergencyStartTime: Date.now() });
    if (pausedCount > 0) {
        alert(`تم إيقاف العدادات مؤقتاً لعدد ${pausedCount} جهاز بنجاح!`);
    } else {
        alert("لا توجد أجهزة نشطة حالياً ليتم إيقافها.");
    }
};

window.emergencyResumeAll = function() {
    let resumedCount = 0;
    globalConsoles.forEach((c, index) => {
        if (c && c.activeTimer && c.activeTimer.isPaused) {
            window.resumeDeviceTimer(index, true);
            resumedCount++;
        }
    });
    
    if (db) {
        if (globalEmergencyStartTime > 0) {
            let totalShiftedCount = 0;
            
            // Shift overlapping bookings per device
            globalConsoles.forEach(c => {
                if (!c) return;
                let lastOccupied = Date.now();
                if (c.activeTimer && !c.activeTimer.isOpen && c.activeTimer.endTime) {
                    lastOccupied = c.activeTimer.endTime;
                }
                totalShiftedCount += window.shiftOverlappingBookings(c.name, lastOccupied);
            });
            
            // Shift generic bookings ('any') if they overlap with the current time
            const currentWorkingDay = getWorkingDayBaseDateFor(Date.now()).getTime();
            globalBookings.forEach(b => {
                if (b.status === 'approved' && b.specificDevice === 'any') {
                    if (getWorkingDayBaseDateFor(b.startTime).getTime() === currentWorkingDay) {
                        if (b.startTime < Date.now()) {
                            const shiftMs = Date.now() - b.startTime;
                            update(ref(db, `bookings/${b.id}`), { 
                                startTime: Date.now(), 
                                delayedByMs: (b.delayedByMs || 0) + shiftMs 
                            });
                            totalShiftedCount++;
                        }
                    }
                }
            });
            console.log(`Shifted ${totalShiftedCount} future bookings due to emergency resume.`);
        }
        update(ref(db, 'settings'), { emergencyMode: false, emergencyStartTime: 0 });
    }

    if (resumedCount > 0) {
        alert(`تم استئناف العدادات لعدد ${resumedCount} جهاز بنجاح!`);
    } else {
        alert("لا توجد أجهزة موقوفة حالياً ليتم استئنافها.");
    }
};

// ✅ فتح / إغلاق قبول الحجوزات
window.toggleBookingsAcceptance = function() {
    if (!db) return;
    const newState = !globalBookingsEnabled;
    const msg = newState
        ? 'هل تريد فتح الحجوزات للعملاء الآن؟'
        : 'هل تريد إيقاف استقبال الحجوزات مؤقتاً؟';
    if (!confirm(msg)) return;
    update(ref(db, 'settings'), { bookingsEnabled: newState })
        .then(() => {
            alert(newState ? '✅ تم فتح الحجوزات بنجاح!' : '🔒 تم إيقاف الحجوزات مؤقتاً.');
        })
        .catch(err => alert('خطأ: ' + err.message));
};

// تحديث مظهر الزرار في لوحة الإدارة
window.updateBookingToggleButton = function(enabled) {
    const btn   = document.getElementById('toggle-bookings-btn');
    const label = document.getElementById('toggle-bookings-label');
    if (!btn || !label) return;
    if (enabled) {
        label.textContent = '🔒 إيقاف قبول الحجوزات';
        btn.style.background = '#4a148c';
        btn.style.border = '1px solid #ce93d8';
    } else {
        label.textContent = '✅ فتح قبول الحجوزات';
        btn.style.background = '#1b5e20';
        btn.style.border = '1px solid #00e676';
    }
};

function checkBookingConflict(booking) {
    const start = booking.actualStartTime || booking.startTime;
    const bDurationNum = booking.duration === 'open' ? 24 : parseFloat(booking.duration) || 1;
    const end = start + bDurationNum * 3600 * 1000;
    
    const dbRoomName = booking.roomType;
    const matchingDevices = globalConsoles.filter(c => c && c.type === booking.deviceType && c.location === dbRoomName);
    const totalDevicesCount = matchingDevices.length;
    
    if (totalDevicesCount === 0) return `لا توجد أجهزة مطابقة للمواصفات المطلوبة.`;

    let activeTimerConflicts = 0;
    let specificDeviceHasActiveConflict = false;
    let activeConflictName = null;

    matchingDevices.forEach(c => {
        if (c.activeTimer) {
            let devStart = c.activeTimer.startTime || Date.now();
            let devEnd;
            if (c.activeTimer.isOpen) {
                devEnd = devStart + 24 * 3600 * 1000;
            } else if (c.activeTimer.isPaused) {
                devEnd = Date.now() + (c.activeTimer.pausedTimeLeftMs || 0);
            } else {
                devEnd = c.activeTimer.endTime;
            }
            if (start < devEnd && end > devStart) {
                activeTimerConflicts++;
                if (booking.specificDevice && booking.specificDevice !== 'any' && c.name === booking.specificDevice) {
                    specificDeviceHasActiveConflict = true;
                    activeConflictName = c.name;
                }
            }
        }
    });

    if (specificDeviceHasActiveConflict) {
        return `تنبيه: الجهاز (${activeConflictName}) مشغول حالياً في هذا الوقت.`;
    }

    // Filter other bookings that are approved
    const overlappingBookings = globalBookings.filter(b => {
        if (b.id === booking.id) return false;
        if (b.status !== 'approved') return false;
        
        const bStart = b.actualStartTime || b.startTime;
        const bOverlapDurationNum = b.duration === 'open' ? 24 : parseFloat(b.duration) || 1;
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

    // 2. Check total capacity
    const conflictingOverlapping = overlappingBookings.filter(b => {
        if (b.deviceType !== booking.deviceType) return false;
        
        if (b.specificDevice && b.specificDevice !== 'any') {
            const dev = globalConsoles.find(c => c && c.name === b.specificDevice);
            return dev && dev.location === dbRoomName;
        }
        
        return b.roomType === booking.roomType;
    });

    if ((activeTimerConflicts + conflictingOverlapping.length) >= totalDevicesCount) {
        const roomNameAr = booking.roomType;
        return `تنبيه: جميع أجهزة ${booking.deviceType} في ${roomNameAr} محجوزة ومشغولة بالفعل في هذا الوقت.`;
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
    
    update(ref(db, `bookings/${id}`), { status: 'approved' }).then(() => {
        if (booking.phone && booking.phone !== 'غير مسجل') {
            const dateObj = new Date(booking.startTime);
            const timeStr = dateObj.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const deviceStr = booking.specificDevice && booking.specificDevice !== 'any' ? booking.specificDevice : 'أي جهاز متاح';
            const durationStr = booking.duration === 'open' ? 'مفتوح' : `${booking.duration} ساعة`;
            
            const message = `مرحباً ${booking.name}،\n\nتم تأكيد حجزك بنجاح في R2 PlayStation:\n🎮 الجهاز: ${deviceStr} (${booking.deviceType})\n📍 المكان: ${booking.roomType}\n⏰ وقت البدء: اليوم - ${timeStr}\n⏱️ المدة: ${durationStr}\n\nنتمنى لك وقتاً ممتعاً! ❤️`;
            
            let formattedPhone = booking.phone.trim();
            if (formattedPhone.startsWith('0')) {
                formattedPhone = '20' + formattedPhone.substring(1);
            }
            
            const waUrl = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`;
            window.open(waUrl, '_blank');
        }
    });
};

window.cancelBooking = function(id) {
    const b = globalBookings.find(x => x.id === id);
    if (!b) return;
    
    const keepDeposit = confirm("هل تريد الاحتفاظ بمبلغ الحجز (حجز غير مسترد) وتغيير حالته؟ \n(اختر 'موافق/OK' للاحتفاظ بالمبلغ، أو 'إلغاء/Cancel' لحذفه بالكامل)");
    
    if (keepDeposit) {
        update(ref(db, `bookings/${id}`), { status: 'cancelled_with_fee' });
        globalConsoles.forEach((c, idx) => {
            if (c.activeTimer && c.activeTimer.bookingId === id) {
                updateConsoleField(idx, { status: 'available', activeTimer: null });
            }
        });
    } else {
        if (confirm("سيتم حذف الحجز نهائياً. تأكيد؟")) {
            set(ref(db, `bookings/${id}`), null);
            globalConsoles.forEach((c, idx) => {
                if (c.activeTimer && c.activeTimer.bookingId === id) {
                    updateConsoleField(idx, { status: 'available', activeTimer: null });
                }
            });
        }
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
    
    // العداد يشتغل للمدة الكاملة للحجز من وقت البدء المجدول
    const scheduledStart = booking.startTime;
    const isOpen = booking.duration === 'open';
    let endTime = null;
    if (!isOpen) {
        endTime = scheduledStart + (parseFloat(booking.duration) * 3600 * 1000);
    }
    
    updateConsoleField(idx, {
        status: 'busy',
        activeTimer: { endTime, bookingId: id, isGracePeriod: false, isOpen, startTime: scheduledStart }
    });
    update(ref(db, `bookings/${id}`), {
        status: 'active_in_store',
        actualStartTime: scheduledStart
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
        // نهاية الحجز الكامل من وقت الحجز المجدول لتجنب الإزاحة
        const bStart = booking.startTime;
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
        if (el.getAttribute('data-ispaused') === 'true') return;
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

    // Auto-activate approved bookings when their time arrives
    if (window._isAdmin) {
        globalBookings.forEach(b => {
            if (b.status === 'approved') {
                if (now >= b.startTime) {
                    // حان وقت الحجز → تفعيل تلقائي فوري بالمدة الكاملة
                    window.activateBooking(b.id, b.startTime);
                }
            }
        });
    }
}, 1000);

// Payment instructions (تمت إزالة instapay بالكامل)
function updatePaymentInstructions() {
    const methodEl = document.getElementById('payment-method');
    const instructionsEl = document.getElementById('payment-instructions');
    const receiptGroup = document.getElementById('receipt-upload-group');
    const receiptInput = document.getElementById('payment-receipt');
    const specificDeviceEl = document.getElementById('specific-device');
    const durationEl = document.getElementById('duration');
    if (!methodEl || !instructionsEl) return;
    const method = methodEl.value;

    // استنتاج نوع الجهاز من القائمة المنسدلة
    let deviceType = 'PS4';
    if (specificDeviceEl && specificDeviceEl.value && specificDeviceEl.value !== 'any') {
        const foundDev = globalConsoles.find(c => c && c.name === specificDeviceEl.value);
        if (foundDev) deviceType = foundDev.type;
    }

    const durationRaw = durationEl ? durationEl.value : '1';
    // وقت مفتوح يُحسب كساعتين
    const duration = durationRaw === 'open' ? 2 : parseFloat(durationRaw) || 1;
    const playModeEl = document.getElementById('play-mode');
    const playMode = playModeEl ? playModeEl.value : 'single';
    let pricePerHour = PRICES[deviceType] || 40;
    if (playMode === 'multi') pricePerHour = 50;
    const fullAmount = pricePerHour * duration;

    // إظهار/إخفاء خانة رفع الإيصال (فودافون كاش فقط)
    if (receiptGroup) {
        receiptGroup.style.display = method === 'vodafone' ? 'block' : 'none';
        if (receiptInput) receiptInput.required = method === 'vodafone';
    }

    if (method === 'vodafone') {
        instructionsEl.style.display = 'block';
        instructionsEl.innerHTML = `
            <div style="background:rgba(0,210,255,0.08);border:1px solid var(--accent-neon);border-radius:10px;padding:15px;">
                <p style="color:var(--accent-neon);margin:0 0 8px 0;font-weight:bold;"><i class="fas fa-mobile-alt"></i> فودافون كاش</p>
                <p style="margin:0;">حول <strong style="color:#fff;font-size:1.1rem">${fullAmount} جنيه</strong> (قيمة الحجز كاملاً) إلى:<br>
                <strong style="font-size:1.3rem;color:var(--accent-neon)">${PAYMENT_NUMBERS.vodafone}</strong><br>
                <small style="color:var(--text-muted)">ثم ارفع صورة التحويل واضغط تأكيد الحجز.</small></p>
            </div>`;
    } else if (method === 'instore') {
        instructionsEl.style.display = 'block';
        instructionsEl.innerHTML = `
            <div style="background:rgba(0,230,118,0.08);border:1px solid var(--success);border-radius:10px;padding:15px;">
                <p style="color:var(--success);margin:0 0 8px 0;font-weight:bold;"><i class="fas fa-store"></i> الدفع في المحل</p>
                <p style="margin:0;">قم بزيارتنا في المحل لدفع <strong style="color:#fff;font-size:1.1rem">${fullAmount} جنيه</strong> (قيمة الحجز كاملاً) لتأكيد الحجز.<br>
                <small style="color:var(--text-muted)">سيتم تأكيد حجزك فور استلام المبلغ.</small></p>
            </div>`;
    } else {
        instructionsEl.style.display = 'none';
    }
}
window.updatePaymentInstructionsGlobal = updatePaymentInstructions;

// تحويل الصورة إلى base64 مضغوطة وتخزينها مباشرة في قاعدة البيانات (بدون Firebase Storage)
function imageToBase64(file, maxWidth = 400, maxHeight = 400, quality = 0.65) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                let { width, height } = img;

                // تصغير الصورة لتقليل الحجم (ماكس 400×400 بجودة 65%)
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (!dataUrl || dataUrl === 'data:,') {
                    reject(new Error('فشل تحويل الصورة'));
                    return;
                }
                resolve(dataUrl);
            };
            img.onerror = () => reject(new Error('فشل تحميل ملف الصورة. تأكد أن الملف صورة صحيحة.'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('فشل قراءة الملف.'));
        reader.readAsDataURL(file);
    });
}

// Image compression using Canvas API (محتفظ للاستخدام الداخلي إن لزم)
function compressImage(file, maxWidth = 800, maxHeight = 800, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                let { width, height } = img;

                // Scale down if needed
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('فشل ضغط الصورة'));
                }, 'image/jpeg', quality);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function cleanupOldBookings() {
    if (!window._isAdmin || !globalBookings || globalBookings.length === 0) return;
    
    const currentBase = getWorkingDayBaseDate();
    const dayOfWeek = currentBase.getDay();
    const sundayBase = new Date(currentBase.getTime());
    sundayBase.setDate(currentBase.getDate() - dayOfWeek);
    const keepThreshold = sundayBase.getTime();
    
    globalBookings.forEach(b => {
        // Delete corrupt bookings directly
        if (!b.startTime || !b.deviceType) {
            set(ref(db, `bookings/${b.id}`), null).catch(err => {
                console.warn("Failed to delete corrupt booking:", err);
            });
            return;
        }
        
        const bookingTime = b.startTime || b.createdAt;
        if (bookingTime) {
            const bBaseTime = getWorkingDayBaseDateFor(bookingTime).getTime();
            if (bBaseTime < keepThreshold) {
                set(ref(db, `bookings/${b.id}`), null).catch(err => {
                    console.warn("Failed to auto-delete old booking:", err);
                });
            }
        }
    });
}

// ✅ تهيئة كاملة — تُستدعى من لوحة الإدارة لبداية شهر جديد
window.fullResetForNewMonth = function() {
    // تأكيد مزدوج للحماية
    const first = confirm(
        '⚠️ تحذير: سيتم حذف جميع الحجوزات والإحصائيات القديمة نهائياً.\n\n' +
        'هذا الإجراء لا يمكن التراجع عنه!\n\n' +
        'هل أنت متأكد تماماً؟'
    );
    if (!first) return;

    const second = confirm(
        '✋ تأكيد أخير:\n\n' +
        'سيتم حذف:\n' +
        '• كل الحجوزات (bookings)\n' +
        '• بيانات الإحصائيات اليومية (daily_totals)\n' +
        '• الأرشيف الأسبوعي (weekly_snapshots)\n' +
        '• إعادة ضبط حالة الأجهزة\n\n' +
        'اضغط موافق للتنفيذ.'
    );
    if (!second) return;

    if (!db) { alert('خطأ: لم يتم الاتصال بقاعدة البيانات.'); return; }

    let done = 0;
    const total = 4;
    const finish = () => {
        done++;
        if (done === total) {
            alert('✅ تمت التهيئة الكاملة بنجاح!\n\nالموقع جاهز لاستقبال حجوزات شهر يوليو 🎉');
        }
    };

    // 1) حذف كل الحجوزات
    set(ref(db, 'bookings'), null)
        .then(finish)
        .catch(err => { console.error('Failed to clear bookings:', err); finish(); });

    // 2) حذف الإحصائيات اليومية
    set(ref(db, 'daily_totals'), null)
        .then(finish)
        .catch(err => { console.error('Failed to clear daily_totals:', err); finish(); });

    // 3) حذف الأرشيف الأسبوعي التجريبي
    set(ref(db, 'weekly_snapshots'), null)
        .then(finish)
        .catch(err => { console.error('Failed to clear weekly_snapshots:', err); finish(); });

    // 4) إعادة ضبط حالة الأجهزة (إزالة العدادات)
    const resetPromises = globalConsoles.map((c, index) => {
        if (!c) return Promise.resolve();
        return set(ref(db, 'consoles/' + index), {
            ...c,
            status: 'available',
            activeTimer: null
        }).catch(err => console.warn(`Failed to reset console ${index}:`, err));
    });
    Promise.all(resetPromises).then(finish).catch(finish);
};


// Initialize everything once Firebase is ready
window.initApp = function(firebaseServices) {
    db = firebaseServices.db;
    auth = firebaseServices.auth;
    storage = firebaseServices.storage;
    ref = firebaseServices.ref;
    onValue = firebaseServices.onValue;
    set = firebaseServices.set;
    get = firebaseServices.get;
    push = firebaseServices.push;
    update = firebaseServices.update;
    sRef = firebaseServices.sRef;
    uploadBytes = firebaseServices.uploadBytes;
    getDownloadURL = firebaseServices.getDownloadURL;
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

    // ✅ تأكد من وجود إعداد الحجوزات أو افتحه تلقائياً مع بداية شهر يوليو 2026
    get(ref(db, 'settings/bookingsEnabled')).then(snap => {
        const isJulyOrLater = Date.now() >= new Date('2026-07-01T00:00:00').getTime();
        if (isJulyOrLater) {
            // إذا وصلنا لشهر 7 أو بعده، افتح الحجوزات تلقائياً
            update(ref(db, 'settings'), { bookingsEnabled: true });
        } else if (!snap.exists()) {
            // قبل شهر 7 وإذا لم يكن الإعداد موجوداً، اجعله مغلقاً افتراضياً
            update(ref(db, 'settings'), { bookingsEnabled: false });
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
            cleanupOldBookings();
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
            globalBookings = Object.keys(data)
                .map(k => ({ id: k, ...data[k] }))
                .filter(b => b.startTime && b.deviceType);

            // Save daily totals for all days represented in active bookings
            saveDailyTotalsFromBookings(globalBookings);

            // Auto-cleanup bookings if admin
            if (window._isAdmin) {
                cleanupOldBookings();
            }
        } else {
            globalBookings = [];
        }
        renderConsoles();
        if (window._isAdmin) {
            renderAdminBookings();
            renderAdminConsoles();
        }
        updateTimeSlotsDropdown();
    });

    // Realtime daily totals
    const dailyTotalsRef = ref(db, 'daily_totals');
    onValue(dailyTotalsRef, snap => {
        if (snap.exists()) {
            globalDailyTotals = snap.val();
        } else {
            globalDailyTotals = {};
        }
        // ✅ عند كل تحديث: تحقق إن كنا في أسبوع جديد وأرشف الأسبوع الماضي
        if (window._isAdmin) {
            maybeArchiveLastWeekSnapshot();
            renderAdminBookings();
        }
    });

    // Realtime weekly snapshots (أرشيف أسبوعي محمي لا يُحذف)
    const weeklySnapshotsRef = ref(db, 'weekly_snapshots');
    onValue(weeklySnapshotsRef, snap => {
        globalWeeklySnapshots = snap.exists() ? snap.val() : {};
        if (window._isAdmin) {
            renderAdminBookings();
        }
    });

    // Realtime settings
    const settingsRef = ref(db, 'settings');
    onValue(settingsRef, snap => {
        const val = snap.exists() ? snap.val() : {};
        globalEmergencyMode      = !!val.emergencyMode;
        globalEmergencyStartTime = val.emergencyStartTime || 0;
        globalBookingsEnabled    = val.bookingsEnabled !== false; // افتراضي: مفتوح

        // عرض/إخفاء overlay انقطاع الكهرباء
        const overlay = document.getElementById('power-outage-overlay');
        if (overlay) {
            overlay.classList.toggle('active', globalEmergencyMode);
        }

        // تحديث مظهر زرار التحكم في الحجوزات (في لوحة الإدارة)
        window.updateBookingToggleButton(globalBookingsEnabled);

        // عرض/إخفاء banner إغلاق الحجوزات
        let bookingBanner = document.getElementById('booking-closed-banner');
        const bookingSection = document.getElementById('booking');
        if (!globalBookingsEnabled && bookingSection) {
            if (!bookingBanner) {
                bookingBanner = document.createElement('div');
                bookingBanner.id = 'booking-closed-banner';
                bookingBanner.style.cssText = 'background:rgba(255,196,0,0.08);border:1px solid rgba(255,196,0,0.4);border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:20px;';
                bookingBanner.innerHTML = `
                    <i class="fas fa-calendar-times" style="font-size:2rem;color:#ffc400;margin-bottom:10px;display:block;"></i>
                    <strong style="font-size:1.1rem;color:#ffc400;">الحجز متوقف مؤقتاً</strong>
                    <p style="color:#a0a0a0;margin:8px 0 0;font-size:0.95rem;">
                        سيتم فتح الحجوزات بداية من <strong style="color:#fff;">1 يوليو 2026</strong> إن شاء الله.<br>
                        نعتذر عن الإزعاج ونرحب بكم قريباً 🙏
                    </p>`;
                bookingSection.insertBefore(bookingBanner, bookingSection.firstChild);
            }
            // إخفاء فورم الحجز
            const form = document.getElementById('whatsapp-booking-form');
            if (form) form.style.display = 'none';
        } else {
            if (bookingBanner) bookingBanner.remove();
            const form = document.getElementById('whatsapp-booking-form');
            if (form) form.style.display = '';
        }
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
        if (specificDeviceEl) specificDeviceEl.addEventListener('change', () => { updatePaymentInstructions(); updateTimeSlotsDropdown(); });
        const playModeEl2 = document.getElementById('play-mode');
        if (playModeEl2) playModeEl2.addEventListener('change', updatePaymentInstructions);

        // Initial populating of time slots dropdown
        updateTimeSlotsDropdown();

        bookingForm.addEventListener('submit', async e => {
            e.preventDefault();

            if (!globalBookingsEnabled) {
                alert('عفواً، الحجز متوقف مؤقتاً. سيتم فتحه بداية من 1 يوليو 2026 إن شاء الله.');
                return;
            }

            if (globalEmergencyMode) {
                alert("عفواً، لا يمكن الحجز حالياً بسبب انقطاع التيار الكهربائي (حالة الطوارئ).");
                return;
            }

            const submitBtn = bookingForm.querySelector('button[type="submit"]');
            const fb = document.getElementById('booking-feedback');

            const name = document.getElementById('name').value;
            const phone = document.getElementById('phone').value;
            const specificDeviceEl2 = document.getElementById('specific-device');
            const specificDevice = specificDeviceEl2 ? specificDeviceEl2.value : 'any';
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
            const playModeEl3 = document.getElementById('play-mode');
            const playMode = playModeEl3 ? playModeEl3.value : 'single';

            // Full booking amount
            const durationNum = duration === 'open' ? 2 : duration;
            let pricePerHour = PRICES[deviceType] || 40;
            if (playMode === 'multi') pricePerHour = 50;
            const fullAmount = pricePerHour * durationNum;

            // Validate photo
            const userPhotoInput = document.getElementById('user-photo');
            const userPhotoFile = userPhotoInput ? userPhotoInput.files[0] : null;
            if (!userPhotoFile) {
                alert('الرجاء رفع صورة شخصية للتعريف');
                return;
            }

            // Validate receipt if Vodafone Cash
            const receiptInput = document.getElementById('payment-receipt');
            const receiptFile = receiptInput ? receiptInput.files[0] : null;
            if (paymentMethod === 'vodafone' && !receiptFile) {
                alert('الرجاء رفع صورة تحويل فودافون كاش');
                return;
            }

            if (duration !== 'open') {
                const startD = new Date(startTime);
                const closing = new Date(startD.getTime());
                if (startD.getHours() >= 3) {
                    closing.setDate(closing.getDate() + 1);
                }
                closing.setHours(3, 0, 0, 0);
                const storeClosingTime = closing.getTime();
                
                if (startTime + duration * 3600 * 1000 > storeClosingTime) {
                    alert('لا يمكنك الحجز لعدد ساعات يتجاوز موعد إغلاق المحل (3:00 صباحاً).');
                    return;
                }
            }

            if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'جارٍ معالجة الصورة...'; }
            if (fb) {
                fb.style.display = 'block';
                fb.style.color = 'var(--accent-neon)';
                fb.innerText = 'جارٍ معالجة الصورة، يرجى الانتظار...';
            }

            try {
                // تحويل الصورة الشخصية إلى base64
                if (fb) fb.innerText = 'جارٍ ضغط الصورة الشخصية...';
                let userPhotoUrl;
                try {
                    userPhotoUrl = await imageToBase64(userPhotoFile, 400, 400, 0.65);
                } catch (err) {
                    throw new Error('فشل تحويل الصورة الشخصية: ' + err.message);
                }

                // تحويل صورة التحويل إلى base64 (إن وجدت)
                let receiptUrl = null;
                if (paymentMethod === 'vodafone' && receiptFile) {
                    if (fb) fb.innerText = 'جارٍ ضغط صورة التحويل...';
                    try {
                        receiptUrl = await imageToBase64(receiptFile, 600, 600, 0.7);
                    } catch (err) {
                        throw new Error('فشل تحويل صورة التحويل: ' + err.message);
                    }
                }

                if (fb) fb.innerText = 'جارٍ حفظ بيانات الحجز...';

                // حفظ الحجز في قاعدة البيانات (الصور مخزنة كـ base64 داخل الحجز)
                await push(bookingsRef, {
                    name, phone, deviceType, specificDevice, roomType, playMode,
                    startTime, duration, paymentMethod,
                    depositAmount: fullAmount,
                    status: 'pending_payment',
                    createdAt: Date.now(),
                    userPhotoUrl,
                    ...(receiptUrl ? { receiptUrl } : {})
                });

                if (fb) {
                    fb.style.display = 'block';
                    fb.style.color = 'var(--success)';
                    fb.innerHTML = '✅ تم تسجيل طلب الحجز بنجاح! يتم تحويلك للواتساب...';
                }

                const msg = `مرحباً، قمت بحجز جديد وأريد تأكيده:\nالاسم: ${name}\nرقم الهاتف: ${phone}\nالمكان: ${roomType}\nالمدة: ${duration === 'open' ? 'مفتوح' : duration + ' ساعة'}\nوقت الحجز: ${new Date(startTime).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}\nطريقة الدفع: ${paymentMethod === 'vodafone' ? 'فودافون كاش' : 'في المحل'}\nالمبلغ: ${fullAmount} جنيه`;
                const waUrl = `https://wa.me/201023402968?text=${encodeURIComponent(msg)}`;
                window.open(waUrl, '_blank');

                bookingForm.reset();
                updateTimeSlotsDropdown();
                const instrEl = document.getElementById('payment-instructions');
                if (instrEl) instrEl.style.display = 'none';
                const receiptGroupEl = document.getElementById('receipt-upload-group');
                if (receiptGroupEl) receiptGroupEl.style.display = 'none';

            } catch (err) {
                console.error('Booking error:', err);
                if (fb) {
                    fb.style.display = 'block';
                    fb.style.color = 'var(--danger)';
                    fb.innerText = '❌ ' + (err.message || 'حدث خطأ غير متوقع. يرجى المحاولة مجدداً.');
                }
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'تأكيد الحجز المسبق'; }
            }
        });
    }
};
