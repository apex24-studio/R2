const now = new Date("2026-06-18T02:25:01+03:00").getTime();

// getWorkingDayBaseDate
const d = new Date(now);
const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
if (d.getHours() < 3) base.setDate(base.getDate() - 1);
base.setHours(0,0,0,0);

// updateTimeSlotsDropdown logic to get bStart
const baseTomorrow = new Date(base.getTime());
baseTomorrow.setDate(baseTomorrow.getDate() + 1);
const bSlotDate = new Date(baseTomorrow.getTime());
bSlotDate.setHours(12, 0, 0, 0);
const bStart = bSlotDate.getTime();
const bEnd = bStart + 2 * 3600 * 1000;

// getDeviceHourlyStatus logic
const stripBase = new Date(base.getTime());
if (new Date(now).getHours() === 2) stripBase.setDate(stripBase.getDate() + 1);

const slotDate = new Date(stripBase.getTime());
slotDate.setHours(12, 0, 0, 0);
const slotStart = slotDate.getTime();
const slotEnd = slotStart + 3600 * 1000;

console.log("bStart:", new Date(bStart).toLocaleString());
console.log("slotStart:", new Date(slotStart).toLocaleString());
console.log("Match:", slotStart < bEnd && slotEnd > bStart);
