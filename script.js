// Mock data for consoles
const initialConsoles = [
    { id: 1, name: "جهاز 1", type: "PS5", location: "الصالة الرئيسية", status: "available" },
    { id: 2, name: "جهاز 2", type: "PS5", location: "الصالة الرئيسية", status: "busy" },
    { id: 3, name: "جهاز 3", type: "PS4", location: "الصالة الرئيسية", status: "available" },
    { id: 4, name: "VIP 1", type: "PS5", location: "غرفة VIP", status: "available" },
    { id: 5, name: "VIP 2", type: "PS5", location: "غرفة VIP", status: "busy" },
    { id: 6, name: "جهاز 4", type: "PS4", location: "الصالة الرئيسية", status: "available" },
];

// Load from local storage or use default
function getConsoles() {
    const stored = localStorage.getItem('roma_consoles');
    if (stored) {
        return JSON.parse(stored);
    }
    localStorage.setItem('roma_consoles', JSON.stringify(initialConsoles));
    return initialConsoles;
}

// Render the consoles on the main page
function renderConsoles() {
    const container = document.getElementById('consoles-container');
    if (!container) return; // Not on main page

    const consoles = getConsoles();
    container.innerHTML = '';

    consoles.forEach(c => {
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

// Handle WhatsApp Booking form
const bookingForm = document.getElementById('whatsapp-booking-form');
if (bookingForm) {
    bookingForm.addEventListener('submit', function(e) {
        e.dispatchEvent(new Event('submit', { cancelable: true })); // standard event behavior
        e.preventDefault();

        const name = document.getElementById('name').value;
        const deviceType = document.getElementById('device-type').value;
        const roomType = document.getElementById('room-type').value;
        const time = document.getElementById('time').value;

        // Replace with actual WhatsApp Number (e.g. 201012345678 for Egypt)
        const whatsappNumber = "201000000000"; 
        
        const message = `مرحباً روما بلاي ستيشن،%0Aأرغب في حجز جهاز:%0Aالاسم: ${name}%0Aالجهاز: ${deviceType}%0Aالمكان: ${roomType}%0Aالوقت: ${time}`;
        const url = `https://wa.me/${whatsappNumber}?text=${message}`;

        window.open(url, '_blank');
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    renderConsoles();
});
