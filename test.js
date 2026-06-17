const base = new Date();
if (base.getHours() < 3) base.setDate(base.getDate() - 1);
base.setHours(0, 0, 0, 0);

const slotTimesSet = new Set();
for (let H = 12; H <= 26; H++) {
    const slotDate = new Date(base.getTime());
    let hour = H;
    let minute = 0;
    if (hour >= 24) {
        slotDate.setDate(slotDate.getDate() + 1);
        hour -= 24;
    }
    slotDate.setHours(hour, minute, 0, 0);
    slotTimesSet.add(slotDate.getTime());
}

const now = Date.now();
const sortedSlotTimes = Array.from(slotTimesSet).sort((a, b) => a - b);
const results = [];
sortedSlotTimes.forEach(slotTime => {
    if (slotTime < now) return;
    results.push(new Date(slotTime).toLocaleString());
});

console.log("Current time:", new Date(now).toLocaleString());
console.log("Available slots:", results);
